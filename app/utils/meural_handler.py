import logging
import requests


class MeuralHandler:
    """Handler for Meural Canvas devices to preview images directly."""

    def __init__(self, devices_config):
        """Initialize the Meural handler with device configurations.

        Args:
            devices_config (list): List of device configurations from config.yaml
        """
        self.devices = devices_config
        self._validate_config()
        logging.info(f"Initialized MeuralHandler with {len(self.devices)} devices")

    def _validate_config(self):
        """Validate device configurations."""
        if not self.devices:
            logging.warning("No Meural devices configured")
            return

        for idx, device in enumerate(self.devices):
            if not device.get("ip"):
                logging.warning(f"Device {idx+1} missing IP address")
            if not device.get("name"):
                logging.warning(f"Device at {device.get('ip', 'unknown')} missing name")
            device["preview_duration"] = device.get("preview_duration", 30)

    def get_device_list(self):
        """Get list of configured Meural devices.

        Returns:
            list: List of device dictionaries with name and ip
        """
        return [{"name": d["name"], "ip": d["ip"]} for d in self.devices]

    def _set_preview_duration(self, device_ip: str, duration: int):
        """Best effort: a failure only means the device keeps its previous duration."""
        try:
            response = requests.get(
                f"http://{device_ip}/remote/control_command/set_key/",
                params={"key": "previewDuration", "value": str(duration)},
                timeout=5,
            )
            if response.json().get("status") != "pass":
                logging.warning("Meural %s did not confirm preview duration: %s", device_ip, response.text[:200])
        except (requests.RequestException, ValueError, AttributeError) as e:
            logging.warning("Could not set preview duration on %s: %s", device_ip, e)

    def preview_image(self, device_ip: str, content: bytes) -> dict:
        """Send rendered JPEG bytes to a configured Meural Canvas as a postcard.

        Only an explicit {"status": "pass"} from the device counts as success.
        """
        # Only configured devices are contacted, so clients cannot pick arbitrary hosts.
        device = next((d for d in self.devices if d["ip"] == device_ip), None)
        if not device:
            return {"success": False, "message": f"Device not found with IP: {device_ip}"}

        duration = device.get("preview_duration", 30)
        self._set_preview_duration(device_ip, duration)
        try:
            response = requests.post(
                f"http://{device_ip}/remote/postcard",
                files={"photo": ("preview.jpg", content, "image/jpeg")},
                timeout=30,
            )
        except requests.RequestException as e:
            return {"success": False, "message": f"Could not reach {device['name']}: {e}"}
        try:
            body = response.json()
        except ValueError:
            logging.error("Unexpected Meural response %s: %s", response.status_code, response.text[:200])
            return {"success": False, "message": f"Unexpected response from {device['name']} (HTTP {response.status_code})"}

        if isinstance(body, dict) and body.get("status") == "pass":
            return {
                "success": True,
                "message": f"Image previewed on {device['name']} ({device_ip})",
                "preview_duration": duration,
            }
        error = body.get("response", "Unknown error") if isinstance(body, dict) else body
        return {"success": False, "message": f"API error: {error}"}
