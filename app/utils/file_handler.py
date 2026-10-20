"""Persistent crop/upload state and the disposable source-image cache.

crops/metadata.json holds, per asset and orientation:
    {"crop": {x, y, width, height}, "uploaded": {"asset_id", "crop", "size", "at"}}
"crop" is the saved selection; "uploaded" records what was last sent to Immich.
An orientation is up to date when both crops are equal and it was rendered at
the current output size, so re-cropping after an upload (or changing the size)
makes the image pending again without a separate progress store.
"""
import os
import json
import logging
import tempfile
import threading
from datetime import datetime, timezone
from utils.image_processor import upright_size
from config import INPUT_FOLDER, CROP_METADATA_FILE, LEGACY_PROGRESS_FILE, THUMBNAIL_FOLDER, ORIENTATIONS, SIZES

METADATA_DIR = os.path.join(INPUT_FOLDER, ".metadata")

state_lock = threading.RLock()
_image_locks = {}
_image_locks_lock = threading.Lock()


def image_lock(asset_id):
    """Serialize changes to one image without blocking reads or other images."""
    with _image_locks_lock:
        return _image_locks.setdefault(asset_id, threading.RLock())


def write_json_atomic(path, data):
    """Replace a JSON document only after the complete new version is written."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as f:
            temp_path = f.name
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


# --- Crop and upload state -------------------------------------------------

def read_all_crop_metadata():
    """Read all state without treating corrupt data as an empty store."""
    with state_lock:
        if not os.path.exists(CROP_METADATA_FILE):
            return {}
        with open(CROP_METADATA_FILE) as f:
            metadata = json.load(f)
        if not isinstance(metadata, dict) or not isinstance(metadata.get("crops"), dict):
            raise ValueError("Invalid crop metadata: expected a crops object")
        return metadata["crops"]


def _update_entry(asset_id, change):
    """Apply change(entry) to one asset's state and persist it atomically."""
    with state_lock:
        crops = read_all_crop_metadata()
        entry = crops.setdefault(asset_id, {})
        change(entry)
        for orientation in ORIENTATIONS:
            if orientation in entry and not entry[orientation]:
                del entry[orientation]
        if not entry:
            del crops[asset_id]
        write_json_atomic(CROP_METADATA_FILE, {"crops": crops})


def saved_crop(entry, orientation):
    return (entry.get(orientation) or {}).get("crop")


def save_crop(asset_id, orientation, crop):
    """Persist one selection, keeping existing data intact on write failure."""
    try:
        _update_entry(asset_id, lambda entry: entry.setdefault(orientation, {}).update(crop=crop))
        return True
    except (OSError, ValueError, TypeError):
        logging.exception("Could not save crop metadata for %s", asset_id)
        return False


def delete_crops(asset_id, orientation=None):
    """Remove selections; upload records stay until their Immich copy is removed."""
    def change(entry):
        for key in [orientation] if orientation else ORIENTATIONS:
            (entry.get(key) or {}).pop("crop", None)
    _update_entry(asset_id, change)


def mark_uploaded(asset_id, orientation, remote_id, crop, size):
    """Record which selection and output size the Immich copy was rendered from."""
    record = {"asset_id": remote_id, "crop": crop, "size": list(size), "at": datetime.now(timezone.utc).isoformat()}
    def update(entry):
        state = entry.setdefault(orientation, {})
        state['uploaded'] = record
        state.pop('pending_upload', None)
    _update_entry(asset_id, update)


def upload_records(entry, orientation):
    """The finished and unfinished upload records of one orientation."""
    state = entry.get(orientation) or {}
    return [record for record in (state.get("uploaded"), state.get("pending_upload")) if record]


def forget_uploads(asset_id, orientation):
    """Drop an orientation's upload records once its Immich copy is gone."""
    def change(entry):
        state = entry.get(orientation) or {}
        state.pop("uploaded", None)
        state.pop("pending_upload", None)
    _update_entry(asset_id, change)


def forget_missing_uploads(present_ids, find_legacy, listed_at):
    """Drop upload records whose Immich copy is no longer in the destination album.

    present_ids is the album's asset IDs as listed at listed_at (ISO UTC);
    find_legacy(filename) finds the copy of a record saved without an asset ID.
    Records written after the listing, and unfinished uploads, are left alone.
    Returns the asset IDs whose records changed.
    """
    changed = []
    with state_lock:
        crops = read_all_crop_metadata()
        for asset_id, entry in crops.items():
            for orientation in ORIENTATIONS:
                state = entry.get(orientation) or {}
                record = state.get("uploaded")
                if not record or state.get("pending_upload") or (record.get("at") or "") >= listed_at:
                    continue
                remote_id = record.get("asset_id") or find_legacy(f"{asset_id}_{orientation}.jpg")
                if remote_id in present_ids:
                    continue
                del state["uploaded"]
                if not state:
                    del entry[orientation]
                changed.append(asset_id)
        if changed:
            write_json_atomic(CROP_METADATA_FILE, {"crops": {k: v for k, v in crops.items() if v}})
    return sorted(set(changed))


def checkpoint_upload(asset_id, orientation, record):
    """Persist remote side effects before proceeding to the next upload step."""
    _update_entry(asset_id, lambda entry: entry.setdefault(orientation, {}).update(pending_upload=record))


