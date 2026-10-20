import os
import json
import tempfile
import requests
from utils.http_client import HttpClient
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any, Optional
import logging
import threading
from datetime import datetime, timezone
from PIL import Image
from utils.file_handler import image_lock, remove_cached_image, write_json_atomic


ALBUM_PAGE_SIZE = 1000  # the most Immich returns per search page
FACE_RECHECK_SECONDS = 24 * 3600  # how often to ask again about a photo with no faces yet


def face_boxes(faces):
    """Faces from Immich's /faces, as [left, top, right, bottom] fractions of the upright image.

    Uses the faces of people who aren't hidden; unassigned faces (often
    passers-by) count only when there are none.
    """
    faces = [face for face in faces if isinstance(face, dict)]
    people = [face for face in faces if isinstance(face.get('person'), dict) and not face['person'].get('isHidden')]
    boxes = []
    for face in people or [face for face in faces if not face.get('person')]:
        try:
            width, height = face['imageWidth'], face['imageHeight']
            box = (face['boundingBoxX1'] / width, face['boundingBoxY1'] / height,
                   face['boundingBoxX2'] / width, face['boundingBoxY2'] / height)
        except (KeyError, TypeError, ZeroDivisionError):
            continue
        boxes.append([round(min(max(value, 0.0), 1.0), 4) for value in box])
    return boxes


def faces_stale(metadata, now=None):
    """True when the cached face list is missing, or empty and not checked recently."""
    if 'faces' not in metadata:
        return True
    if metadata['faces']:
        return False
    try:
        checked = datetime.fromisoformat(metadata.get('faces_at') or '')
    except ValueError:
        return True
    return ((now or datetime.now(timezone.utc)) - checked).total_seconds() >= FACE_RECHECK_SECONDS


