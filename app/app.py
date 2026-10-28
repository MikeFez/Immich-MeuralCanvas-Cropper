import copy
import os
import re
import logging
import io
import threading
import time
import requests
from datetime import datetime, timezone
from functools import wraps
from flask import Flask, render_template, request, jsonify, send_from_directory, send_file, abort
from werkzeug.exceptions import HTTPException

# Import from our modules
import config
from config import ORIENTATIONS, SIZES
from utils.immich_handler import ImmichHandler, find_processed_asset
from utils.file_handler import (
    get_image_list,
    get_image,
    save_crop,
    delete_crops,
    mark_uploaded,
    checkpoint_upload,
    upload_records,
    forget_uploads,
    forget_missing_uploads,
    needs_upload,
    migrate_legacy_state,
    read_all_crop_metadata,
    saved_crop,
    get_filename_from_asset_id,
    image_lock,
    remove_cached_image,
    source_version,
)
from utils.image_processor import render_image, write_image_atomic, validate_crop, upright_size
from utils.meural_handler import MeuralHandler
from utils.jobs import JobRunner
from utils.render_cache import cached_render

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)

# Initialize temporary directories
logging.info("Initializing temporary directories")
config.init_directories()
migrate_legacy_state()

# Initialize Flask app with static folder
app = Flask(__name__, static_url_path="/static", static_folder="static")

# Configure clients without making startup depend on network availability.
# Without a config.yaml the app still starts, and the UI opens Settings.
if config.is_configured():
    logging.info(f"Using Immich at {config.settings['immich']['url']}")
else:
    logging.warning(f"Immich is not configured; set it up in Settings (saved to {config.CONFIG_FILE})")
immich_handler = ImmichHandler(config.settings["immich"])
meural_handler = MeuralHandler(config.settings["meural"]["devices"])

jobs = JobRunner(os.path.join(config.CONFIG_DIR, 'jobs.json'))
ASSET_ID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


@app.errorhandler(HTTPException)
def http_error(e):
    return jsonify({"success": False, "error": e.description}), e.code


@app.errorhandler(Exception)
def unexpected_error(e):
    logging.exception("Request failed")
    return jsonify({"success": False, "error": str(e)}), 500


def asset_route(lock=False):
    """Resolve the asset ID from the URL or JSON body; optionally serialize per image.

    Reads (images, previews) stay unlocked so a slow upload never blocks them.
    """
    def decorate(handler):
        @wraps(handler)
        def wrapped(*args, **kwargs):
            asset_id = kwargs.pop("identifier", None) or (request.get_json(silent=True) or {}).get("identifier")
            if not isinstance(asset_id, str) or not ASSET_ID.fullmatch(asset_id):
                abort(400, "A valid image asset ID is required")
            if not lock:
                return handler(asset_id, *args, **kwargs)
            with image_lock(asset_id):
                return handler(asset_id, *args, **kwargs)
        return wrapped
    return decorate


def require_orientation(orientation):
    if orientation not in ORIENTATIONS:
        abort(400, "Invalid orientation")
    return orientation


def source_path(asset_id):
    filename = get_filename_from_asset_id(asset_id)
    if not filename:
        abort(404, "Image not found")
    return os.path.join(config.INPUT_FOLDER, filename)


def image_response(asset_id, **extra):
    """The updated image record, so the UI can refresh without refetching the list."""
    return jsonify({"success": True, "image": get_image(asset_id), **extra})


def run_sync(progress, asset_ids=None):
    options = {'asset_ids': asset_ids} if asset_ids is not None else {}
    result = {"images": len(immich_handler.sync_input_images(config.INPUT_FOLDER, progress=progress, **options))}
    if not progress.cancelled():
        result["reuploads"] = reconcile_uploads()
    return result


def reconcile_uploads():
    """Make crops whose Immich copy left the destination album pending again.

    Returns how many images changed, or None when the album couldn't be read
    (the sync itself still succeeded).
    """
    listed_at = datetime.now(timezone.utc).isoformat()
    try:
        album_assets = output_album_assets()
    except Exception as e:
        logging.warning("Could not check the destination album for removed uploads: %s", e)
        return None
    present = {o: {asset["id"] for asset in assets} for o, assets in album_assets.items()}
    changed = forget_missing_uploads(
        present, lambda orientation, filename: find_processed_asset(album_assets[orientation], filename), listed_at)
    if changed:
        logging.info("%d image(s) have crops missing from the destination album; they need uploading again", len(changed))
    return len(changed)


