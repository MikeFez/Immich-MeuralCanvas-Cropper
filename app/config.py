import os
import yaml


CONFIG_DIR = os.environ.get(
    "CONFIG_DIR",
    "/config" if os.path.isdir("/config") else
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "config"),
)


# Load config
def load_config():
    config_paths = [
        os.path.join(CONFIG_DIR, "config.yaml"),
        os.path.join(
            os.path.dirname(__file__), "config", "config.yaml"
        ),  # Local development
    ]

    for config_path in config_paths:
        if os.path.exists(config_path):
            with open(config_path, "r") as f:
                return yaml.safe_load(f)

    raise ValueError(f"config.yaml not found in: {', '.join(config_paths)}")


config = load_config()

# Disposable cache of source images and thumbnails, rebuilt by Sync. It lives
# under CONFIG_DIR by default so a single /config mount persists everything.
# APP_TMP_DIR is the former name of CACHE_DIR.
CACHE_DIR = os.environ.get("CACHE_DIR") or os.environ.get("APP_TMP_DIR") or os.path.join(CONFIG_DIR, "cache")
INPUT_FOLDER = os.path.join(CACHE_DIR, "input")
THUMBNAIL_FOLDER = os.path.join(CACHE_DIR, "thumbnails")
# Image dimensions
PORTRAIT_SIZE = tuple(config["dimensions"]["portrait_size"])  # (width, height)
LANDSCAPE_SIZE = tuple(config["dimensions"]["landscape_size"])  # (width, height)
SIZES = {"portrait": PORTRAIT_SIZE, "landscape": LANDSCAPE_SIZE}
ORIENTATIONS = tuple(SIZES)

# Immich configuration
IMMICH_URL = config["immich"]["url"]
IMMICH_API_KEY = config["immich"]["api_key"]
IMMICH_INPUT_ALBUM_ID = config["immich"]["input_album_id"]
IMMICH_OUTPUT_ALBUM_ID = config["immich"]["output_album_id"]

# Meural configuration
MEURAL_DEVICES = config.get("meural", {}).get("devices", [])

# File paths
CROP_METADATA_FILE = os.path.join(CONFIG_DIR, "crops", "metadata.json")
# Superseded by upload records in CROP_METADATA_FILE; read once for migration.
LEGACY_PROGRESS_FILE = os.path.join(CONFIG_DIR, "progress.json")


# Ensure required directories exist
def init_directories():
    """Create necessary directories if they don't exist"""
    for directory in (CONFIG_DIR, INPUT_FOLDER, THUMBNAIL_FOLDER):
        os.makedirs(directory, exist_ok=True)