class ImmichHandler:
    def __init__(self, settings):
        self.configure(settings)

    def configure(self, settings):
        """Point at a server; settings is the immich section of the config (fields may be blank)."""
        self.http = HttpClient()
        self.base_url = (settings.get("url") or "").rstrip("/")
        self.api_key = settings.get("api_key") or ""
        self.input_album_id = settings.get("input_album_id") or ""
        self.output_album_id = settings.get("output_album_id") or ""
        self.headers = {"x-api-key": self.api_key, "Accept": "application/json"}
        # Whether the key has face.read: None until a sync asks, which it does
        # once per sync, so adding the permission in Immich takes effect.
        self.faces_allowed = None
        self.faces_lock = threading.Lock()
        self.faces_warned = False


    def _make_request(self, method: str, endpoint: str, quiet_statuses=(), **kwargs) -> Dict[str, Any]:
        """Make an HTTP request to the Immich API.

        Errors with a status in quiet_statuses are expected (the caller handles
        them), so they are raised without being logged as failures.
        """
        if not self.base_url or not self.api_key:
            raise RuntimeError("Immich is not configured; open Settings")
        url = f"{self.base_url}/api{endpoint}"
        logging.info(f"Making Immich API request: {method} {url}")
        kwargs.setdefault("timeout", (5, 60))
        try:
            response = self.http.session().request(method, url, headers=self.headers, **kwargs)

            # Log response content for debugging when there's an error
            if not response.ok and response.status_code not in quiet_statuses:
                logging.error(f"Error response: {response.text}")

            response.raise_for_status()

            if response.content:
                try:
                    data = response.json()
                    return data
                except ValueError:
                    logging.warning("Response was not valid JSON")
                    return {"content": response.content}
            return {}
        except requests.exceptions.RequestException as e:
            if getattr(e.response, "status_code", None) in quiet_statuses:
                raise
            logging.error(
                f"Immich API request failed ({e.__class__.__name__}): {str(e)}"
            )
            logging.error(f"Full URL: {url}")
            if hasattr(e, "response") and e.response:
                logging.error(f"Response content: {e.response.text}")
            raise

    def get_album_assets(self, album_id: str) -> List[Dict[str, Any]]:
        """Get all assets from a specified album.

        Immich v3 removed the asset list from the album response, so page through
        a metadata search filtered to the album (also available in Immich v2).
        """
        if not album_id:
            raise RuntimeError("Immich is not configured; open Settings")
        assets, page = [], 1
        while page:
            response = self._make_request(
                "POST", "/search/metadata", json={"albumIds": [album_id], "page": page, "size": ALBUM_PAGE_SIZE}
            )
            result = response.get("assets") if isinstance(response, dict) else None
            if not isinstance(result, dict) or not isinstance(result.get("items"), list):
                raise ValueError("Invalid Immich album search response: missing assets")
            assets.extend(result["items"])
            page = page + 1 if result.get("nextPage") else None
        return assets

    def list_albums(self) -> List[Dict[str, Any]]:
        """Albums the key's user owns or that are shared with them, sorted by name."""
        albums = {}
        # Immich v3 lists owned and shared albums together (and ignores ?shared);
        # v2 lists only owned ones unless ?shared=true.
        for params in (None, {"shared": "true"}):
            response = self._make_request("GET", "/albums", params=params)
            if not isinstance(response, list):
                raise ValueError("Invalid Immich album list response")
            for album in response:
                if isinstance(album, dict) and album.get("id"):
                    albums[album["id"]] = {"id": album["id"], "name": album.get("albumName") or "Untitled",
                                           "assets": album.get("assetCount", 0), "shared": bool(album.get("shared"))}
        return sorted(albums.values(), key=lambda album: album["name"].lower())

    def download_asset(self, asset_id: str, save_dir: str) -> tuple[bool, str]:
        """Download atomically; normalize formats browsers cannot display to JPEG."""
        temporary = None
        try:
            from utils.image_processor import render_image, write_image_atomic
            with image_lock(asset_id):
                info = self._make_request('GET', f'/assets/{asset_id}')
                extension = os.path.splitext(info.get('originalFileName', ''))[1].lower()
                native = extension in ('.jpg', '.jpeg', '.png', '.webp')
                extension = extension if native else '.jpg'
                path = os.path.join(save_dir, f'{asset_id}{extension}')
                os.makedirs(save_dir, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=save_dir, delete=False) as f:
                    temporary = f.name
                    with self.http.session().get(f'{self.base_url}/api/assets/{asset_id}/original',
                                      headers=self.headers, stream=True, timeout=(5, 60)) as response:
                        response.raise_for_status()
                        for chunk in response.iter_content(chunk_size=65536):
                            f.write(chunk)
                with Image.open(temporary) as image:
                    image.verify()
                if native:
                    os.replace(temporary, path)
                    temporary = None
                else:
                    write_image_atomic(path, render_image(temporary))
                self._store_asset_metadata(asset_id, info, path)
                return True, path
        except Exception as error:
            logging.exception('Failed to download asset %s', asset_id)
            return False, str(error)
        finally:
            if temporary and os.path.exists(temporary):
                os.remove(temporary)

    def _store_asset_metadata(self, asset_id, asset_info, file_path):
        """Publish source metadata only after the complete image is available."""
        metadata = {
            'asset_id': asset_id,
            'original_filename': asset_info.get('originalFileName', ''),
            'file_path': file_path,
            'created_at': asset_info.get('createdAt', ''),
            'modified_at': asset_info.get('updatedAt', asset_info.get('modifiedAt', '')),
        }
        path = os.path.join(os.path.dirname(file_path), '.metadata', f'{asset_id}.json')
        write_json_atomic(path, metadata)

    def refresh_faces(self, asset_id, metadata_path, metadata):
        """Store the faces Immich found in a cached image; a failure leaves the cache as it was.

        Needs the key's face.read permission, which is optional: without it new
        crops simply start centered.
        """
        if self.faces_allowed is None:
            # Until the permission is known, one request at a time: a missing
            # face.read costs a single refused request per sync.
            with self.faces_lock:
                if self.faces_allowed is None:
                    self._fetch_faces(asset_id, metadata_path, metadata)
                    return
        if self.faces_allowed:
            self._fetch_faces(asset_id, metadata_path, metadata)

    def _fetch_faces(self, asset_id, metadata_path, metadata):
        try:
            faces = self._make_request('GET', '/faces', params={'id': asset_id}, quiet_statuses=(401, 403))
            if not isinstance(faces, list):
                raise ValueError('Invalid Immich faces response')
            self.faces_allowed = True
            write_json_atomic(metadata_path, {**metadata, 'faces': face_boxes(faces),
                                              'faces_at': datetime.now(timezone.utc).isoformat()})
        except requests.HTTPError as error:
            if error.response is not None and error.response.status_code in (401, 403):
                self.faces_allowed = False
                if not self.faces_warned:
                    self.faces_warned = True
                    logging.warning('The Immich API key lacks face.read, so new crops start centered '
                                    'instead of on faces; each sync checks again')
            else:
                logging.warning('Could not fetch faces for %s: %s', asset_id, error)
        except Exception as error:
            logging.warning('Could not fetch faces for %s: %s', asset_id, error)

    def upload_asset(self, content: bytes, filename: str, album_id: str,
                     replaces: Optional[str] = None, resume=None, checkpoint=None) -> str:
        """Upload, attach and retire the old copy, checkpointing each remote step.

        A retry uses the saved remote ID instead of sending the JPEG again.
        Mutations remain safe to repeat if a crash precedes the next checkpoint.
        """
        state = dict(resume or {})
        def save():
            if checkpoint:
                checkpoint(dict(state))

        if not state.get('asset_id'):
            now = datetime.now(timezone.utc).isoformat()
            response = self._make_request(
                'POST', '/assets', files={'assetData': (filename, content, 'image/jpeg')},
                data={'deviceAssetId': os.path.splitext(filename)[0], 'deviceId': 'meural-cropper',
                      'fileCreatedAt': now, 'fileModifiedAt': now, 'isFavorite': 'false'},
            )
            remote_id = response.get('id') if isinstance(response, dict) else None
            if not remote_id:
                raise RuntimeError(f'Immich returned no asset ID for {filename}')
            state.update(asset_id=remote_id, replaces=replaces, attached=False, retired=False)
            save()
        asset_id = state['asset_id']
        if not state.get('attached'):
            if not self.add_assets_to_album(album_id, [asset_id]):
                raise RuntimeError('Upload succeeded but adding the asset to the destination album failed')
            state['attached'] = True
            save()
        previous = state.get('replaces')
        if previous and previous != asset_id and not state.get('retired'):
            try:
                self.trash_asset(previous)
            except Exception as e:
                raise RuntimeError(
                    f'Uploaded {filename} but could not remove the previous version {previous}: {e}'
                ) from e
            state['retired'] = True
            save()
        return asset_id

    def trash_asset(self, asset_id: str):
        """Move an asset to the Immich trash (recoverable until the trash empties)."""
        self._make_request("DELETE", "/assets", json={"ids": [asset_id]})

    def add_assets_to_album(self, album_id: str, asset_ids: List[str]) -> bool:
        """Add assets to a specified album"""
        try:
            results = self._make_request(
                "PUT", f"/albums/{album_id}/assets", json={"ids": asset_ids}
            )
            if not isinstance(results, list):
                return False
            return all(any(item.get("id") == asset_id and
                           (item.get("success") or item.get("error") == "duplicate")
                           for item in results) for asset_id in asset_ids)
        except Exception as e:
            logging.error(f"Failed to add assets to album: {e}")
            return False

    def sync_input_images(self, input_folder, progress=None, workers=4, asset_ids=None):
        """Repair the cache and reconcile it with a successfully fetched source album.

        Assets are checked and downloaded in parallel; progress(done, total) is
        called as each one finishes.
        """
        assets = self.get_album_assets(self.input_album_id)
        if self.faces_allowed is False:
            self.faces_allowed = None  # ask again, in case face.read was added
        if any(not isinstance(asset, dict) or not asset.get('id') for asset in assets):
            raise ValueError('Invalid source album asset')
        assets = [asset for asset in assets if asset.get('type', 'IMAGE') == 'IMAGE']
        def cancelled():
            return bool(progress and hasattr(progress, 'cancelled') and progress.cancelled())

        if cancelled():
            return []
        active_ids = {asset['id'] for asset in assets}
        metadata_dir = os.path.join(input_folder, '.metadata')
        os.makedirs(metadata_dir, exist_ok=True)
        for name in os.listdir(metadata_dir):
            if cancelled():
                return []
            if name.endswith('.json') and name[:-5] not in active_ids:
                remove_cached_image(name[:-5])

        if asset_ids is not None:
            assets = [asset for asset in assets if asset['id'] in asset_ids]

        def ensure_cached(asset):
            """Return the cache entry for one asset, downloading it if missing or stale; None on failure."""
            asset_id = asset['id']
            if cancelled():
                return None
            with image_lock(asset_id):
                if cancelled():
                    return None
                cached = None
                try:
                    with open(os.path.join(metadata_dir, f'{asset_id}.json')) as f:
                        cached = json.load(f)
                    path = os.path.join(input_folder, os.path.basename(cached['file_path']))
                    with Image.open(path) as image:
                        image.verify()
                    modified = asset.get('updatedAt', asset.get('modifiedAt', ''))
                    if modified and modified != cached.get('modified_at'):
                        cached = None
                except (OSError, ValueError, KeyError, TypeError):
                    cached = None
                if cached is None:
                    success, path = self.download_asset(asset_id, input_folder)
                    if not success:
                        raise RuntimeError(path or 'Could not download source image')
                    with open(os.path.join(metadata_dir, f'{asset_id}.json')) as f:
                        cached = json.load(f)
                if faces_stale(cached):
                    self.refresh_faces(asset_id, os.path.join(metadata_dir, f'{asset_id}.json'), cached)
                return {'asset_id': asset_id, 'file_path': path,
                        'original_filename': cached.get('original_filename', '')}

        if progress and hasattr(progress, 'plan'):
            progress.plan([asset['id'] for asset in assets])
        elif progress:
            progress(0, len(assets))
        available, failures = [], []
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(ensure_cached, asset): asset['id'] for asset in assets}
            for done, future in enumerate(as_completed(futures), 1):
                asset_id = futures[future]
                error = None
                try:
                    entry = future.result()
                    if entry:
                        available.append(entry)
                    elif cancelled():
                        continue
                    else:
                        error = 'Could not download source image'
                except Exception as exception:
                    error = str(exception)
                if error:
                    failures.append(asset_id)
                if progress and hasattr(progress, 'complete'):
                    progress.complete(asset_id, error)
                elif progress:
                    progress(done, len(assets))
        if failures and not cancelled():
            raise RuntimeError(f'Could not download {len(failures)} source image(s); retry Sync')
        by_id = {entry['asset_id']: entry for entry in available}
        return [by_id[asset['id']] for asset in assets if asset['id'] in by_id]


    def remove_from_input_album(self, asset_id: str) -> Dict[str, Any]:
        """Remove album membership without deleting the photo from Immich."""
        try:
            results = self._make_request(
                "DELETE", f"/albums/{self.input_album_id}/assets", json={"ids": [asset_id]}
            )
            if not isinstance(results, list) or not any(
                item.get("id") == asset_id and item.get("success") for item in results
            ):
                raise RuntimeError("Immich did not remove the asset from the source album")
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}


def find_processed_asset(album_assets: List[Dict[str, Any]], filename: str) -> Optional[str]:
    """ID of the album asset previously uploaded under `filename`, if any."""
    stem = os.path.splitext(filename)[0]
    for asset in album_assets:
        if stem in asset.get("originalFileName", ""):
            return asset["id"]
    return None
