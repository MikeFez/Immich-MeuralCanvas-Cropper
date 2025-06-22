import os
import logging
import requests
import time
import json
import threading
from flask import Flask, render_template, request, jsonify, send_from_directory
from datetime import datetime

# Import from our modules
import config
from utils.immich_handler import ImmichHandler
from utils.file_handler import (
    load_progress,
    save_progress,
    get_image_list,
    save_crop_data_json,
    read_crop_data_json,
    read_all_crop_metadata,
    get_asset_id_from_filename,
    get_filename_from_asset_id,
    get_asset_mapping,
)
from utils.image_processor import crop_image
from utils.meural_handler import MeuralHandler

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)

# Initialize temporary directories
logging.info("Initializing temporary directories")
config.init_directories()

# Initialize Flask app with static folder
app = Flask(__name__, static_url_path="/static", static_folder="static")

# Initialize Immich handler and verify connection
logging.info(f"Initializing connection to Immich at {config.IMMICH_URL}")
immich_handler = ImmichHandler()
meural_handler = MeuralHandler(config.MEURAL_DEVICES)

# Global sync state
sync_lock = threading.Lock()
# Global asset mapping
asset_mapping = {}


def acquire_sync_lock():
    """Try to acquire sync lock"""
    if not sync_lock.acquire(blocking=False):
        logging.info("Sync blocked - another sync in progress")
        return False
    return True


# Verify Immich connection by making a test request
try:
    # Validate connection to Immich
    ping_response = requests.get(
        f"{config.IMMICH_URL}/api/server/ping", headers=immich_handler.headers
    )
    ping_response.raise_for_status()
    if ping_response.json().get("res") != "pong":
        raise Exception("Invalid server response")
    logging.info("Successfully connected to Immich server")

    # Load progress
    processed_images = load_progress()

    # Check destination album to mark already-uploaded images as completed
    try:
        dest_assets = immich_handler.get_album_assets(immich_handler.output_album_id)
        dest_filenames = set()

        # Load asset mapping
        asset_mapping = get_asset_mapping()

        # Extract original filenames and look for our naming patterns
        for asset in dest_assets:
            # For new asset ID based files
            asset_id = asset.get("id", "")
            filename = asset.get("originalFileName", "")

            # Look for our naming patterns - using the asset ID in the filename
            if "_portrait." in filename or "_landscape." in filename:
                # Extract the original asset ID
                base_name = filename.split("_")[0]  # Asset ID part

                # Mark the original file as completed if it exists
                if base_name in asset_mapping["asset_to_file"]:
                    processed_images[base_name] = "completed"
                    logging.info(
                        f"Marked asset ID {base_name} as completed (found in destination album)"
                    )

        # Save updated progress
        save_progress(processed_images)
        logging.info(
            f"Checked destination album - marked {len([v for v in processed_images.values() if v == 'completed'])} images as completed"
        )
    except Exception as e:
        logging.error(f"Error checking destination album status: {e}")

    # Test album access
    album_test = immich_handler._make_request(
        "GET", f"/albums/{config.IMMICH_INPUT_ALBUM_ID}"
    )
    logging.info(
        f"Successfully accessed input album: {album_test.get('albumName', 'unknown')}"
    )

    logging.info(
        f"Performing initial sync with Immich input album: {config.IMMICH_INPUT_ALBUM_ID}"
    )
    downloaded_assets = immich_handler.sync_input_images(config.INPUT_FOLDER)
    logging.info(f"Initial sync complete. Downloaded {len(downloaded_assets)} files")

except Exception as e:
    logging.error(f"Initial Immich connection/sync failed: {e}")
    processed_images = load_progress()  # Still load progress even if sync fails


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/dimensions")
def get_dimensions():
    """Get image dimensions from config"""
    return jsonify(
        {
            "portrait": {
                "width": config.PORTRAIT_SIZE[0],
                "height": config.PORTRAIT_SIZE[1],
            },
            "landscape": {
                "width": config.LANDSCAPE_SIZE[0],
                "height": config.LANDSCAPE_SIZE[1],
            },
        }
    )


@app.route("/images")
def get_images():
    request_id = f"images-{time.time()}"
    try:
        images = get_image_list(processed_images)
        return jsonify(images)
    except Exception as e:
        return jsonify({"error": str(e), "request_id": request_id}), 500