def retire_uploads(asset_id, orientations):
    """Trash the Immich copies of these crops and forget them.

    Only copies still in the destination album are trashed, so a photo moved or
    already deleted in Immich is never touched.
    """
    entry = read_all_crop_metadata().get(asset_id, {})
    records = {o: upload_records(entry, o) for o in orientations}
    if not any(records.values()):
        return
    try:
        album_assets = output_album_assets()
        for orientation, found in records.items():
            if not found:
                continue
            assets = album_assets[orientation]
            present = {asset["id"] for asset in assets}
            remote_ids = {record.get("asset_id") for record in found}
            if None in remote_ids:
                remote_ids.add(find_processed_asset(assets, f"{asset_id}_{orientation}.jpg"))
            for remote_id in sorted(remote_ids & present):
                immich_handler.trash_asset(remote_id)
            forget_uploads(asset_id, orientation)
    except (requests.RequestException, RuntimeError, ValueError) as e:
        abort(502, f"Could not remove the uploaded copy from Immich: {e}")


def job_scope():
    return {key: config.settings['immich'][key] for key in
            ('url', 'input_album_id', 'output_album_id',
             'output_album_portrait_id', 'output_album_landscape_id')}


def output_album_assets():
    """Each orientation's destination-album assets, fetching a shared album only once."""
    by_album, by_orientation = {}, {}
    for orientation in ORIENTATIONS:
        album = immich_handler.output_album(orientation)
        if album not in by_album:
            by_album[album] = immich_handler.get_album_assets(album)
        by_orientation[orientation] = by_album[album]
    return by_orientation


def start_job(kind, work):
    return jobs.start(kind, work, scope=job_scope())


def initial_sync():
    """Warm the input cache in the background; a failure leaves the web app available."""
    if config.is_configured():
        return start_job("sync", run_sync)
    return None, False


def sync_due(now=None):
    """True when sync.interval_minutes have passed since the last sync started (0 = never)."""
    minutes = config.settings["sync"]["interval_minutes"]
    last = jobs.last_started("sync")
    now = time.monotonic() if now is None else now
    return bool(minutes) and config.is_configured() and (last is None or now - last >= minutes * 60)


def schedule_syncs(tick=30):
    """Sync the input album on the configured interval, skipping while any job runs."""
    def loop():
        while True:
            time.sleep(tick)
            if sync_due() and not jobs.running():
                start_job("sync", run_sync)
    threading.Thread(target=loop, name="sync-schedule", daemon=True).start()


def job_response(job, started):
    """202 with the new job, or 409 with the job already running."""
    if started:
        return jsonify({"success": True, "job": job}), 202
    return jsonify({"success": False, "error": f"{job['kind']} is already running", "job": job}), 409


@app.route("/")
def index():
    return render_template("index.html", frame=config.settings["display"]["frame"])


@app.route("/dimensions")
def get_dimensions():
    """Get image dimensions from config"""
    return jsonify({o: {"width": w, "height": h} for o, (w, h) in SIZES.items()})


def settings_view():
    """Settings for the Settings form. The API key itself never leaves the server."""
    view = copy.deepcopy(config.settings)
    view["immich"]["has_api_key"] = bool(view["immich"].pop("api_key"))
    return {"success": True, "settings": view, "configured": config.is_configured()}


@app.route("/settings")
def get_settings():
    return jsonify(settings_view())


@app.route("/settings/albums", methods=["POST"])
def list_immich_albums():
    """List albums for a URL and key under test, before they are saved."""
    data = request.get_json() or {}
    try:
        login = config.resolve_immich_login(data.get("url"), data.get("api_key"))
    except ValueError as e:
        abort(400, str(e))
    try:
        albums = ImmichHandler(login).list_albums()
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else None
        if status in (401, 403):
            abort(400, "Immich rejected the API key (it needs the album.read permission)")
        abort(502, f"Immich returned an error: {e}")
    except (requests.ConnectionError, requests.Timeout):
        abort(502, f"Could not reach Immich at {login['url']}")
    except (requests.RequestException, ValueError) as e:
        abort(502, f"Unexpected response from Immich: {e}")
    return jsonify({"success": True, "albums": albums})


