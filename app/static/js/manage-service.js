/**
 * manage-service.js - Image Management Modal
 *
 * Handles the image management interface with 3-column table view
 */

/**
 * Show the manage modal
 */
function showManageModal() {
    const modal = document.getElementById('manage-modal');
    if (!modal) return;

    // Show modal
    modal.style.display = 'flex';

    // Load images data
    loadManageData();

    // Prevent body scrolling
    document.body.style.overflow = 'hidden';
}

/**
 * Hide the manage modal
 */
function hideManageModal() {
    const modal = document.getElementById('manage-modal');
    if (!modal) return;

    modal.style.display = 'none';
    document.body.style.overflow = 'auto';
}

/**
 * Load and display images in the manage table
 */
async function loadManageData() {
    const loadingEl = document.getElementById('manage-table-loading');
    const wrapperEl = document.getElementById('manage-table-wrapper');
    const emptyEl = document.getElementById('manage-table-empty');
    const tableBodyEl = document.getElementById('manage-table-body');

    // Show loading state
    loadingEl.style.display = 'flex';
    wrapperEl.style.display = 'none';
    emptyEl.style.display = 'none';

    try {
        // Get all images and their metadata
        const [imagesResponse, metadataResponse] = await Promise.all([
            fetch('/images'),
            fetch('/crop-data/all')
        ]);

        const images = await imagesResponse.json();
        const allMetadata = await metadataResponse.json();

        // Filter images that have at least one crop or are completed
        const processedImages = images.filter(image => {
            const identifier = image.asset_id || image.filename;
            const metadata = allMetadata.crops && allMetadata.crops[identifier];
            return metadata && (metadata.portrait || metadata.landscape);
        });

        if (processedImages.length === 0) {
            loadingEl.style.display = 'none';
            emptyEl.style.display = 'flex';
            return;
        }

        // Clear existing table content
        tableBodyEl.innerHTML = '';

        // Generate table rows
        for (const image of processedImages) {
            const row = await createManageTableRow(image, allMetadata);
            tableBodyEl.appendChild(row);
        }

        // Show table
        loadingEl.style.display = 'none';
        wrapperEl.style.display = 'block';

    } catch (error) {
        console.error('Error loading manage data:', error);
        loadingEl.innerHTML = `
            <div class="text-danger">
                <i class="fas fa-exclamation-triangle fa-2x"></i>
                <p>Error loading images. Please try again.</p>
            </div>
        `;
    }
}

/**
 * Create a table row for the manage interface
 */
