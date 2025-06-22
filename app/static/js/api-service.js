/**
 * api-service.js - API Communication
 *
 * Handles all backend API calls
 */

// Sync state tracking
let syncInProgress = false;

/**
 * Sync images from Immich input album
 */
async function syncWithImmich() {
    // Multiple sync prevention checks
    if (!window.APP_STATE.initialized) {
        console.trace("Sync blocked - application not initialized");
        return { success: true, files: [], message: "Application not initialized" };
    }

    if (window.APP_STATE.syncing || syncInProgress) {
        console.trace("Sync blocked - operation in progress");
        return { success: true, files: [], message: "Sync in progress" };
    }

    const syncButton = window.ELEMENTS.btnImmichSyncEl;
    if (!syncButton) {
        console.error("Sync button not found");
        return Promise.reject(new Error("UI elements not initialized"));
    }

    syncInProgress = true;
    window.APP_STATE.syncing = true;

    // Disable the sync button and show loading indicator
    syncButton.disabled = true;
    syncButton.setAttribute('data-syncing', 'true');
    syncButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...';

    console.trace("Starting sync operation", {
        trigger: new Error().stack,
        timestamp: new Date().toISOString()
    });

    try {
        const response = await fetch('/sync', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (data.success) {
            console.log(`Sync completed`, {
                timestamp: new Date().toISOString(),
                newFiles: data.files?.length || 0,
                hasImageData: !!data.images
            });

            // Update image list directly from sync response
            if (data.images) {
                window.APP_STATE.imageList = data.images;
                // Use requestAnimationFrame to batch UI updates
                requestAnimationFrame(() => {
                    if (!window.APP_STATE.syncing) {
                        renderImageList();
                    }
                });
            } else {
                // IMPORTANT CHANGE: Instead of triggering loadImageList,
                // just fetch images directly
                try {
                    const imgResponse = await fetch('/images');
                    const imageData = await imgResponse.json();
                    window.APP_STATE.imageList = imageData;

                    // Render updated image list
                    requestAnimationFrame(() => {
                        if (!window.APP_STATE.syncing) {
                            renderImageList();
                        }
                    });
                } catch (imgError) {
                    console.error('Error fetching images after sync:', imgError);
                }
            }
        }
        return data;
    } catch (error) {
        console.error('Error syncing with Immich:', error);
        alert('Error syncing with Immich: ' + error);
        throw error;
    } finally {
        syncInProgress = false;
        window.APP_STATE.syncing = false;
        console.log("Sync state reset", {
            timestamp: new Date().toISOString(),
            success: true
        });
        if (syncButton) {
            syncButton.disabled = false;
            syncButton.removeAttribute('data-syncing');
            syncButton.innerHTML = '<i class="fas fa-sync-alt"></i> Sync';
        }
    }
}

/**
 * Upload all processed images to Immich
 */
function uploadAllToImmich() {
    // Don't allow uploads during sync
    if (syncInProgress || window.APP_STATE.syncing) {
        console.log("Upload blocked - sync in progress");
        return Promise.resolve({ success: false, message: "Sync in progress" });
    }

    return fetch('/upload-all', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            alert(`Successfully uploaded ${data.uploaded_assets?.length || 0} images to Immich`);
            return data.uploaded_assets;
        } else {
            throw new Error(data.error || 'Unknown error');
        }
    })
    .catch(error => {
        console.error('Error uploading to Immich:', error);
        alert('Error uploading to Immich: ' + error);
        throw error;
    });
}

/**
 * Mark image as completed
 */