@app.route("/settings", methods=["PUT"])
def update_settings():
    """Validate, save to config.yaml and apply without a restart."""
    running = jobs.running()
    if running:
        abort(409, f"Wait for the running {running['kind']} to finish")
    try:
        new = config.validate_settings(request.get_json(silent=True))
    except ValueError as e:
        abort(400, str(e))
    config.save_settings(new)
    immich_handler.configure(new["immich"])
    meural_handler.configure(new["meural"]["devices"])
    logging.info("Settings saved to %s", config.CONFIG_FILE)
    return jsonify(settings_view())


@app.route("/images")
def get_images():
    return jsonify(get_image_list())


@app.route("/image/<identifier>")
@asset_route()
def get_source_image(asset_id):
    return send_from_directory(config.INPUT_FOLDER, os.path.basename(source_path(asset_id)))


@app.route('/editor-image/<identifier>')
@asset_route()
def get_editor_image(asset_id):
    content, key = cached_render(source_path(asset_id), max_size=(2048, 2048), metadata=False)
    return send_file(io.BytesIO(content), mimetype='image/jpeg', conditional=True, etag=key, max_age=0)


@app.route('/thumbnail/<identifier>')
@asset_route()
def get_thumbnail(asset_id):
    path = source_path(asset_id)
    version = source_version(os.path.basename(path))
    thumbnail = os.path.join(config.THUMBNAIL_FOLDER, f'{asset_id}_{version}.jpg')
    if not os.path.exists(thumbnail):
        write_image_atomic(thumbnail, render_image(path, max_size=(320, 320), metadata=False))
    # Revalidation is cheap, and old ?v= URLs cannot pin new bytes forever.
    return send_file(thumbnail, mimetype='image/jpeg', conditional=True, etag=version, max_age=0)


THUMB_SIZE = (720, 720)  # ?size=thumb: crops in grids (Gallery, Manage), without metadata


@app.route("/output/<orientation>/<identifier>")
@asset_route()
def get_output_image(asset_id, orientation):
    crop = saved_crop(read_all_crop_metadata().get(asset_id, {}), require_orientation(orientation))
    if not crop:
        abort(404, "Saved crop not found")
    if request.args.get("size") == "thumb":
        content, key = cached_render(source_path(asset_id), crop, SIZES[orientation], THUMB_SIZE, metadata=False)
    else:
        content, key = cached_render(source_path(asset_id), crop, SIZES[orientation])
    return send_file(io.BytesIO(content), mimetype='image/jpeg', conditional=True, etag=key, max_age=0)


@app.route("/crop", methods=["POST"])
@asset_route(lock=True)
def handle_crop(asset_id):
    """Validate a selection against the upright source, then persist it."""
    data = request.get_json() or {}
    orientation, crop = require_orientation(data.get("orientation")), data.get("crop")
    path = source_path(asset_id)
    try:
        validate_crop(crop, upright_size(path))
    except ValueError as e:
        abort(400, str(e))
    if not save_crop(asset_id, orientation, crop):
        abort(500, "Could not save crop metadata")
    return image_response(asset_id)


@app.route("/crop-data/<identifier>/<orientation>", methods=["DELETE"])
@asset_route(lock=True)
def delete_crop_data(asset_id, orientation):
    retire_uploads(asset_id, [require_orientation(orientation)])
    delete_crops(asset_id, orientation)
    return image_response(asset_id)


@app.route("/reset", methods=["POST"])
@asset_route(lock=True)
def reset_image(asset_id):
    delete_crops(asset_id)
    return image_response(asset_id)


@app.route("/sync", methods=["POST"])
def sync_with_immich():
    """Start syncing the Immich input album; poll /jobs/<id> for progress."""
    return job_response(*start_job("sync", run_sync))


@app.route("/jobs")
def get_jobs():
    """What the UI polls to notice syncs it didn't start (scheduled or at startup)."""
    return jsonify({"success": True, "running": jobs.running(), "last_sync": jobs.last_finished("sync"),
                    "history": jobs.history()})


@app.route("/jobs/<int:job_id>")
def get_job(job_id):
    job = jobs.get(job_id)
    if not job:
        abort(404, "Job not found")
    return jsonify({"success": True, "job": job})


