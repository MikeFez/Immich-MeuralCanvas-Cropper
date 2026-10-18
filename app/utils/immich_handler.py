import os
import json
import tempfile
import requests
from typing import List, Dict, Any, Optional
import logging
from datetime import datetime, timezone
from PIL import Image
from utils.file_handler import image_lock, remove_cached_image, write_json_atomic
from config import (
    IMMICH_URL,
    IMMICH_API_KEY,
    IMMICH_INPUT_ALBUM_ID,
    IMMICH_OUTPUT_ALBUM_ID,
)


class ImmichHandler:
    def __init__(self):
        # Validate Immich configuration
        self.base_url = IMMICH_URL.rstrip("/")
        self.api_key = IMMICH_API_KEY
        self.input_album_id = IMMICH_INPUT_ALBUM_ID
        self.output_album_id = IMMICH_OUTPUT_ALBUM_ID

        if not self.base_url:
            raise ValueError("IMMICH_URL not configured in config.yaml")
        if not self.api_key:
            raise ValueError("IMMICH_API_KEY not configured in config.yaml")
        if not self.input_album_id:
            raise ValueError("IMMICH_INPUT_ALBUM_ID not configured in config.yaml")
        if not self.output_album_id:
            raise ValueError("IMMICH_OUTPUT_ALBUM_ID not configured in config.yaml")

        self.headers = {"x-api-key": self.api_key, "Accept": "application/json"}


    def _make_request(self, method: str, endpoint: str, **kwargs) -> Dict[str, Any]:
        """Make an HTTP request to the Immich API"""
        url = f"{self.base_url}/api{endpoint}"
        logging.info(f"Making Immich API request: {method} {url}")
        kwargs.setdefault("timeout", (5, 60))
        try:
            response = requests.request(method, url, headers=self.headers, **kwargs)

            # Log response content for debugging when there's an error
            if not response.ok:
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
            logging.error(
                f"Immich API request failed ({e.__class__.__name__}): {str(e)}"
            )
            logging.error(f"Full URL: {url}")
            if hasattr(e, "response") and e.response:
                logging.error(f"Response content: {e.response.text}")
            raise

    def get_album_assets(self, album_id: str) -> List[Dict[str, Any]]:
        """Get all assets from a specified album"""
        album_data = self._make_request("GET", f"/albums/{album_id}")

        if (
            album_data
            and "assets" in album_data
            and isinstance(album_data["assets"], list)
        ):
            return album_data["assets"]
        raise ValueError("Invalid Immich album response: missing assets list")

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
                    with requests.get(f'{self.base_url}/api/assets/{asset_id}/original',
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
        except Exception:
            logging.exception('Failed to download asset %s', asset_id)
            return False, ''
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

    def upload_asset(self, content: bytes, filename: str, album_id: str,
                     replaces: Optional[str] = None) -> str:
        """Upload JPEG bytes into an album and return the Immich asset ID.

        Immich v3 removed in-place replacement, so a new version is uploaded
        and the previous one (`replaces`) is moved to the Immich trash. Immich
        deduplicates identical bytes by returning the existing ID; that copy
        is kept.
        """
        now = datetime.now(timezone.utc).isoformat()
        data = {
            "deviceAssetId": os.path.splitext(filename)[0],
            "deviceId": "meural-cropper",
            "fileCreatedAt": now,
            "fileModifiedAt": now,
            "isFavorite": "false",
        }
        response = self._make_request(
            "POST", "/assets", files={"assetData": (filename, content, "image/jpeg")}, data=data
        )
        asset_id = response.get("id") if isinstance(response, dict) else None
        if not asset_id:
            raise RuntimeError(f"Immich returned no asset ID for {filename}")
        if not self.add_assets_to_album(album_id, [asset_id]):
            raise RuntimeError("Upload succeeded but adding the asset to the destination album failed")
        if replaces and replaces != asset_id:
            try:
                self.trash_asset(replaces)
            except Exception as e:
                raise RuntimeError(
                    f"Uploaded {filename} but could not remove the previous version {replaces}: {e}"
                ) from e
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

    def sync_input_images(self, input_folder):
        """Repair the cache and reconcile it with a successfully fetched source album."""
        assets = self.get_album_assets(self.input_album_id)
        if any(not isinstance(asset, dict) or not asset.get('id') for asset in assets):
            raise ValueError('Invalid source album asset')
        assets = [asset for asset in assets if asset.get('type', 'IMAGE') == 'IMAGE']
        active_ids = {asset['id'] for asset in assets}
        metadata_dir = os.path.join(input_folder, '.metadata')
        os.makedirs(metadata_dir, exist_ok=True)
        for name in os.listdir(metadata_dir):
            if name.endswith('.json') and name[:-5] not in active_ids:
                remove_cached_image(name[:-5])

        available = []
        failures = []
        for asset in assets:
            asset_id = asset['id']
            with image_lock(asset_id):
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
                        failures.append(asset_id)
                        continue
                    with open(os.path.join(metadata_dir, f'{asset_id}.json')) as f:
                        cached = json.load(f)
                available.append({'asset_id': asset_id, 'file_path': path,
                                  'original_filename': cached.get('original_filename', '')})
        if failures:
            raise RuntimeError(f'Could not download {len(failures)} source image(s); retry Sync')
        return available


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
