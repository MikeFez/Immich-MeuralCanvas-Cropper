import copy
import os
import re
import tempfile
from urllib.parse import urlparse

import yaml


CONFIG_DIR = os.environ.get(
    "CONFIG_DIR",
    "/config" if os.path.isdir("/config") else
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "config"),
)
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.yaml")

# Disposable cache of source images and thumbnails, rebuilt by Sync. It lives
# under CONFIG_DIR by default so a single /config mount persists everything.
# APP_TMP_DIR is the former name of CACHE_DIR.
CACHE_DIR = os.environ.get("CACHE_DIR") or os.environ.get("APP_TMP_DIR") or os.path.join(CONFIG_DIR, "cache")
INPUT_FOLDER = os.path.join(CACHE_DIR, "input")
THUMBNAIL_FOLDER = os.path.join(CACHE_DIR, "thumbnails")

# File paths
CROP_METADATA_FILE = os.path.join(CONFIG_DIR, "crops", "metadata.json")
# Superseded by upload records in CROP_METADATA_FILE; read once for migration.
LEGACY_PROGRESS_FILE = os.path.join(CONFIG_DIR, "progress.json")

DEFAULT_SETTINGS = {
    "dimensions": {"portrait_size": [1080, 1920], "landscape_size": [1920, 1080]},  # width x height
    "immich": {"url": "", "api_key": "", "input_album_id": "", "output_album_id": ""},
    "meural": {"devices": []},
}
ORIENTATIONS = ("portrait", "landscape")
MAX_SIZE = 10000
MEURAL_HOST = re.compile(r"[A-Za-z0-9.-]+(:\d{1,5})?")

# The settings in effect. Both are updated in place by apply_settings, so
# modules that imported them see changes made from the Settings page.
settings = {}
SIZES = {}  # orientation -> (width, height)


def load_settings():
    """config.yaml merged over the defaults; the defaults alone when the file is missing."""
    loaded = {}
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE) as f:
            loaded = yaml.safe_load(f) or {}
    merged = copy.deepcopy(DEFAULT_SETTINGS)
    for section, values in loaded.items():
        if isinstance(merged.get(section), dict) and isinstance(values, dict):
            merged[section].update(values)
    merged["meural"]["devices"] = [
        {**device, "preview_duration": device.get("preview_duration", 30)}
        for device in merged["meural"].get("devices") or [] if isinstance(device, dict)
    ]
    return merged


def apply_settings(new):
    settings.clear()
    settings.update(copy.deepcopy(new))
    SIZES.update({o: tuple(new["dimensions"][f"{o}_size"]) for o in ORIENTATIONS})


def is_configured(current=None):
    return all((current or settings)["immich"].get(key) for key in DEFAULT_SETTINGS["immich"])


def resolve_immich_login(url, api_key):
    """Validate a server URL and return it with the API key to use there.

    A blank key reuses the saved one, but only for the saved URL, so changing
    the URL can never send the saved key to another server.
    """
    url = (url or "").strip().rstrip("/") if isinstance(url, str) else ""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Immich URL must start with http:// or https://")
    api_key = api_key.strip() if isinstance(api_key, str) else ""
    if not api_key:
        saved = settings["immich"]
        if not saved.get("api_key"):
            raise ValueError("Enter the Immich API key")
        if url != saved.get("url", "").rstrip("/"):
            raise ValueError("Re-enter the API key to use it with a different Immich URL")
        api_key = saved["api_key"]
    return {"url": url, "api_key": api_key}


def _positive_size(value, label):
    if (not isinstance(value, list) or len(value) != 2 or
            not all(isinstance(n, int) and not isinstance(n, bool) and 0 < n <= MAX_SIZE for n in value)):
        raise ValueError(f"{label} size must be a width and height between 1 and {MAX_SIZE}")
    return list(value)


def validate_settings(data):
    """Return complete settings from a Settings form submission, or raise ValueError."""
    if not isinstance(data, dict):
        raise ValueError("Settings must be an object")
    immich = data.get("immich") or {}
    login = resolve_immich_login(immich.get("url"), immich.get("api_key"))
    albums = {}
    for key, label in (("input_album_id", "input"), ("output_album_id", "output")):
        album = immich.get(key)
        if not isinstance(album, str) or not album.strip():
            raise ValueError(f"Choose an {label} album")
        albums[key] = album.strip()
    if albums["input_album_id"] == albums["output_album_id"]:
        raise ValueError("The input and output albums must be different")

    dimensions = data.get("dimensions") or {}
    sizes = {f"{o}_size": _positive_size(dimensions.get(f"{o}_size"), o.capitalize()) for o in ORIENTATIONS}

    devices = []
    for device in (data.get("meural") or {}).get("devices") or []:
        if not isinstance(device, dict):
            raise ValueError("Invalid Meural device")
        name, ip = (device.get(key) for key in ("name", "ip"))
        name = name.strip() if isinstance(name, str) else ""
        ip = ip.strip() if isinstance(ip, str) else ""
        duration = device.get("preview_duration", 30)
        if not name:
            raise ValueError("Each Meural device needs a name")
        if not MEURAL_HOST.fullmatch(ip):
            raise ValueError(f"{name}: enter the device's IP address or hostname")
        if any(d["ip"] == ip for d in devices):
            raise ValueError(f"{ip} is listed more than once")
        if not isinstance(duration, int) or isinstance(duration, bool) or not 1 <= duration <= 3600:
            raise ValueError(f"{name}: preview duration must be 1-3600 seconds")
        devices.append({"name": name, "ip": ip, "preview_duration": duration})

    return {"dimensions": sizes, "immich": {**login, **albums}, "meural": {"devices": devices}}


def save_settings(new):
    """Write config.yaml atomically, readable only by its owner (it holds the API key)."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=CONFIG_DIR, prefix=".config-", suffix=".yaml", delete=False) as f:
        yaml.safe_dump(new, f, sort_keys=False)
        temporary = f.name
    try:
        os.chmod(temporary, 0o600)
        os.replace(temporary, CONFIG_FILE)
    except OSError:
        os.unlink(temporary)
        raise
    apply_settings(new)


# Ensure required directories exist
def init_directories():
    """Create necessary directories if they don't exist"""
    for directory in (CONFIG_DIR, INPUT_FOLDER, THUMBNAIL_FOLDER):
        os.makedirs(directory, exist_ok=True)


apply_settings(load_settings())