function completeImage() {
    const currentImage = window.APP_STATE.currentImage;
    const imageList = window.APP_STATE.imageList;

    if (!currentImage) return;

    // Don't allow operations during sync
    if (syncInProgress || window.APP_STATE.syncing) {
        console.log("Complete operation blocked - sync in progress");
        return Promise.resolve({ success: false, message: "Sync in progress" });
    }

    fetch('/complete', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            identifier: currentImage.asset_id || currentImage.filename
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            // Update state directly
            currentImage.status = 'completed';

            // Update UI in list view
            const listItemSelector = currentImage.asset_id ?
                `.image-list-item[data-asset-id="${currentImage.asset_id}"]` :
                `.image-list-item[data-filename="${currentImage.filename}"]`;

            const listItem = document.querySelector(listItemSelector);
            if (listItem) {
                listItem.classList.add('completed');

                // Get the display name (original_filename if available, otherwise filename)
                const displayName = currentImage.original_filename || currentImage.filename;

                listItem.innerHTML = '<i class="fas fa-check-circle status-icon"></i>' +
                    `<span class="image-name">${truncateFilename(displayName, 25)}</span>`;
            }

            // Update UI in grid view
            const gridItemSelector = currentImage.asset_id ?
                `.image-grid-item[data-asset-id="${currentImage.asset_id}"]` :
                `.image-grid-item[data-filename="${currentImage.filename}"]`;

            const gridItem = document.querySelector(gridItemSelector);
            if (gridItem) {
                gridItem.classList.add('completed');

                // Update the status icon
                const statusEl = gridItem.querySelector('.image-status');
                if (statusEl) {
                    statusEl.innerHTML = '<i class="fas fa-check-circle"></i>';
                }
            }

            // Find next image
            const nextImage = imageList.find(img =>
                img.status !== 'completed' &&
                (img.asset_id !== currentImage.asset_id || img.filename !== currentImage.filename)
            );

            if (nextImage) {
                // Use requestAnimationFrame to ensure state is consistent
                requestAnimationFrame(() => {
                    if (!window.APP_STATE.syncing) {
                        selectImage(nextImage.asset_id || nextImage.filename);
                    }
                });
            } else {
                requestAnimationFrame(() => {
                    if (!window.APP_STATE.syncing) {
                        window.APP_STATE.currentImage = null;
                        if (window.ELEMENTS.currentImageEl) {
                            window.ELEMENTS.currentImageEl.style.display = 'none';
                        }
                        showView('no-image-view');
                        alert('All images have been processed! Well done!');
                    }
                });
            }
        } else {
            alert('Error completing image: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(error => {
        console.error('Error completing image:', error);
        alert('Error completing image: ' + error);
    });
}

/**
 * Reset image processing
 */
function resetImage() {
    const currentImage = window.APP_STATE.currentImage;

    if (!currentImage) return;

    // Don't allow operations during sync
    if (syncInProgress || window.APP_STATE.syncing) {
        console.log("Reset operation blocked - sync in progress");
        return Promise.resolve({ success: false, message: "Sync in progress" });
    }

    fetch('/reset', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            identifier: currentImage.asset_id || currentImage.filename
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            // Reset state
            window.APP_STATE.portraitCrop = { x: 0, y: 0, width: 0, height: 0 };
            window.APP_STATE.landscapeCrop = { x: 0, y: 0, width: 0, height: 0 };
            window.APP_STATE.currentStage = 1;
            currentImage.status = 'unprocessed';

            // Update UI in list view
            const listItemSelector = currentImage.asset_id ?
                `.image-list-item[data-asset-id="${currentImage.asset_id}"]` :
                `.image-list-item[data-filename="${currentImage.filename}"]`;

            const listItem = document.querySelector(listItemSelector);
            if (listItem) {
                listItem.classList.remove('completed');

                // Get the display name (original_filename if available, otherwise filename)
                const displayName = currentImage.original_filename || currentImage.filename;

                listItem.innerHTML = '<i class="fas fa-circle status-icon text-secondary"></i>' +
                    `<span class="image-name">${truncateFilename(displayName, 25)}</span>`;
            }

            // Update UI in grid view
            const gridItemSelector = currentImage.asset_id ?
                `.image-grid-item[data-asset-id="${currentImage.asset_id}"]` :
                `.image-grid-item[data-filename="${currentImage.filename}"]`;

            const gridItem = document.querySelector(gridItemSelector);
            if (gridItem) {
                gridItem.classList.remove('completed');

                // Update the status icon
                const statusEl = gridItem.querySelector('.image-status');
                if (statusEl) {
                    statusEl.innerHTML = '<i class="fas fa-circle text-secondary"></i>';
                }
            }

            // Update UI with animation frame to prevent race conditions
            requestAnimationFrame(() => {
                if (!window.APP_STATE.syncing) {
                    updateStage();
                }
            });
        } else {
            alert('Error resetting image: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(error => {
        console.error('Error resetting image:', error);
        alert('Error resetting image: ' + error);
    });
}