@app.route("/image/<path:identifier>")
def get_image(identifier):
    # Handle both asset IDs and filenames
    if "." not in identifier:  # Looks like an asset ID
        filename = get_filename_from_asset_id(identifier)
        if not filename:
            return (
                jsonify({"error": f"Image not found for asset ID: {identifier}"}),
                404,
            )
    else:
        filename = identifier

    # Added request tracking
    logging.debug("Image requested: %s from %s", filename, request.remote_addr)
    return send_from_directory(config.INPUT_FOLDER, filename)


@app.route("/output/<orientation>/<path:identifier>")
def get_output_image(orientation, identifier):
    if orientation not in ["portrait", "landscape"]:
        return jsonify({"error": "Invalid orientation"}), 400

    # For asset IDs, construct the correct output filename
    if "." not in identifier:  # Looks like an asset ID
        output_filename = f"{identifier}_{orientation}.jpg"
    else:
        # Handle legacy files or special cases
        output_filename = identifier

    # Added request tracking
    logging.debug(
        "Output image requested: %s/%s from %s",
        orientation,
        output_filename,
        request.remote_addr,
    )

    return send_from_directory(
        os.path.join(config.OUTPUT_FOLDER, orientation), output_filename
    )


@app.route("/crop", methods=["POST"])
def handle_crop():
    request_id = f"crop-{time.time()}"
    logging.info("Crop request received [%s] from %s", request_id, request.remote_addr)

    try:
        data = request.json
        identifier = data["identifier"]  # Can be asset_id or filename
        orientation = data["orientation"]
        crop_data = data["crop"]

        # Convert filename to asset_id if needed
        asset_id = identifier
        if "." in identifier:  # This is a filename
            asset_id = get_asset_id_from_filename(identifier)
            if not asset_id:
                return (
                    jsonify(
                        {
                            "success": False,
                            "error": f"Cannot find asset ID for filename: {identifier}",
                            "request_id": request_id,
                        }
                    ),
                    400,
                )

        logging.info(
            "Cropping asset ID %s as %s with data: %s [%s]",
            asset_id,
            orientation,
            crop_data,
            request_id,
        )

        # Save crop data to JSON with asset_id
        if orientation == "portrait":
            save_crop_data_json(asset_id, portrait_crop=crop_data)
        else:
            save_crop_data_json(asset_id, landscape_crop=crop_data)

        success, error = crop_image(asset_id, orientation, crop_data)

        if success:
            # Update status using asset_id as the key
            if orientation == "portrait":
                if processed_images.get(asset_id) == "landscape":
                    processed_images[asset_id] = "both"
                else:
                    processed_images[asset_id] = "portrait"
            else:
                if processed_images.get(asset_id) == "portrait":
                    processed_images[asset_id] = "both"
                else:
                    processed_images[asset_id] = "landscape"

            save_progress(processed_images)
            logging.info("Crop successful [%s]", request_id)
            return jsonify(
                {"success": True, "request_id": request_id, "timestamp": time.time()}
            )
        else:
            logging.error("Crop failed [%s]: %s", request_id, error)
            return (
                jsonify(
                    {
                        "success": False,
                        "error": error,
                        "request_id": request_id,
                        "timestamp": time.time(),
                    }
                ),
                500,
            )
    except Exception as e:
        logging.error("Error processing crop request [%s]: %s", request_id, str(e))
        return (
            jsonify(
                {
                    "success": False,
                    "error": str(e),
                    "request_id": request_id,
                    "timestamp": time.time(),
                }
            ),
            500,
        )


@app.route("/sync", methods=["POST"])
def sync_with_immich():
    """Sync images from Immich input album with proper locking"""
    request_id = f"sync-{time.time()}"

    logging.info("Sync request received [%s] from %s", request_id, request.remote_addr)

    try:
        if not acquire_sync_lock():
            logging.info("Sync declined - lock could not be acquired [%s]", request_id)
            return jsonify(
                {
                    "success": True,
                    "message": "Sync already in progress",
                    "files": [],
                    "request_id": request_id,
                    "timestamp": time.time(),
                }
            )

        try:
            # Get files and current image list in one operation
            downloaded_assets = immich_handler.sync_input_images(config.INPUT_FOLDER)

            # Refresh asset mapping after download
            global asset_mapping
            asset_mapping = get_asset_mapping()

            # Get current images with updated mapping
            current_images = get_image_list(processed_images)

            return jsonify(
                {
                    "success": True,
                    "files": downloaded_assets,
                    "images": current_images,
                    "request_id": request_id,
                    "timestamp": time.time(),
                }
            )
        finally:
            logging.info("Releasing sync lock [%s]", request_id)
            sync_lock.release()

    except Exception as e:
        logging.error("Failed to sync with Immich [%s]: %s", request_id, str(e))
        if sync_lock.locked():
            logging.info("Releasing sync lock after error [%s]", request_id)
            sync_lock.release()
        return (
            jsonify(
                {
                    "success": False,
                    "error": str(e),
                    "request_id": request_id,
                    "timestamp": time.time(),
                }
            ),
            500,
        )


