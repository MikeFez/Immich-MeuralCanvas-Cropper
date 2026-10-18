/**
 * meural-service.js - Meural Canvas Integration
 *
 * Handles Meural Canvas preview functionality
 */

// Cache for Meural devices
let meuralDevices = [];
let meuralPreviewInProgress = false;

/**
 * Get available Meural devices
 */
async function getMeuralDevices() {
    if (meuralDevices.length > 0) {
        return meuralDevices;
    }

    try {
        const response = await fetch('/meural/devices');
        const data = await response.json();

        if (data.devices && Array.isArray(data.devices)) {
            meuralDevices = data.devices;
            return data.devices;
        }
        return [];
    } catch (error) {
        console.error('Error fetching Meural devices:', error);
        return [];
    }
}

/**
 * Preview image on a Meural Canvas
 */
async function previewOnMeural(deviceIp, identifier, orientation, useTempCrop = false, cropData = null) {
    // Prevent multiple preview operations
    if (meuralPreviewInProgress) {
        console.log("Preview blocked - operation in progress");
        return { success: false, message: "Preview already in progress" };
    }

    meuralPreviewInProgress = true;

    try {
        const payload = {
            device_ip: deviceIp,
            identifier: identifier,
            orientation: orientation,
            use_temp: useTempCrop
        };

        // Add crop data if using temp crop
        if (useTempCrop && cropData) {
            payload.crop = cropData;
        }

        const response = await fetch('/meural/preview', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (data.success) {
            console.log(`Preview sent to Meural ${deviceIp}`, {
                message: data.message,
                previewDuration: data.preview_duration,
                timestamp: new Date().toISOString()
            });
        } else {
            console.error('Error sending preview to Meural:', data.message);
        }

        return data;
    } catch (error) {
        console.error('Error previewing on Meural:', error);
        return { success: false, message: error.toString() };
    } finally {
        meuralPreviewInProgress = false;
    }
}

/**
 * Show Meural device selection dialog
 */
function showMeuralDeviceDialog(callback) {
    // Get the devices first
    getMeuralDevices().then(devices => {
        if (devices.length === 0) {
            showToast('No Meural devices configured. Add devices in config.yaml.', 'error');
            return;
        }

        // Create a simple dialog
        const dialog = document.createElement('div');
        dialog.className = 'meural-device-dialog';
        dialog.innerHTML = `
            <div class="meural-device-dialog-content">
                <h3>Select Meural Device</h3>
                <p>Choose a device to preview your image:</p>
                <div class="device-list">
                    ${devices.map(device => `
                        <div class="device-item" data-ip="${device.ip}">
                            <i class="fas fa-tv"></i>
                            <span>${device.name} (${device.ip})</span>
                        </div>
                    `).join('')}
                </div>
                <div class="dialog-buttons">
                    <button class="btn btn-meural btn-secondary" id="cancel-meural">Cancel</button>
                </div>
            </div>
        `;

        // Add to document
        document.body.appendChild(dialog);

        // Add click handlers
        dialog.querySelectorAll('.device-item').forEach(item => {
            item.addEventListener('click', () => {
                const deviceIp = item.getAttribute('data-ip');
                document.body.removeChild(dialog);
                callback(deviceIp);
            });
        });

        // Cancel button
        document.getElementById('cancel-meural').addEventListener('click', () => {
            document.body.removeChild(dialog);
        });
    });
}

/**
 * Preview current image on Meural Canvas
 */
function previewCurrentOnMeural() {
    const currentImage = window.APP_STATE.currentImage;
    const currentStage = window.APP_STATE.currentStage;

    if (!currentImage) {
        showToast('No image selected.', 'error');
        return;
    }

    if (window.APP_STATE.syncing) {
        showToast('Cannot preview while syncing.', 'error');
        return;
    }

    const identifier = currentImage.asset_id;

    // Determine which orientation to preview based on current stage
    const usePortrait = currentStage === 1 || (currentStage === 3 && window.APP_STATE.portraitCrop.width > 0);
    const useLandscape = currentStage === 2 || (currentStage === 3 && window.APP_STATE.landscapeCrop.width > 0);

    if (!usePortrait && !useLandscape) {
        showToast('No crop available to preview.', 'error');
        return;
    }

    const orientation = usePortrait ? 'portrait' : 'landscape';

    // For current editing stage, we need to create a temporary crop
    const useTempCrop = currentStage < 3;

    if (useTempCrop) updateCropValues();
    const cropData = window.APP_STATE[orientation + 'Crop'];

    // Show device selection dialog
    showMeuralDeviceDialog(deviceIp => {
        // Show loading indicator
        const previewBtn = window.ELEMENTS.btnMeuralPreviewEl;
        const originalText = previewBtn.innerHTML;
        previewBtn.disabled = true;
        previewBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Previewing...';

        // Send preview to selected device
        previewOnMeural(deviceIp, identifier, orientation, useTempCrop, cropData)
            .then(result => {
                if (!result.success) {
                    showToast(`Meural preview failed: ${result.message || result.error}`, 'error');
                }
            })
            .catch(error => {
                showToast(`Meural preview failed: ${error.message || error}`, 'error');
            })
            .finally(() => {
                // Reset button
                previewBtn.disabled = false;
                previewBtn.innerHTML = originalText;
            });
    });
}