@app.route('/jobs/<int:job_id>/cancel', methods=['POST'])
def cancel_job(job_id):
    job = jobs.cancel(job_id)
    if not job:
        abort(404, 'Job not found')
    return jsonify(success=True, job=job)


@app.route('/jobs/<int:job_id>/retry', methods=['POST'])
def retry_job(job_id):
    job = jobs.get(job_id)
    if not job:
        abort(404, 'Job not found')
    if job['status'] == 'running':
        abort(409, 'This job is still running')
    if job['scope'] != job_scope():
        abort(409, 'Immich settings changed; start a new sync or upload instead')
    asset_ids = list(dict.fromkeys([*job['errors'], *job['remaining_assets']]))
    if not asset_ids and job['status'] not in ('failed', 'interrupted', 'cancelled'):
        abort(400, 'This job has no failed images to retry')
    work = run_sync if job['kind'] == 'sync' else run_upload_all
    # A failure before listing the album has no known targets; repeat discovery.
    return job_response(*start_job(job['kind'], lambda progress: work(progress, asset_ids or None)))


class UploadFailure(RuntimeError):
    def __init__(self, message, uploaded_files):
        super().__init__(message)
        self.uploaded_files = uploaded_files


def upload_saved_crops(asset_id, orientations=None, album_assets=None):
    """Render and upload one image's crops, recording each success.

    By default only crops that aren't in Immich as they would render now are
    sent; naming orientations uploads those even if they are up to date.
    """
    with image_lock(asset_id):
        entry = read_all_crop_metadata().get(asset_id, {})
        intended = [o for o in ORIENTATIONS if saved_crop(entry, o)]
        if orientations is None:
            orientations = [o for o in intended if needs_upload(entry, o)]
            if intended and not orientations:
                return []
        if not orientations or any(o not in intended for o in orientations):
            raise ValueError('No saved crops to upload')
        uploaded = []
        try:
            path = source_path(asset_id)
            if album_assets is None:
                album_assets = output_album_assets()
            for orientation in orientations:
                album_id = immich_handler.output_album(orientation)
                assets = album_assets[orientation]
                crop, size = entry[orientation]["crop"], SIZES[orientation]
                filename = f'{asset_id}_{orientation}.jpg'
                context = {'server': immich_handler.base_url, 'album': album_id}
                pending = entry[orientation].get('pending_upload')
                if pending and any(pending.get(key) != value for key, value in context.items()):
                    raise RuntimeError('An unfinished upload belongs to different Immich settings; restore those settings to finish it')

                def checkpoint(state, selection=crop, output_size=size):
                    checkpoint_upload(asset_id, orientation, {
                        **state, **context, 'crop': selection, 'size': list(output_size),
                        'source_version': source_version(os.path.basename(path)),
                    })

                previous = find_processed_asset(assets, filename)
                if pending and (pending['crop'] != crop or pending['size'] != list(size) or
                                pending.get('source_version') != source_version(os.path.basename(path))):
                    # Finish retiring the earlier copy before publishing a newer selection.
                    previous = immich_handler.upload_asset(
                        b'', filename, album_id, resume=pending,
                        checkpoint=lambda state: checkpoint_upload(asset_id, orientation, {**pending, **state}),
                    )
                    mark_uploaded(asset_id, orientation, previous, pending['crop'], pending['size'])
                    pending = None
                remote_id = immich_handler.upload_asset(
                    b'' if pending else cached_render(path, crop, size)[0], filename,
                    album_id, replaces=previous, resume=pending, checkpoint=checkpoint,
                )
                mark_uploaded(asset_id, orientation, remote_id, crop, size)
                uploaded.append({'filename': filename, 'asset_id': remote_id,
                                 'original_asset_id': asset_id, 'orientation': orientation})
            return uploaded
        except Exception as e:
            raise UploadFailure(str(e), uploaded) from e


@app.route("/complete", methods=["POST"])
@asset_route(lock=True)
def complete_image(asset_id):
    """Complete only after every saved orientation is in Immich (unchanged ones aren't resent)."""
    try:
        return image_response(asset_id, uploaded_files=upload_saved_crops(asset_id))
    except ValueError as e:
        abort(400, str(e))
    except UploadFailure as e:
        return jsonify({'success': False, 'error': str(e), 'uploaded_files': e.uploaded_files,
                        'image': get_image(asset_id)}), 500