@app.route("/complete", methods=["POST"])
def complete_image():
    request_id = f"complete-{time.time()}"
    logging.info(
        "Complete image request received [%s] from %s", request_id, request.remote_addr
    )

    try:
        data = request.json
        identifier = data["identifier"]  # Can be asset_id or filename

        # Convert filename to asset_id if needed
        asset_id = identifier
        if "." in identifier:  # This is a filename
            asset_id = get_asset_id_from_filename(identifier)
            if not asset_id:
                return (
                    jsonify(
                        {
                            "success": False,
                            "error": f"Cannot find asset ID for filename: {identifier}",
                            "request_id": request_id,
                        }
                    ),
                    400,
                )

        logging.info("Completing asset ID %s [%s]", asset_id, request_id)

        # Determine output filenames based on asset ID
        portrait_filename = f"{asset_id}_portrait.jpg"
        landscape_filename = f"{asset_id}_landscape.jpg"

        portrait_path = os.path.join(
            config.OUTPUT_FOLDER, "portrait", portrait_filename
        )
        landscape_path = os.path.join(
            config.OUTPUT_FOLDER, "landscape", landscape_filename
        )

        uploaded_files = []
        if os.path.exists(portrait_path):
            response = immich_handler.upload_asset(
                portrait_path,
                immich_handler.output_album_id,
                original_asset_id=asset_id,
            )
            if response.get("id"):
                uploaded_files.append(
                    {
                        "filename": portrait_filename,
                        "asset_id": response.get("id"),
                        "original_asset_id": asset_id,
                        "orientation": "portrait",
                    }
                )

        if os.path.exists(landscape_path):
            response = immich_handler.upload_asset(
                landscape_path,
                immich_handler.output_album_id,
                original_asset_id=asset_id,
            )
            if response.get("id"):
                uploaded_files.append(
                    {
                        "filename": landscape_filename,
                        "asset_id": response.get("id"),
                        "original_asset_id": asset_id,
                        "orientation": "landscape",
                    }
                )

        # Update local status using asset_id as key
        processed_images[asset_id] = "completed"
        save_progress(processed_images)

        logging.info(
            "Image completed successfully [%s], uploaded %d files",
            request_id,
            len(uploaded_files),
        )

        return jsonify(
            {
                "success": True,
                "uploaded_files": uploaded_files,
                "request_id": request_id,
                "timestamp": time.time(),
            }
        )
    except Exception as e:
        logging.error("Failed to complete image [%s]: %s", request_id, str(e))
        return (
            jsonify(
                {
                    "success": False,
                    "error": str(e),
                    "request_id": request_id,
                    "timestamp": time.time(),
                }
            ),
            500,
        )


@app.route("/crop-data/<path:identifier>/<orientation>", methods=["GET"])
def get_crop_data(identifier, orientation):
    """Get crop coordinates for an image."""
    request_id = f"crop-data-{time.time()}"
    logging.info(
        "Crop data request received [%s] from %s", request_id, request.remote_addr
    )

    try:
        # Convert filename to asset_id if needed
        asset_id = identifier
        if "." in identifier:  # This is a filename
            asset_id = get_asset_id_from_filename(identifier)
            if not asset_id:
                return (
                    jsonify(
                        {
                            "success": False,
                            "message": f"Cannot find asset ID for filename: {identifier}",
                            "request_id": request_id,
                        }
                    ),
                    400,
                )

        # Get crop data from JSON using asset_id
        crop_data = read_crop_data_json(asset_id, orientation)

        if crop_data:
            return jsonify(
                {
                    "success": True,
                    "crop": crop_data,
                    "request_id": request_id,
                    "timestamp": time.time(),
                }
            )
        else:
            return jsonify(
                {
                    "success": False,
                    "message": "No saved crop data found",
                    "request_id": request_id,
                    "timestamp": time.time(),
                }
            )
    except Exception as e:
        logging.error("Error retrieving crop data [%s]: %s", request_id, str(e))
        return (
            jsonify(
                {
                    "success": False,
                    "error": str(e),
                    "request_id": request_id,
                    "timestamp": time.time(),
                }
            ),
            500,
        )


