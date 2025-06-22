import os
import logging
import piexif
from PIL import Image
from config import INPUT_FOLDER, OUTPUT_FOLDER, PORTRAIT_SIZE, LANDSCAPE_SIZE
from utils.file_handler import get_filename_from_asset_id


def crop_image(asset_id, orientation, crop_data):
    """Crop and resize image according to the specified parameters

    Args:
        asset_id (str): Immich asset ID
        orientation (str): Either 'portrait' or 'landscape'
        crop_data (dict): Dict with x, y, width, height keys

    Returns:
        tuple: (success, error_message)
    """
    try:
        # Get filename from asset ID
        filename = get_filename_from_asset_id(asset_id)
        if not filename:
            return False, f"Cannot find file for asset ID: {asset_id}"

        # Open the image
        img_path = os.path.join(INPUT_FOLDER, filename)
        if not os.path.exists(img_path):
            return False, f"Image file not found: {img_path}"

        img = Image.open(img_path)

        # Extract crop coordinates
        x = int(crop_data["x"])
        y = int(crop_data["y"])
        width = int(crop_data["width"])
        height = int(crop_data["height"])

        # Ensure crop coordinates are within image bounds
        x = max(0, min(x, img.width - 1))
        y = max(0, min(y, img.height - 1))
        width = min(width, img.width - x)
        height = min(height, img.height - y)

        # Crop the image
        cropped_img = img.crop((x, y, x + width, y + height))

        # Get target dimensions based on orientation
        target_size = PORTRAIT_SIZE if orientation == "portrait" else LANDSCAPE_SIZE
        target_width, target_height = target_size

        # Calculate resize dimensions to maintain aspect ratio
        ratio = min(
            target_width / cropped_img.width, target_height / cropped_img.height
        )
        new_width = int(cropped_img.width * ratio)
        new_height = int(cropped_img.height * ratio)

        # Resize the image
        resized_img = cropped_img.resize((new_width, new_height), Image.LANCZOS)

        # Create a new image with the correct size and paste the resized image centered
        output_img = Image.new("RGB", target_size, (0, 0, 0))
        paste_x = (target_width - new_width) // 2
        paste_y = (target_height - new_height) // 2
        output_img.paste(resized_img, (paste_x, paste_y))

        # Create minimal EXIF data with normal orientation
        exif_dict = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}
        exif_dict["0th"][piexif.ImageIFD.Orientation] = 1  # Normal orientation
        exif_bytes = piexif.dump(exif_dict)

        # Save to output folder with EXIF data
        output_filename = f"{asset_id}_{orientation}.jpg"
        output_dir = os.path.join(OUTPUT_FOLDER, orientation)

        # Create output directory if it doesn't exist
        os.makedirs(output_dir, exist_ok=True)

        output_path = os.path.join(output_dir, output_filename)
        output_img.save(output_path, exif=exif_bytes)

        return True, None

    except Exception as e:
        logging.error(f"Error processing image: {str(e)}")
        return False, str(e)