async function createManageTableRow(image, allMetadata) {
    const identifier = image.asset_id || image.filename;
    const displayName = image.original_filename || image.filename;
    const metadata = allMetadata.crops && allMetadata.crops[identifier];

    const row = document.createElement('tr');
    row.setAttribute('data-identifier', identifier);

    // Original image column
    const originalCol = document.createElement('td');
    originalCol.className = 'original-column';
    originalCol.innerHTML = `
        <div class="manage-image-cell">
            <img src="/image/${encodeURIComponent(identifier)}"
                 alt="${displayName}"
                 class="manage-image-preview"
                 onerror="this.style.display='none'">
            <div class="manage-image-info">
                <div class="manage-image-filename">${truncateFilename(displayName, 25)}</div>
                <div class="manage-image-dimensions">${image.width || '?'} × ${image.height || '?'}</div>
            </div>
            <div class="manage-image-actions">
                <button class="manage-action-btn delete-original"
                        onclick="deleteOriginalImage('${identifier}', '${displayName}')"
                        title="Delete from source album">
                    <i class="fas fa-trash"></i> Delete Original
                </button>
            </div>
        </div>
    `;

    // Portrait column
    const portraitCol = document.createElement('td');
    portraitCol.className = 'portrait-column';
    if (metadata && metadata.portrait) {
        const portraitPath = `/output/portrait/${encodeURIComponent(identifier)}_portrait.jpg`;
        portraitCol.innerHTML = `
            <div class="manage-image-cell">
                <img src="${portraitPath}"
                     alt="Portrait crop"
                     class="manage-image-preview"
                     onerror="this.style.display='none'">
                <div class="manage-image-info">
                    <div class="manage-image-filename">Portrait Crop</div>
                    <div class="manage-image-dimensions">${getDimensions('portrait').width} × ${getDimensions('portrait').height}</div>
                </div>
                <div class="manage-image-actions">
                    <button class="manage-action-btn delete"
                            onclick="deleteCropImage('${identifier}', 'portrait')"
                            title="Delete portrait crop">
                        <i class="fas fa-trash"></i> Delete
                    </button>
                    <button class="manage-action-btn reupload"
                            onclick="reuploadCropImage('${identifier}', 'portrait')"
                            title="Re-upload portrait crop">
                        <i class="fas fa-cloud-upload-alt"></i> Re-upload
                    </button>
                    <button class="manage-action-btn recrop"
                            onclick="recropImage('${identifier}', 'portrait')"
                            title="Re-crop portrait">
                        <i class="fas fa-crop-alt"></i> Re-crop
                    </button>
                </div>
            </div>
        `;
    } else {
        portraitCol.innerHTML = `
            <div class="manage-no-image">
                <i class="fas fa-mobile-alt"></i>
                <span>No portrait crop</span>
            </div>
        `;
    }

    // Landscape column
    const landscapeCol = document.createElement('td');
    landscapeCol.className = 'landscape-column';
    if (metadata && metadata.landscape) {
        const landscapePath = `/output/landscape/${encodeURIComponent(identifier)}_landscape.jpg`;
        landscapeCol.innerHTML = `
            <div class="manage-image-cell">
                <img src="${landscapePath}"
                     alt="Landscape crop"
                     class="manage-image-preview"
                     onerror="this.style.display='none'">
                <div class="manage-image-info">
                    <div class="manage-image-filename">Landscape Crop</div>
                    <div class="manage-image-dimensions">${getDimensions('landscape').width} × ${getDimensions('landscape').height}</div>
                </div>
                <div class="manage-image-actions">
                    <button class="manage-action-btn delete"
                            onclick="deleteCropImage('${identifier}', 'landscape')"
                            title="Delete landscape crop">
                        <i class="fas fa-trash"></i> Delete
                    </button>
                    <button class="manage-action-btn reupload"
                            onclick="reuploadCropImage('${identifier}', 'landscape')"
                            title="Re-upload landscape crop">
                        <i class="fas fa-cloud-upload-alt"></i> Re-upload
                    </button>
                    <button class="manage-action-btn recrop"
                            onclick="recropImage('${identifier}', 'landscape')"
                            title="Re-crop landscape">
                        <i class="fas fa-crop-alt"></i> Re-crop
                    </button>
                </div>
            </div>
        `;
    } else {
        landscapeCol.innerHTML = `
            <div class="manage-no-image">
                <i class="fas fa-desktop"></i>
                <span>No landscape crop</span>
            </div>
        `;
    }

    row.appendChild(originalCol);
    row.appendChild(portraitCol);
    row.appendChild(landscapeCol);

    return row;
}

/**
 * Delete a crop image (portrait or landscape)
 */