@app.route("/crop-data/<path:identifier>/<orientation>", methods=["DELETE"])
def delete_crop_data(identifier, orientation):
    """Delete crop data for a specific orientation."""
    request_id = f"delete-crop-{time.time()}"
    logging.info(
        "Delete crop data request received [%s] from %s for %s %s",
        request_id, request.remote_addr, identifier, orientation
    )

    try:
        # Convert filename to asset_id if needed
        asset_id = identifier
        if "." in identifier:  # This is a filename
            asset_id = get_asset_id_from_filename(identifier)
            if not asset_id:
                return (
                    jsonify(
                        {
                            "success": False,
                            "message": f"Cannot find asset ID for filename: {identifier}",
                            "request_id": request_id,
                        }
                    ),
                    400,
                )

        # Delete associated output file if it exists
        output_filename = f"{asset_id}_{orientation}.jpg"
        output_path = os.path.join(config.OUTPUT_FOLDER, orientation, output_filename)

        if os.path.exists(output_path):
            try:
                os.remove(output_path)
                logging.info("Deleted output file: %s [%s]", output_path, request_id)
            except Exception as e:
                logging.warning("Failed to delete output file %s: %s [%s]", output_path, str(e), request_id)

        # Delete crop metadata for this specific orientation
        metadata_path = os.path.join("/config/crops", "metadata.json")
        if os.path.exists(metadata_path):
            try:
                with open(metadata_path, "r") as f:
                    metadata = json.load(f)

                # Check if asset exists and has the orientation
                if (asset_id in metadata.get("crops", {}) and
                    orientation in metadata["crops"][asset_id]):

                    # Delete the specific orientation
                    del metadata["crops"][asset_id][orientation]

                    # If no orientations left for this asset, delete the asset entry
                    if not metadata["crops"][asset_id]:
                        del metadata["crops"][asset_id]

                    # Save updated metadata
                    with open(metadata_path, "w") as f:
                        json.dump(metadata, f, indent=2)

                    # Update processed_images status
                    processed_images = load_progress()
                    if asset_id in processed_images:
                        current_status = processed_images[asset_id]

                        if current_status == "both":
                            # If was both, set to the remaining orientation
                            remaining_orientation = "landscape" if orientation == "portrait" else "portrait"
                            processed_images[asset_id] = remaining_orientation
                        elif current_status == orientation:
                            # If was only this orientation, mark as unprocessed
                            del processed_images[asset_id]
                        # If current_status is the other orientation, leave it alone

                        save_progress(processed_images)

                    logging.info(
                        "Deleted %s crop data for asset %s [%s]",
                        orientation, asset_id, request_id
                    )

                    return jsonify(
                        {
                            "success": True,
                            "message": f"Deleted {orientation} crop data and output file",
                            "request_id": request_id,
                            "timestamp": time.time()
                        }
                    )
                else:
                    return jsonify(
                        {
                            "success": True,  # Not an error if data doesn't exist
                            "message": f"No {orientation} crop data found to delete",
                            "request_id": request_id,
                            "timestamp": time.time(),
                        }
                    )

            except Exception as e:
                logging.error(
                    "Error updating metadata.json: %s [%s]", str(e), request_id
                )
                return (
                    jsonify(
                        {
                            "success": False,
                            "error": f"Failed to update metadata: {str(e)}",
                            "request_id": request_id,
                            "timestamp": time.time(),
                        }
                    ),
                    500,
                )
        else:
            return jsonify(
                {
                    "success": True,  # Not an error if file doesn't exist
                    "message": "No metadata file found",
                    "request_id": request_id,
                    "timestamp": time.time(),
                }
            )

    except Exception as e:
        logging.error("Error deleting crop data [%s]: %s", request_id, str(e))
        return (
            jsonify(
                {
                    "success": False,
                    "error": str(e),
                    "request_id": request_id,
                    "timestamp": time.time(),
                }
            ),
            500,
        )


