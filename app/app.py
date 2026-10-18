import os
import re
import logging
import threading
import io
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
logging.info(f"Initializing connection to Immich at {config.IMMICH_URL}")
immich_handler = ImmichHandler()
meural_handler = MeuralHandler(config.MEURAL_DEVICES)

sync_lock = threading.Lock()
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


def initial_sync():
    """Warm the input cache without blocking startup or overlapping manual sync."""
    if not sync_lock.acquire(blocking=False):
        return
    try:
        immich_handler.sync_input_images(config.INPUT_FOLDER)
    except Exception:
        logging.exception("Initial sync failed; the web app remains available")
    finally:
        sync_lock.release()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/dimensions")
def get_dimensions():
    """Get image dimensions from config"""
    return jsonify({o: {"width": w, "height": h} for o, (w, h) in SIZES.items()})


@app.route("/images")
def get_images():
    return jsonify(get_image_list())


@app.route("/image/<identifier>")
@asset_route()
def get_source_image(asset_id):
    return send_from_directory(config.INPUT_FOLDER, os.path.basename(source_path(asset_id)))


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


@app.route("/output/<orientation>/<identifier>")
@asset_route()
def get_output_image(asset_id, orientation):
    crop = saved_crop(read_all_crop_metadata().get(asset_id, {}), require_orientation(orientation))
    if not crop:
        abort(404, "Saved crop not found")
    content = render_image(source_path(asset_id), crop, SIZES[orientation])
    return send_file(io.BytesIO(content), mimetype='image/jpeg')


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
    delete_crops(asset_id, require_orientation(orientation))
    return image_response(asset_id)


@app.route("/reset", methods=["POST"])
@asset_route(lock=True)
def reset_image(asset_id):
    delete_crops(asset_id)
    return image_response(asset_id)


@app.route("/sync", methods=["POST"])
def sync_with_immich():
    """Sync images from Immich input album; a concurrent request is a no-op."""
    if not sync_lock.acquire(blocking=False):
        return jsonify({"success": True, "message": "Sync already in progress", "images": get_image_list()})
    try:
        immich_handler.sync_input_images(config.INPUT_FOLDER)
        return jsonify({"success": True, "images": get_image_list()})
    finally:
        sync_lock.release()


class UploadFailure(RuntimeError):
    def __init__(self, message, uploaded_files):
        super().__init__(message)
        self.uploaded_files = uploaded_files


def upload_saved_crops(asset_id, orientations=None, album_assets=None):
    """Render and upload one image's selected crops, recording each success."""
    with image_lock(asset_id):
        entry = read_all_crop_metadata().get(asset_id, {})
        intended = [o for o in ORIENTATIONS if saved_crop(entry, o)]
        selected = intended if orientations is None else orientations
        if not selected or any(o not in intended for o in selected):
            raise ValueError('No saved crops to upload')
        uploaded = []
        try:
            path = source_path(asset_id)
            if album_assets is None:
                album_assets = immich_handler.get_album_assets(immich_handler.output_album_id)
            for orientation in selected:
                crop = entry[orientation]["crop"]
                filename = f'{asset_id}_{orientation}.jpg'
                remote_id = immich_handler.upload_asset(
                    render_image(path, crop, SIZES[orientation]), filename,
                    immich_handler.output_album_id, replaces=find_processed_asset(album_assets, filename),
                )
                mark_uploaded(asset_id, orientation, remote_id, crop)
                uploaded.append({'filename': filename, 'asset_id': remote_id,
                                 'original_asset_id': asset_id, 'orientation': orientation})
            return uploaded
        except Exception as e:
            raise UploadFailure(str(e), uploaded) from e


@app.route("/complete", methods=["POST"])
@asset_route(lock=True)
def complete_image(asset_id):
    """Complete only after all saved orientations upload successfully."""
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


@app.route("/upload-all", methods=["POST"])
def upload_all_processed():
    """Process one asset at a time, reporting partial failures explicitly."""
    uploaded, failed = [], []
    # One album fetch for the whole batch; each crop only matches its own entry.
    album_assets = immich_handler.get_album_assets(immich_handler.output_album_id)
    for asset_id, entry in read_all_crop_metadata().items():
        if not get_filename_from_asset_id(asset_id):
            continue  # Saved coordinates survive removal from the source album.
        if not any(saved_crop(entry, o) for o in ORIENTATIONS):
            continue
        try:
            uploaded.extend(upload_saved_crops(asset_id, album_assets=album_assets))
        except UploadFailure as e:
            uploaded.extend(e.uploaded_files)
            failed.append(asset_id)
    return jsonify({'success': not failed, 'uploaded_assets': uploaded,
                    'failed_assets': failed,
                    'error': 'Some crops could not be uploaded' if failed else None}), (502 if failed else 200)


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
        content = render_image(source_path(asset_id), crop, SIZES[orientation])
    except ValueError as e:
        abort(400, str(e))
    result = meural_handler.preview_image(device_ip, content)
    return jsonify(result), (200 if result['success'] else 502)


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


threading.Thread(target=initial_sync, name="initial-immich-sync", daemon=True).start()


if __name__ == "__main__":
    logging.info("Starting Meural Canvas Image Cropper")
    logging.info(f"Using temporary directory: {config.APP_TMP_DIR}")

    debug_mode = os.getenv('FLASK_DEBUG', '0').lower() in ('1', 'true', 'yes', 'on')
    if not debug_mode:
        # Suppress per-request logs and the development server warning
        logging.getLogger('werkzeug').setLevel(logging.ERROR)

    app.run(host="0.0.0.0", port=5000, debug=debug_mode, threaded=True)