async function deleteCropImage(identifier, orientation) {
    if (!confirm(`Are you sure you want to delete the ${orientation} crop?`)) {
        return;
    }

    try {
        const response = await fetch(`/crop-data/${encodeURIComponent(identifier)}/${orientation}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (result.success) {
            // Refresh the manage table
            await loadManageData();

            // Update the main UI if the current image is affected
            if (window.APP_STATE.currentImage &&
                (window.APP_STATE.currentImage.asset_id === identifier ||
                 window.APP_STATE.currentImage.filename === identifier)) {
                await updateImageStatusInUI(window.APP_STATE.currentImage);
            }

            // Show success message
            showManageNotification(`${orientation} crop deleted successfully`, 'success');
        } else {
            showManageNotification(`Error deleting ${orientation} crop: ${result.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        console.error(`Error deleting ${orientation} crop:`, error);
        showManageNotification(`Error deleting ${orientation} crop: ${error.message}`, 'error');
    }
}

/**
 * Re-upload a crop image to Immich
 */
async function reuploadCropImage(identifier, orientation) {
    if (!confirm(`Are you sure you want to re-upload the ${orientation} crop to Immich?`)) {
        return;
    }

    try {
        // Find the button that was clicked and show loading state
        const button = event.target.closest('.manage-action-btn');
        const originalContent = button.innerHTML;
        button.disabled = true;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';

        const response = await fetch('/upload-single', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                identifier: identifier,
                orientation: orientation
            })
        });

        const result = await response.json();

        if (result.success) {
            showManageNotification(`${orientation} crop uploaded successfully`, 'success');
        } else {
            showManageNotification(`Error uploading ${orientation} crop: ${result.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        console.error(`Error uploading ${orientation} crop:`, error);
        showManageNotification(`Error uploading ${orientation} crop: ${error.message}`, 'error');
    } finally {
        // Reset button state
        const button = event.target.closest('.manage-action-btn');
        if (button) {
            button.disabled = false;
            button.innerHTML = originalContent;
        }
    }
}

/**
 * Re-crop an image (opens the crop interface)
 */
function recropImage(identifier, orientation) {
    // Close the manage modal
    hideManageModal();

    // Select the image in the main interface
    selectImage(identifier);

    // Wait for image to load, then navigate to appropriate stage
    setTimeout(() => {
        if (orientation === 'portrait') {
            window.APP_STATE.currentStage = 1;
        } else {
            window.APP_STATE.currentStage = 2;
        }
        updateStage();
    }, 500);
}

/**
 * Delete original image from source album
 */
async function deleteOriginalImage(identifier, displayName) {
    const confirmed = confirm(
        `Are you sure you want to delete "${displayName}" from the source album?\n\n` +
        `This will permanently remove the original image from Immich. This action cannot be undone.`
    );

    if (!confirmed) return;

    try {
        // Find the button that was clicked and show loading state
        const button = event.target.closest('.manage-action-btn');
        const originalContent = button.innerHTML;
        button.disabled = true;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting...';

        const response = await fetch('/delete-original', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                identifier: identifier
            })
        });

        const result = await response.json();

        if (result.success) {
            // Remove the row from the table
            const row = document.querySelector(`tr[data-identifier="${identifier}"]`);
            if (row) {
                row.remove();
            }

            // Update image list in main app
            if (window.APP_STATE.imageList) {
                window.APP_STATE.imageList = window.APP_STATE.imageList.filter(img =>
                    (img.asset_id !== identifier) && (img.filename !== identifier)
                );
                renderImageList();
            }

            showManageNotification('Original image deleted successfully', 'success');
        } else {
            showManageNotification(`Error deleting original image: ${result.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        console.error('Error deleting original image:', error);
        showManageNotification(`Error deleting original image: ${error.message}`, 'error');
    } finally {
        // Reset button state
        const button = event.target.closest('.manage-action-btn');
        if (button) {
            button.disabled = false;
            button.innerHTML = originalContent;
        }
    }
}

/**
 * Show notification in manage modal
 */
function showManageNotification(message, type = 'info') {
    // Create or update notification element
    let notification = document.getElementById('manage-notification');
    if (!notification) {
        notification = document.createElement('div');
        notification.id = 'manage-notification';
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            border-radius: 6px;
            color: white;
            font-weight: 500;
            z-index: 3000;
            max-width: 300px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            transition: opacity 0.3s ease;
        `;
        document.body.appendChild(notification);
    }

    // Set message and style based on type
    notification.textContent = message;
    if (type === 'success') {
        notification.style.backgroundColor = '#28a745';
    } else if (type === 'error') {
        notification.style.backgroundColor = '#dc3545';
    } else {
        notification.style.backgroundColor = '#17a2b8';
    }

    // Show notification
    notification.style.opacity = '1';

    // Auto-hide after 3 seconds
    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, 3000);
}

/**
 * Setup manage modal event handlers
 */
function setupManageModal() {
    // Manage button click handler
    const manageButton = document.getElementById('btn-manage');
    if (manageButton) {
        manageButton.addEventListener('click', showManageModal);
    }

    // Close button handler
    const closeButton = document.getElementById('manage-modal-close');
    if (closeButton) {
        closeButton.addEventListener('click', hideManageModal);
    }

    // Modal backdrop click handler
    const modal = document.getElementById('manage-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                hideManageModal();
            }
        });
    }

    // Escape key handler
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const modal = document.getElementById('manage-modal');
            if (modal && modal.style.display !== 'none') {
                hideManageModal();
            }
        }
    });
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', setupManageModal);
