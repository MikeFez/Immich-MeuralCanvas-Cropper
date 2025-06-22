import os
import json
import logging
from config import PROGRESS_FILE, INPUT_FOLDER


# Keep track of processed images
def load_progress():
    """Load progress data from JSON file"""
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, "r") as f:
            return json.load(f)
    return {}


def save_progress(processed_images):
    """Save progress data to JSON file"""
    with open(PROGRESS_FILE, "w") as f:
        json.dump(processed_images, f)


def get_image_list(processed_images):
    """Get list of images with their processing status

    Images are sourced from Immich and stored in INPUT_FOLDER during sync.

    Returns:
        list: List of dictionaries with asset_id, filename, and status
    """
    images = []
    # Check if directory exists first
    if os.path.exists(INPUT_FOLDER):
        # Check if metadata folder exists
        metadata_dir = os.path.join(INPUT_FOLDER, ".metadata")
        if not os.path.exists(metadata_dir):
            # Fallback to old method if no metadata folder exists yet
            for filename in sorted(os.listdir(INPUT_FOLDER)):
                if filename.lower().endswith((".png", ".jpg", ".jpeg")):
                    status = processed_images.get(filename, "unprocessed")
                    images.append({"filename": filename, "status": status})
            return images

        # Load metadata for each image
        for metadata_file in sorted(os.listdir(metadata_dir)):
            if not metadata_file.endswith(".json"):
                continue

            asset_id = metadata_file.replace(".json", "")

            try:
                with open(os.path.join(metadata_dir, metadata_file), "r") as f:
                    metadata = json.load(f)

                filename = os.path.basename(metadata.get("file_path", ""))
                original_filename = metadata.get("original_filename", "")

                if not filename:
                    continue

                # Check if file exists
                file_path = os.path.join(INPUT_FOLDER, filename)
                if not os.path.exists(file_path):
                    continue

                # Get status from processed_images using asset_id as key
                status = processed_images.get(asset_id, "unprocessed")

                images.append(
                    {
                        "asset_id": asset_id,
                        "filename": filename,
                        "original_filename": original_filename,
                        "status": status,
                    }
                )
            except Exception as e:
                logging.error(f"Error loading metadata for {asset_id}: {e}")

    return images


def save_crop_data_json(asset_id, portrait_crop=None, landscape_crop=None):
    """Save crop data to metadata.json file in config directory.

    Args:
        asset_id (str): Immich asset ID
        portrait_crop (dict): Portrait crop data (x, y, width, height)
        landscape_crop (dict): Landscape crop data (x, y, width, height)

    Returns:
        bool: Success status
    """
    try:
        # Create the config crops directory if it doesn't exist
        config_crops_dir = "/config/crops"
        os.makedirs(config_crops_dir, exist_ok=True)

        json_path = os.path.join(config_crops_dir, "metadata.json")

        # Read existing metadata
        metadata = {"crops": {}}
        if os.path.exists(json_path):
            with open(json_path, "r") as f:
                try:
                    metadata = json.load(f)
                except json.JSONDecodeError:
                    metadata = {"crops": {}}

        # Initialize crop data for this asset if it doesn't exist
        if asset_id not in metadata["crops"]:
            metadata["crops"][asset_id] = {}

        # Update with new data
        if portrait_crop:
            metadata["crops"][asset_id]["portrait"] = portrait_crop
        if landscape_crop:
            metadata["crops"][asset_id]["landscape"] = landscape_crop

        # Save the data
        with open(json_path, "w") as f:
            json.dump(metadata, f, indent=2)

        logging.debug(f"Saved crop data to metadata.json for asset {asset_id}")
        return True
    except Exception as e:
        logging.error(f"Error saving crop data to JSON: {str(e)}")
        return False