def needs_upload(entry, orientation):
    """True when a saved selection isn't in Immich as it would render now."""
    crop = saved_crop(entry, orientation)
    if not crop:
        return False
    uploaded = entry[orientation].get("uploaded") or {}
    size = list(SIZES[orientation])
    # Records from before sizes were tracked count as the current size.
    return bool(entry[orientation].get("pending_upload")) or uploaded.get("crop") != crop or uploaded.get("size", size) != size


def image_status(entry):
    """'completed' once every saved selection is in Immich, else which crops exist."""
    saved = [o for o in ORIENTATIONS if saved_crop(entry, o)]
    if not saved:
        return "unprocessed"
    if not any(needs_upload(entry, o) for o in saved):
        return "completed"
    return "both" if len(saved) == 2 else saved[0]


def migrate_legacy_state():
    """Convert {orientation: crop} entries and progress.json "completed" flags once."""
    try:
        with state_lock:
            crops = read_all_crop_metadata()
            progress = {}
            if os.path.exists(LEGACY_PROGRESS_FILE):
                with open(LEGACY_PROGRESS_FILE) as f:
                    progress = json.load(f)
            legacy = any("x" in (entry.get(o) or {}) for entry in crops.values() for o in ORIENTATIONS)
            if not legacy and not progress:
                return
            for asset_id, entry in crops.items():
                for orientation in ORIENTATIONS:
                    value = entry.get(orientation)
                    if value and "x" in value:
                        entry[orientation] = value = {"crop": value}
                    if value and value.get("crop") and progress.get(asset_id) == "completed":
                        value.setdefault("uploaded", {"asset_id": None, "crop": value["crop"], "at": None})
            write_json_atomic(CROP_METADATA_FILE, {"crops": crops})
            if os.path.exists(LEGACY_PROGRESS_FILE):
                os.replace(LEGACY_PROGRESS_FILE, LEGACY_PROGRESS_FILE + ".migrated")
            logging.info("Migrated crop metadata and progress to the combined format")
    except (OSError, ValueError, TypeError, AttributeError):
        logging.exception("Could not migrate legacy crop state; leaving files untouched")


# --- Source image cache ------------------------------------------------------

def get_filename_from_asset_id(asset_id):
    """Cached source filename for an asset, or None when it is not in the source album."""
    try:
        with open(os.path.join(METADATA_DIR, f"{asset_id}.json")) as f:
            file_path = json.load(f).get("file_path", "")
        return os.path.basename(file_path) or None
    except (OSError, ValueError, AttributeError):
        return None


def source_version(filename):
    """Stable cache version that changes only when the source file changes."""
    stat = os.stat(os.path.join(INPUT_FOLDER, filename))
    return f'{stat.st_mtime_ns:x}-{stat.st_size:x}'


def remove_cached_image(asset_id):
    """Remove disposable source/thumbnail files, retaining saved crop coordinates."""
    with image_lock(asset_id):
        filename = get_filename_from_asset_id(asset_id)
        paths = [os.path.join(METADATA_DIR, f'{asset_id}.json')]
        if filename:
            paths.append(os.path.join(INPUT_FOLDER, filename))
        if os.path.isdir(THUMBNAIL_FOLDER):
            paths.extend(os.path.join(THUMBNAIL_FOLDER, name) for name in os.listdir(THUMBNAIL_FOLDER)
                         if name.startswith(f'{asset_id}_'))
        for path in paths:
            if os.path.isfile(path):
                os.remove(path)


def _describe(asset_id, source, entry):
    filename = os.path.basename(source.get("file_path", ""))
    if not filename:
        raise ValueError("metadata has no file_path")
    return {
        "asset_id": asset_id,
        "filename": filename,
        "original_filename": source.get("original_filename", ""),
        "source_version": source_version(filename),
        "source_size": dict(zip(("width", "height"), upright_size(os.path.join(INPUT_FOLDER, filename)))),
        "crops": {o: saved_crop(entry, o) for o in ORIENTATIONS},
        "uploaded": {o: bool(upload_records(entry, o)) for o in ORIENTATIONS},
        "faces": source.get("faces") or [],
        "status": image_status(entry),
    }


def get_image(asset_id):
    """One cached source image with its crops and status, or None."""
    try:
        with open(os.path.join(METADATA_DIR, f"{asset_id}.json")) as f:
            source = json.load(f)
        return _describe(asset_id, source, read_all_crop_metadata().get(asset_id, {}))
    except (OSError, ValueError, AttributeError):
        return None


def get_image_list():
    """Every cached source image with its crops and status, sorted by asset ID."""
    images = []
    all_crops = read_all_crop_metadata()
    if not os.path.isdir(METADATA_DIR):
        return images
    for name in sorted(os.listdir(METADATA_DIR)):
        if not name.endswith(".json"):
            continue
        asset_id = name[:-5]
        try:
            with open(os.path.join(METADATA_DIR, name)) as f:
                source = json.load(f)
            images.append(_describe(asset_id, source, all_crops.get(asset_id, {})))
        except (OSError, ValueError, AttributeError) as e:
            # A missing source file is skipped; the next sync repairs it.
            logging.debug("Skipping cached image %s: %s", asset_id, e)
    return images
