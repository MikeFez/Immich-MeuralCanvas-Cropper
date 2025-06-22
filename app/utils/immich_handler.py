import os
import requests
from typing import List, Dict, Any, Optional
import logging
from datetime import datetime
from PIL import Image
from pillow_heif import register_heif_opener
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

        # Initialize API client
        self.init_api_client()

    def init_api_client(self):
        """Initialize API client with authentication check"""
        try:
            # Test authentication by making a request to the server ping endpoint
            logging.info("Testing Immich API connection...")
            response = requests.get(
                f"{self.base_url}/api/server/ping", headers=self.headers
            )
            response.raise_for_status()
            ping_response = response.json()
            if ping_response.get("res") == "pong":
                # Successfully connected to Immich server
                logging.info("Successfully connected to Immich server")
            else:
                raise Exception("Invalid ping response from server")
        except Exception as e:
            logging.error(f"Failed to initialize Immich API client: {str(e)}")
            raise

    def _make_request(self, method: str, endpoint: str, **kwargs) -> Dict[str, Any]:
        """Make an HTTP request to the Immich API"""
        url = f"{self.base_url}/api{endpoint}"
        logging.info(f"Making Immich API request: {method} {url}")
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
        return []

    def download_asset(self, asset_id: str, save_dir: str) -> tuple[bool, str]:
        """Download an asset from Immich and convert HEIC to JPEG if needed

        Args:
            asset_id (str): Immich asset ID
            save_dir (str): Directory to save the asset

        Returns:
            tuple: (success, file_path)
        """
        try:
            # First get asset metadata to determine file type and original name
            asset_info = self._make_request("GET", f"/assets/{asset_id}")

            # Extract original filename and type
            original_filename = asset_info.get("originalFileName", "")
            file_extension = (
                os.path.splitext(original_filename)[1].lower()
                if original_filename
                else ""
            )

            # If no extension or unrecognized, default to jpg
            if not file_extension or file_extension not in [
                ".jpg",
                ".jpeg",
                ".png",
                ".heic",
            ]:
                file_extension = ".jpg"

            # Generate the new filename based on asset ID
            save_path = os.path.join(save_dir, f"{asset_id}{file_extension}")

            # Download the original file
            response = requests.get(
                f"{self.base_url}/api/assets/{asset_id}/original",
                headers=self.headers,
                stream=True,
            )
            response.raise_for_status()

            # Check if this is a HEIC file that needs conversion
            if file_extension.lower() == ".heic":
                jpeg_path = os.path.join(save_dir, f"{asset_id}.jpg")

                # Save to a temporary file and convert to JPEG
                temp_path = save_path + ".tmp"
                with open(temp_path, "wb") as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        f.write(chunk)

                try:
                    # Register the HEIF opener
                    register_heif_opener()

                    # Open the HEIC file and convert to JPEG
                    img = Image.open(temp_path)
                    img.save(jpeg_path, format="JPEG", quality=95)

                    # Remove the temporary file
                    os.remove(temp_path)

                    # Store metadata mapping
                    self._store_asset_metadata(asset_id, asset_info, jpeg_path)

                    return True, jpeg_path
                except Exception as e:
                    logging.error(f"Failed to convert HEIC to JPEG: {e}")
                    # If conversion fails, keep the original file
                    os.rename(temp_path, save_path)

                    # Store metadata even for failed conversion
                    self._store_asset_metadata(asset_id, asset_info, save_path)

                    return True, save_path
            else:
                # Regular file, just save it
                with open(save_path, "wb") as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        f.write(chunk)

                # Store asset metadata
                self._store_asset_metadata(asset_id, asset_info, save_path)

                return True, save_path
        except Exception as e:
            logging.error(f"Failed to download asset {asset_id}: {e}")
            return False, ""

    def _store_asset_metadata(
        self, asset_id: str, asset_info: Dict[str, Any], file_path: str
    ):
        """Store asset metadata in a JSON file for reference

        Args:
            asset_id (str): Immich asset ID
            asset_info (dict): Asset metadata from Immich
            file_path (str): Path where the asset was saved
        """
        try:
            import json

            # Create metadata directory if it doesn't exist
            metadata_dir = os.path.join(os.path.dirname(file_path), ".metadata")
            os.makedirs(metadata_dir, exist_ok=True)

            # Save minimal metadata for future reference
            metadata = {
                "asset_id": asset_id,
                "original_filename": asset_info.get("originalFileName", ""),
                "file_path": file_path,
                "created_at": asset_info.get("createdAt", ""),
                "modified_at": asset_info.get("modifiedAt", ""),
            }

            # Save to metadata file
            with open(os.path.join(metadata_dir, f"{asset_id}.json"), "w") as f:
                json.dump(metadata, f, indent=2)

        except Exception as e:
            logging.error(f"Failed to store asset metadata for {asset_id}: {e}")

    def upload_asset(
        self,
        file_path: str,
        album_id: Optional[str] = None,
        original_asset_id: Optional[str] = None,
    ):
        """Upload an asset to Immich and optionally add it to an album

        If the asset already exists in the output album, it will be replaced
        rather than creating a duplicate.

        Args:
            file_path (str): Path to the file to upload
            album_id (str, optional): Album ID to add the asset to
            original_asset_id (str, optional): Original asset ID for tracking
        """
        # First check if we've already uploaded this processed asset to the output album
        if album_id and original_asset_id:
            orientation = "portrait" if "_portrait." in file_path else "landscape"
            existing_asset = self._find_existing_processed_asset(
                original_asset_id, orientation, album_id
            )

            if existing_asset:
                logging.info(
                    f"Found existing processed asset {existing_asset['id']} for original "
                    f"{original_asset_id} ({orientation}) - will replace"
                )
                # Replace the existing asset with the new version
                return self._replace_asset(existing_asset["id"], file_path)

        # Continue with normal upload if no existing asset was found
        with open(file_path, "rb") as f:
            files = {"assetData": f}

            # Get file stats for metadata
            stats = os.stat(file_path)

            # Determine device asset ID - use original asset ID if provided
            device_asset_id = (
                original_asset_id
                if original_asset_id
                else f"asset-{os.path.basename(file_path)}-{stats.st_mtime}"
            )

            data = {
                "deviceAssetId": device_asset_id,
                "deviceId": "meural-cropper",
                "fileCreatedAt": datetime.fromtimestamp(stats.st_mtime).isoformat(),
                "fileModifiedAt": datetime.fromtimestamp(stats.st_mtime).isoformat(),
                "isFavorite": "false",
            }

            response = self._make_request("POST", "/assets", files=files, data=data)

        if album_id and response.get("id"):
            # Add the asset to the specified album
            self.add_assets_to_album(album_id, [response["id"]])

            # Store relationship between original and new asset
            if original_asset_id:
                self._store_asset_relationship(
                    original_asset_id, response["id"], file_path
                )

        return response

    def _find_existing_processed_asset(
        self, original_asset_id: str, orientation: str, album_id: str
    ) -> Optional[Dict[str, Any]]:
        """Find an existing processed asset for the given original asset and orientation

        Args:
            original_asset_id (str): Original asset ID
            orientation (str): Either 'portrait' or 'landscape'
            album_id (str): Album ID to search in

        Returns:
            dict: Asset metadata if found, None otherwise
        """
        try:
            # Get all assets in the output album
            album_assets = self.get_album_assets(album_id)

            # Look for a filename that matches our naming pattern
            pattern = f"{original_asset_id}_{orientation}"

            for asset in album_assets:
                filename = asset.get("originalFileName", "")
                if pattern in filename:
                    logging.info(
                        f"Found matching asset: {asset['id']} with filename {filename}"
                    )
                    return asset

            return None
        except Exception as e:
            logging.error(f"Error finding existing processed asset: {e}")
            return None

    def _replace_asset(self, asset_id: str, file_path: str) -> Dict[str, Any]:
        """Replace an existing asset with a new file using the replaceAsset endpoint

        Args:
            asset_id (str): ID of the asset to replace
            file_path (str): Path to the new file

        Returns:
            dict: Response from the API
        """
        try:
            # Open the file and send it using the replaceAsset endpoint
            with open(file_path, "rb") as f:
                files = {"assetData": f}

                # Get file stats for metadata
                stats = os.stat(file_path)

                data = {
                    "deviceAssetId": asset_id,
                    "deviceId": "meural-cropper",
                    "fileCreatedAt": datetime.fromtimestamp(stats.st_mtime).isoformat(),
                    "fileModifiedAt": datetime.fromtimestamp(
                        stats.st_mtime
                    ).isoformat(),
                    "isFavorite": "false",
                }

                # The replaceAsset endpoint is a different path structure
                response = self._make_request(
                    "PUT", f"/assets/{asset_id}/original", files=files, data=data
                )

                logging.info(f"Successfully replaced asset {asset_id} with {file_path}")
                return response

        except Exception as e:
            logging.error(f"Error replacing asset {asset_id}: {e}")
            return {"error": str(e)}

    def _store_asset_relationship(
        self, original_asset_id: str, new_asset_id: str, file_path: str
    ):
        """Store relationship between original and processed assets

        Args:
            original_asset_id (str): Original Immich asset ID
            new_asset_id (str): New Immich asset ID after upload
            file_path (str): Path of the uploaded file
        """
        try:
            import json

            # Create relationships directory if it doesn't exist
            rel_dir = os.path.join(
                os.path.dirname(os.path.dirname(file_path)), ".relationships"
            )
            os.makedirs(rel_dir, exist_ok=True)

            # Define the relationship
            relationship = {
                "original_asset_id": original_asset_id,
                "processed_asset_id": new_asset_id,
                "file_path": file_path,
                "timestamp": datetime.now().isoformat(),
            }

            # Save to relationship file
            rel_file = os.path.join(rel_dir, f"{original_asset_id}_{new_asset_id}.json")
            with open(rel_file, "w") as f:
                json.dump(relationship, f, indent=2)

        except Exception as e:
            logging.error(f"Failed to store asset relationship: {e}")

    def add_assets_to_album(self, album_id: str, asset_ids: List[str]) -> bool:
        """Add assets to a specified album"""
        try:
            self._make_request(
                "PUT", f"/albums/{album_id}/assets", json={"ids": asset_ids}
            )
            return True
        except Exception as e:
            logging.error(f"Failed to add assets to album: {e}")
            return False

    def sync_input_images(self, input_folder: str) -> List[Dict[str, Any]]:
        """Sync images from input album

        Returns:
            List[Dict]: List of asset dictionaries with asset_id, file_path, and original_filename
        """
        downloaded_assets = []

        # Get assets from input album
        input_assets = self.get_album_assets(self.input_album_id)
        logging.info(f"Found {len(input_assets)} assets in input album")

        # Create metadata directory
        metadata_dir = os.path.join(input_folder, ".metadata")
        os.makedirs(metadata_dir, exist_ok=True)

        # Get list of already downloaded asset IDs
        existing_metadata_files = set()
        if os.path.exists(metadata_dir):
            existing_metadata_files = {
                f.replace(".json", "")
                for f in os.listdir(metadata_dir)
                if f.endswith(".json")
            }

        # Process each asset
        for asset in input_assets:
            asset_id = asset.get("id")
            if not asset_id:
                continue

            # Skip if we already have this asset
            if asset_id in existing_metadata_files:
                logging.info(f"Skipping existing asset: {asset_id}")

                # Read the existing metadata to get the file path
                try:
                    import json

                    with open(os.path.join(metadata_dir, f"{asset_id}.json"), "r") as f:
                        metadata = json.load(f)

                    downloaded_assets.append(
                        {
                            "asset_id": asset_id,
                            "file_path": metadata.get("file_path", ""),
                            "original_filename": metadata.get("original_filename", ""),
                        }
                    )
                except Exception as e:
                    logging.error(f"Failed to read metadata for {asset_id}: {e}")

                continue

            logging.info(f"Downloading asset {asset_id}")
            success, file_path = self.download_asset(asset_id, input_folder)

            if success and file_path:
                downloaded_assets.append(
                    {
                        "asset_id": asset_id,
                        "file_path": file_path,
                        "original_filename": asset.get("originalFileName", ""),
                    }
                )

        return downloaded_assets

    def upload_processed_images(
        self, output_folder: str, asset_mapping: Dict[str, Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Upload processed images to output album

        Args:
            output_folder (str): Folder containing processed images
            asset_mapping (Dict): Mapping from output files to original asset IDs

        Returns:
            List[Dict]: List of uploaded asset information
        """
        uploaded_assets = []

        for orientation in ["portrait", "landscape"]:
            orientation_dir = os.path.join(output_folder, orientation)
            if not os.path.exists(orientation_dir):
                continue

            for filename in os.listdir(orientation_dir):
                if not filename.lower().endswith((".jpg", ".jpeg", ".png")):
                    continue

                file_path = os.path.join(orientation_dir, filename)

                # Get the original asset ID from the mapping
                asset_id = self._get_asset_id_from_filename(filename, asset_mapping)

                if not asset_id:
                    logging.warning(
                        f"No asset ID found for {filename}, skipping upload"
                    )
                    continue

                try:
                    logging.info(
                        f"Uploading {file_path} to Immich (from asset ID: {asset_id})"
                    )
                    response = self.upload_asset(
                        file_path, self.output_album_id, original_asset_id=asset_id
                    )

                    if response.get("id"):
                        uploaded_assets.append(
                            {
                                "original_asset_id": asset_id,
                                "new_asset_id": response["id"],
                                "file_path": file_path,
                                "orientation": orientation,
                            }
                        )
                except Exception as e:
                    logging.error(f"Failed to upload {filename}: {e}")

        return uploaded_assets

    def upload_from_crop_metadata(self) -> List[Dict[str, Any]]:
        """Upload all cropped images by generating them from metadata on-demand.

        This method reads crop metadata and generates images dynamically instead
        of relying on pre-generated output files in the output folder.

        Returns:
            List[Dict]: List of uploaded asset information
        """
        from utils.file_handler import read_all_crop_metadata
        from utils.image_processor import crop_image
        import config

        uploaded_assets = []

        # Read all crop metadata
        all_crop_data = read_all_crop_metadata()

        if not all_crop_data:
            logging.info("No crop metadata found")
            return uploaded_assets

        # Process each asset that has crop data
        for asset_id, crop_metadata in all_crop_data.items():
            for orientation in ["portrait", "landscape"]:
                if orientation not in crop_metadata:
                    continue

                crop_data = crop_metadata[orientation]

                try:
                    logging.info(f"Generating and uploading {orientation} crop for asset {asset_id}")

                    # Generate the cropped image using existing crop_image function
                    success, error = crop_image(asset_id, orientation, crop_data)

                    if not success:
                        logging.error(f"Failed to generate {orientation} crop for asset {asset_id}: {error}")
                        continue

                    # The crop_image function saves to the config.OUTPUT_FOLDER, so we can upload from there
                    output_filename = f"{asset_id}_{orientation}.jpg"
                    output_path = os.path.join(config.OUTPUT_FOLDER, orientation, output_filename)

                    if not os.path.exists(output_path):
                        logging.error(f"Generated crop file not found: {output_path}")
                        continue

                    # Upload the generated image
                    response = self.upload_asset(
                        output_path, self.output_album_id, original_asset_id=asset_id
                    )

                    if response.get("id"):
                        uploaded_assets.append(
                            {
                                "original_asset_id": asset_id,
                                "new_asset_id": response["id"],
                                "file_path": output_path,
                                "orientation": orientation,
                            }
                        )
                        logging.info(f"Successfully uploaded {orientation} crop for asset {asset_id}")
                    else:
                        logging.error(f"Failed to upload {orientation} crop for asset {asset_id}")

                except Exception as e:
                    logging.error(f"Error processing {orientation} crop for asset {asset_id}: {e}")

        logging.info(f"Successfully uploaded {len(uploaded_assets)} crops from metadata")
        return uploaded_assets

    def _get_asset_id_from_filename(
        self, filename: str, asset_mapping: Dict[str, Dict[str, Any]]
    ) -> str:
        """Extract asset ID from filename based on mapping

        Args:
            filename (str): Processed file name
            asset_mapping (Dict): Mapping from filenames to asset IDs

        Returns:
            str: Asset ID or empty string if not found
        """
        # Direct lookup in the mapping
        if filename in asset_mapping:
            if isinstance(asset_mapping[filename], dict):
                return asset_mapping[filename].get("asset_id", "")
            elif isinstance(asset_mapping[filename], str):
                return asset_mapping[filename]

        # Check if the filename is in asset_id_portrait.ext or asset_id_landscape.ext format
        base_name = (
            filename.rsplit("_", 1)[0] if "_" in filename else filename.split(".")[0]
        )

        # Look through the mapping for this base name
        for key, value in asset_mapping.items():
            if isinstance(value, dict) and value.get("asset_id") == base_name:
                return base_name
            elif value == base_name:
                return base_name

        return ""