def read_crop_data_json(asset_id, orientation):
    """Read crop data from metadata.json file.

    Args:
        asset_id (str): Immich asset ID
        orientation (str): Either 'portrait' or 'landscape'

    Returns:
        dict: Crop data with x, y, width, height keys or None if not found
    """
    try:
        json_path = os.path.join("/config/crops", "metadata.json")

        if not os.path.exists(json_path):
            logging.debug("No metadata.json file found")
            return None

        with open(json_path, "r") as f:
            metadata = json.load(f)

        if (
            asset_id in metadata.get("crops", {})
            and orientation in metadata["crops"][asset_id]
        ):
            return metadata["crops"][asset_id][orientation]
        return None
    except Exception as e:
        logging.error(f"Error reading crop data from JSON: {str(e)}")
        return None


def read_all_crop_metadata():
    """Read all crop metadata from metadata.json file.

    Returns:
        dict: All crop metadata organized by asset_id and orientation
    """
    try:
        json_path = os.path.join("/config/crops", "metadata.json")

        if not os.path.exists(json_path):
            logging.debug("No metadata.json file found")
            return {"crops": {}}

        with open(json_path, "r") as f:
            metadata = json.load(f)

        return metadata.get("crops", {})
    except Exception as e:
        logging.error(f"Error reading all crop metadata from JSON: {str(e)}")
        return {"crops": {}}


def get_asset_id_from_filename(filename):
    """Get asset ID from filename.

    This is a helper function for backward compatibility during the transition to asset IDs.
    Checks if filename is an asset ID directly, or looks up metadata.

    Args:
        filename (str): Filename or asset ID

    Returns:
        str: Asset ID if found, None otherwise
    """
    # Check if this is already an asset ID (no extension)
    if "." not in filename:
        return filename

    # Check if metadata is available
    metadata_dir = os.path.join(INPUT_FOLDER, ".metadata")
    if not os.path.exists(metadata_dir):
        return None

    # Try to find metadata file with this filename
    for metadata_file in os.listdir(metadata_dir):
        if not metadata_file.endswith(".json"):
            continue

        try:
            with open(os.path.join(metadata_dir, metadata_file), "r") as f:
                metadata = json.load(f)

            file_path = metadata.get("file_path", "")
            if os.path.basename(file_path) == filename:
                return metadata.get("asset_id")
        except Exception as e:
            logging.error(f"Error reading metadata file {metadata_file}: {e}")

    return None


def get_filename_from_asset_id(asset_id):
    """Get filename from asset ID using metadata.

    Args:
        asset_id (str): Immich asset ID

    Returns:
        str: Filename if found, None otherwise
    """
    metadata_file = os.path.join(INPUT_FOLDER, ".metadata", f"{asset_id}.json")

    if not os.path.exists(metadata_file):
        return None

    try:
        with open(metadata_file, "r") as f:
            metadata = json.load(f)

        file_path = metadata.get("file_path", "")
        return os.path.basename(file_path) if file_path else None
    except Exception as e:
        logging.error(f"Error reading metadata for asset ID {asset_id}: {e}")
        return None


def get_asset_mapping():
    """Get mapping between asset IDs and filenames.

    Returns:
        dict: Dictionary mapping asset IDs to filenames and vice versa
    """
    mapping = {"asset_to_file": {}, "file_to_asset": {}}

    metadata_dir = os.path.join(INPUT_FOLDER, ".metadata")
    if not os.path.exists(metadata_dir):
        return mapping

    for metadata_file in os.listdir(metadata_dir):
        if not metadata_file.endswith(".json"):
            continue

        asset_id = metadata_file.replace(".json", "")

        try:
            with open(os.path.join(metadata_dir, metadata_file), "r") as f:
                metadata = json.load(f)

            file_path = metadata.get("file_path", "")
            if file_path:
                filename = os.path.basename(file_path)
                mapping["asset_to_file"][asset_id] = filename
                mapping["file_to_asset"][filename] = asset_id
        except Exception as e:
            logging.error(f"Error reading metadata for {asset_id}: {e}")

    return mapping