@app.route("/upload-single", methods=["POST"])
@asset_route(lock=True)
def upload_single_crop(asset_id):
    orientation = require_orientation((request.get_json() or {}).get('orientation'))
    try:
        uploaded = upload_saved_crops(asset_id, [orientation])
        return image_response(asset_id, uploaded_asset_id=uploaded[0]['asset_id'], orientation=orientation)
    except ValueError as e:
        abort(404, str(e))
    except UploadFailure as e:
        abort(500, str(e))


def run_upload_all(progress, asset_ids=None):
    """Upload every new or changed crop, one image at a time, reporting partial failures."""
    uploaded, failed = [], []
    # Saved coordinates survive removal from the source album; skip those images.
    pending = [asset_id for asset_id, entry in read_all_crop_metadata().items()
               if (asset_ids is None or asset_id in asset_ids) and get_filename_from_asset_id(asset_id)
               and any(needs_upload(entry, o) for o in ORIENTATIONS)]
    progress.plan(pending)
    if not pending:
        return {'success': True, 'uploaded_assets': [], 'failed_assets': [], 'error': None}
    # One fetch per distinct album for the whole batch; each crop only matches its own entry.
    album_assets = output_album_assets()
    for asset_id in pending:
        if progress.cancelled():
            break
        error = None
        try:
            uploaded.extend(upload_saved_crops(asset_id, album_assets=album_assets))
        except UploadFailure as e:
            uploaded.extend(e.uploaded_files)
            failed.append(asset_id)
            error = str(e)
        except (OSError, ValueError) as e:
            failed.append(asset_id)
            error = str(e)
        progress.complete(asset_id, error)
        progress.result({'success': not failed, 'uploaded_assets': uploaded, 'failed_assets': failed})
    return {'success': not failed, 'uploaded_assets': uploaded, 'failed_assets': failed,
            'error': 'Some crops could not be uploaded' if failed else None}


@app.route("/upload-all", methods=["POST"])
def upload_all_processed():
    """Start uploading all saved crops; poll /jobs/<id> for progress."""
    return job_response(*start_job("upload-all", run_upload_all))


@app.route("/delete-original", methods=["DELETE"])
@asset_route(lock=True)
def delete_original_image(asset_id):
    """Remove a source-album entry and its local cache, preserving the library photo."""
    result = immich_handler.remove_from_input_album(asset_id)
    if not result.get("success"):
        return jsonify(result), 502
    remove_cached_image(asset_id)
    return jsonify({"success": True, "message": "Removed from source album"})


@app.route("/meural/devices", methods=["GET"])
def get_meural_devices():
    """Get list of configured Meural devices"""
    return jsonify({"devices": meural_handler.get_device_list()})


@app.route("/meural/preview", methods=["POST"])
@asset_route()
def preview_on_meural(asset_id):
    data = request.get_json() or {}
    orientation, device_ip = require_orientation(data.get('orientation')), data.get('device_ip')
    if not device_ip:
        abort(400, 'A Meural device is required')
    crop = data.get('crop') if data.get('use_temp') else \
        saved_crop(read_all_crop_metadata().get(asset_id, {}), orientation)
    if not crop:
        abort(400, 'No crop available')
    try:
        content, _ = cached_render(source_path(asset_id), crop, SIZES[orientation])
    except ValueError as e:
        abort(400, str(e))
    result = meural_handler.preview_image(device_ip, content)
    return jsonify(result), (200 if result['success'] else 502)


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    logging.info("Starting Meural Canvas Image Cropper")
    logging.info(f"Using image cache directory: {config.CACHE_DIR}")

    if os.getenv('FLASK_DEBUG', '0').lower() in ('1', 'true', 'yes', 'on'):
        # Development server with auto-reload; sync only in the reloaded child process.
        if os.environ.get('WERKZEUG_RUN_MAIN') == 'true':
            initial_sync()
            schedule_syncs()
        app.run(host="0.0.0.0", port=5000, debug=True, threaded=True)
    else:
        initial_sync()
        schedule_syncs()
        # Production server. Keep a single process: per-image locks and jobs live in memory.
        from waitress import serve
        serve(app, host="0.0.0.0", port=5000, threads=8)