@app.route("/upload-all", methods=["POST"])
def upload_all_processed():
    """Upload all processed images to Immich output album by generating them from metadata"""
    request_id = f"upload-all-{time.time()}"
    logging.info(
        "Upload all request received [%s] from %s", request_id, request.remote_addr
    )

    try:
        # Upload using crop metadata (generates images on-demand)
        uploaded_assets = immich_handler.upload_from_crop_metadata()

        logging.info(
            "Upload all completed [%s], uploaded %d files",
            request_id,
            len(uploaded_assets),
        )

        # Mark all uploaded assets as completed
        for asset in uploaded_assets:
            original_asset_id = asset.get("original_asset_id")
            if original_asset_id:
                processed_images[original_asset_id] = "completed"

        save_progress(processed_images)

        return jsonify(
            {
                "success": True,
                "uploaded_assets": uploaded_assets,
                "request_id": request_id,
                "timestamp": time.time(),
            }
        )
    except Exception as e:
        logging.error("Failed to upload all images [%s]: %s", request_id, str(e))
        return (
            jsonify(
                {
                    "success": False,
                    "error": str(e),
                    "request_id": request_id,
                    "timestamp": time.time(),
                }
            ),
            500,
        )


@app.route("/reset", methods=["POST"])
def reset_image():
    request_id = f"reset-{time.time()}"
    logging.info(
        "Reset image request received [%s] from %s", request_id, request.remote_addr
    )

    try:
        data = request.json
        identifier = data["identifier"]  # Can be asset_id or filename

        # Convert filename to asset_id if needed
        asset_id = identifier
        if "." in identifier:  # This is a filename
            asset_id = get_asset_id_from_filename(identifier)
            if not asset_id:
                return (
                    jsonify(
                        {
                            "success": False,
                            "error": f"Cannot find asset ID for filename: {identifier}",
                            "request_id": request_id,
                        }
                    ),
                    400,
                )

        logging.info("Resetting asset ID %s [%s]", asset_id, request_id)

        # Remove from processed list using asset_id as key
        if asset_id in processed_images:
            del processed_images[asset_id]
            save_progress(processed_images)

        # Delete output files if they exist - using asset ID in filename
        portrait_filename = f"{asset_id}_portrait.jpg"
        landscape_filename = f"{asset_id}_landscape.jpg"

        portrait_path = os.path.join(
            config.OUTPUT_FOLDER, "portrait", portrait_filename
        )
        landscape_path = os.path.join(
            config.OUTPUT_FOLDER, "landscape", landscape_filename
        )

        if os.path.exists(portrait_path):
            os.remove(portrait_path)
            logging.info("Deleted portrait file: %s [%s]", portrait_path, request_id)

        if os.path.exists(landscape_path):
            os.remove(landscape_path)
            logging.info("Deleted landscape file: %s [%s]", landscape_path, request_id)

        # Remove crop data for this asset from metadata.json
        metadata_path = os.path.join("/config/crops", "metadata.json")
        if os.path.exists(metadata_path):
            try:
                with open(metadata_path, "r") as f:
                    metadata = json.load(f)
                if asset_id in metadata.get("crops", {}):
                    del metadata["crops"][asset_id]
                    with open(metadata_path, "w") as f:
                        json.dump(metadata, f, indent=2)
                    logging.info(
                        "Deleted crop data for asset %s [%s]", asset_id, request_id
                    )
            except Exception as e:
                logging.error(
                    "Error updating metadata.json: %s [%s]", str(e), request_id
                )

        logging.info("Reset image completed successfully [%s]", request_id)
        return jsonify(
            {"success": True, "request_id": request_id, "timestamp": time.time()}
        )
    except Exception as e:
        logging.error("Failed to reset image [%s]: %s", request_id, str(e))
        return (
            jsonify(
                {
                    "success": False,
                    "error": str(e),
                    "request_id": request_id,
                    "timestamp": time.time(),
                }
            ),
            500,
        )


@app.route("/meural/devices", methods=["GET"])
def get_meural_devices():
    """Get list of configured Meural devices"""
    devices = meural_handler.get_device_list()
    return jsonify({"devices": devices})


