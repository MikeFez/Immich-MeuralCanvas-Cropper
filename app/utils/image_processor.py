"""One orientation-aware JPEG pipeline for uploads, previews and thumbnails."""
import io
import logging
import math
import os
import tempfile

import piexif
from PIL import Image, ImageCms, ImageOps
from pillow_heif import register_heif_opener

register_heif_opener()
JPEG_QUALITY = 95
CROP_KEYS = ('x', 'y', 'width', 'height')


def validate_crop(crop_data, image_size=None):
    """Raise ValueError unless crop_data is finite, positive and (if given) starts inside image_size."""
    if not isinstance(crop_data, dict) or not all(
        isinstance(crop_data.get(key), (int, float)) and
        not isinstance(crop_data[key], bool) and math.isfinite(crop_data[key])
        for key in CROP_KEYS
    ):
        raise ValueError('Invalid crop coordinates')
    x, y, width, height = (crop_data[key] for key in CROP_KEYS)
    if x < 0 or y < 0 or width < 1 or height < 1:
        raise ValueError('Invalid crop coordinates')
    if image_size and (x >= image_size[0] or y >= image_size[1]):
        raise ValueError('Crop must lie within the upright image')


def upright_size(image_path):
    """Image dimensions after EXIF rotation, without decoding pixels."""
    with Image.open(image_path) as image:
        width, height = image.size
        if image.getexif().get(274) in (5, 6, 7, 8):
            width, height = height, width
    return width, height


def render_image(image_path, crop_data=None, target_size=None, max_size=None, metadata=True):
    """Return JPEG bytes in upright coordinates, preserving EXIF and color data."""
    with Image.open(image_path) as source:
        source.load()
        original_exif = source.info.get('exif')
        profile = source.info.get('icc_profile')
        image = ImageOps.exif_transpose(source)
        # RGB profiles remain valid after RGB resizing. Convert CMYK/LAB pixels
        # through their source profile instead of attaching it to RGB pixels.
        if profile and image.mode in ('CMYK', 'LAB'):
            srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB'))
            image = ImageCms.profileToProfile(
                image, ImageCms.ImageCmsProfile(io.BytesIO(profile)), srgb, outputMode='RGB'
            )
            profile = srgb.tobytes()
        elif image.mode != 'RGB':
            image = image.convert('RGB')

        if crop_data is not None:
            validate_crop(crop_data, image.size)
            x, y, width, height = (crop_data[key] for key in CROP_KEYS)
            left, top = int(x), int(y)
            right = min(image.width, max(left + 1, round(x + width)))
            bottom = min(image.height, max(top + 1, round(y + height)))
            image = image.crop((left, top, right, bottom))
        if target_size:
            image = ImageOps.pad(image, target_size, method=Image.Resampling.LANCZOS, color='black')
        if max_size:
            image.thumbnail(max_size, Image.Resampling.LANCZOS)

        options = {'quality': JPEG_QUALITY, 'subsampling': 0, 'optimize': True}
        if profile:
            options['icc_profile'] = profile
        if metadata:
            exif = {'0th': {}, 'Exif': {}, 'GPS': {}, '1st': {}, 'thumbnail': None}
            if original_exif:
                try:
                    exif = piexif.load(original_exif)
                except (ValueError, TypeError, piexif.InvalidImageDataError):
                    logging.warning('Ignoring malformed EXIF in %s', image_path)
            # Keep dates, camera information and GPS, but discard the stale
            # embedded thumbnail and correct dimensions/orientation after cropping.
            exif['0th'][piexif.ImageIFD.Orientation] = 1
            exif['0th'][piexif.ImageIFD.ImageWidth] = image.width
            exif['0th'][piexif.ImageIFD.ImageLength] = image.height
            exif['Exif'][piexif.ExifIFD.PixelXDimension] = image.width
            exif['Exif'][piexif.ExifIFD.PixelYDimension] = image.height
            exif['1st'], exif['thumbnail'] = {}, None
            options['exif'] = piexif.dump(exif)
        buffer = io.BytesIO()
        image.save(buffer, format='JPEG', **options)
        return buffer.getvalue()


def write_image_atomic(path, content):
    """Publish complete image bytes so concurrent readers never see partial files."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=os.path.dirname(path), delete=False) as f:
            temp_path = f.name
            f.write(content)
        os.replace(temp_path, path)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)