@app.route("/meural/preview", methods=["POST"])
def preview_on_meural():
    """Preview an image on a Meural Canvas"""
    request_id = f"meural-preview-{time.time()}"
    logging.info(
        "Meural preview request received [%s] from %s", request_id, request.remote_addr
    )
    logging.info("Request data: %s", request.get_data(as_text=True))

    try:
        data = request.json
        device_ip = data.get("device_ip")
        identifier = data.get("identifier")  # Can be asset_id or filename
        orientation = data.get("orientation")  # 'portrait' or 'landscape'
        use_temp = data.get("use_temp", False)  # Whether to use temporary crop
        crop_data = data.get("crop")  # Only used if use_temp is True

        logging.info("Preview request data: %s", data)

        if not device_ip:
            return jsonify({"success": False, "message": "Device IP is required"}), 400

        if not identifier:
            return (
                jsonify({"success": False, "message": "Image identifier is required"}),
                400,
            )

        if not orientation:
            return (
                jsonify({"success": False, "message": "Orientation is required"}),
                400,
            )

        # Convert filename to asset_id if needed
        asset_id = identifier
        if "." in identifier:  # This is a filename
            asset_id = get_asset_id_from_filename(identifier)
            if not asset_id:
                return (
                    jsonify(
                        {
                            "success": False,
                            "message": f"Cannot find asset ID for filename: {identifier}",
                            "request_id": request_id,
                        }
                    ),
                    400,
                )

        # Get the filename from asset ID to locate the file
        filename = get_filename_from_asset_id(asset_id)
        if not filename:
            return (
                jsonify(
                    {
                        "success": False,
                        "message": f"Cannot find file for asset ID: {asset_id}",
                        "request_id": request_id,
                    }
                ),
                404,
            )

        # Get the original image path
        input_path = os.path.join(config.INPUT_FOLDER, filename)

        # Log the input path and check if it exists
        logging.info("Input image path: %s", input_path)
        logging.info("Input image exists: %s", os.path.exists(input_path))

        # When use_temp is True, we should use the original image with crop data
        if use_temp and crop_data:
            logging.info("Using original image with crop data: %s", crop_data)

            # Validate crop data
            if not all(k in crop_data for k in ["x", "y", "width", "height"]):
                logging.error("Invalid crop data: %s", crop_data)
                return (
                    jsonify(
                        {
                            "success": False,
                            "message": f"Invalid crop data. Must contain x, y, width, height",
                        }
                    ),
                    400,
                )

            # Send preview to Meural with crop data
            result = meural_handler.preview_image(device_ip, input_path, crop_data)
        else:
            # Path to the pre-cropped output file using asset ID
            output_filename = f"{asset_id}_{orientation}.jpg"
            output_path = os.path.join(
                config.OUTPUT_FOLDER, orientation, output_filename
            )
            logging.info("Output image path: %s", output_path)
            logging.info("Output image exists: %s", os.path.exists(output_path))

            if not os.path.exists(output_path):
                return (
                    jsonify(
                        {"success": False, "message": f"Image not found: {output_path}"}
                    ),
                    404,
                )

            # Send preview to Meural with no crop data (already cropped file)
            result = meural_handler.preview_image(device_ip, output_path)

        logging.info("Preview result: %s", result)

        if result["success"]:
            logging.info(f"Preview successful [%s]: {result['message']}", request_id)
            return jsonify(
                {
                    "success": True,
                    "message": result["message"],
                    "preview_duration": result.get("preview_duration", 30),
                    "request_id": request_id,
                    "timestamp": time.time(),
                }
            )
        else:
            logging.error(f"Preview failed [%s]: {result['message']}", request_id)
            return (
                jsonify(
                    {
                        "success": False,
                        "message": result["message"],
                        "request_id": request_id,
                        "timestamp": time.time(),
                    }
                ),
                500,
            )

    except Exception as e:
        logging.error(f"Error previewing on Meural [%s]: {str(e)}", request_id)
        import traceback

        logging.error("Traceback: %s", traceback.format_exc())
        return (
            jsonify(
                {
                    "success": False,
                    "message": f"Error: {str(e)}",
                    "request_id": request_id,
                    "timestamp": time.time(),
                }
            ),
            500,
        )


if __name__ == "__main__":
    logging.info("Starting Meural Canvas Image Cropper")
    logging.info(f"Attempting to connect to Immich at: {config.IMMICH_URL}")
    logging.info(f"Using temporary directory: {config.APP_TMP_DIR}")

    # Respect environment variables for debug mode
    debug_mode = os.getenv('FLASK_DEBUG', '0').lower() in ('1', 'true', 'yes', 'on')

    # Configure Flask for small-scale production use
    if not debug_mode:
        # Suppress the development server warning for self-hosted deployments
        import logging as flask_logging
        werkzeug_logger = flask_logging.getLogger('werkzeug')
        werkzeug_logger.setLevel(flask_logging.ERROR)

    # Handle startup errors and continue running the web app
    app.run(host="0.0.0.0", port=5000, debug=debug_mode, threaded=True)
