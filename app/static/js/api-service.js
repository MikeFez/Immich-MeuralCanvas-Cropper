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
    if (!window.APP_STATE.initialized || window.APP_STATE.syncing || window.APP_STATE.cropBusy || syncInProgress) {
        return { success: false, message: 'Another operation is in progress' };
    }
    const button = window.ELEMENTS.btnImmichSyncEl;
    const current = window.APP_STATE.currentImage;
    let changedImage = null;
    let synced = false;
    syncInProgress = window.APP_STATE.syncing = true;
    if (button) {
        button.disabled = true;
        button.textContent = 'Syncing…';
    }
    try {
        const response = await fetch('/sync', { method: 'POST' });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Sync failed');
        const images = data.images || await (await fetch('/images')).json();
        window.APP_STATE.imageList = images;
        if (current) {
            const updated = images.find(image => image.asset_id === current.asset_id);
            window.APP_STATE.currentImage = updated || null;
            if (updated && current.source_version !== updated.source_version) changedImage = current.asset_id;
        }
        synced = true;
        return data;
    } catch (error) {
        alert('Error syncing with Immich: ' + error.message);
        throw error;
    } finally {
        syncInProgress = window.APP_STATE.syncing = false;
        if (button) {
            button.disabled = false;
            button.innerHTML = '<i class="fas fa-sync-alt"></i> Sync';
        }
        if (synced) {
            renderImageList();
            if (!window.APP_STATE.currentImage) showView('no-image-view');
            else if (changedImage) selectImage(changedImage);
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
    .then(async data => {
        // Refresh even on partial failure: some images may now be completed.
        if (data.uploaded_assets?.length) {
            window.APP_STATE.imageList = await fetch('/images').then(response => response.json());
            renderImageList();
        }
        if (!data.success) {
            const uploaded = data.uploaded_assets?.length || 0;
            const failed = data.failed_assets?.length || 0;
            throw new Error(failed
                ? `${uploaded} crop(s) uploaded, ${failed} image(s) failed. ${data.error || ''}`.trim()
                : data.error || 'Unknown error');
        }
        alert(`Successfully uploaded ${data.uploaded_assets?.length || 0} images to Immich`);
        return data.uploaded_assets;
    })
    .catch(error => {
        console.error('Error uploading to Immich:', error);
        alert('Error uploading to Immich: ' + error);
        throw error;
    });
}

/** POST JSON and return the parsed body, throwing the server's error on failure. */
async function postJSON(url, body, method = 'POST') {
    const response = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await response.json();
    if (data.image) applyImageUpdate(data.image);
    if (!response.ok || !data.success) throw new Error(data.error || data.message || `${url} failed`);
    return data;
}

/**
 * Replace one image record with the server's copy and re-render.
 * Mutating endpoints return it, so status icons never need a separate refetch.
 */
function applyImageUpdate(image) {
    const list = window.APP_STATE.imageList;
    const index = list.findIndex(item => item.asset_id === image.asset_id);
    if (index !== -1) list[index] = image;
    if (window.APP_STATE.currentImage?.asset_id === image.asset_id) window.APP_STATE.currentImage = image;
    renderImageList();
}

/**
 * Upload the current image's crops, then move on
 */
async function completeImage() {
    const currentImage = window.APP_STATE.currentImage;
    if (!currentImage) return;
    await postJSON('/complete', { identifier: currentImage.asset_id });
    navigateToNextImage();
}

/**
 * Reset image processing
 */
async function resetImage() {
    const currentImage = window.APP_STATE.currentImage;
    if (!currentImage) return;
    await postJSON('/reset', { identifier: currentImage.asset_id });
    window.APP_STATE.portraitCrop = { x: 0, y: 0, width: 0, height: 0 };
    window.APP_STATE.landscapeCrop = { x: 0, y: 0, width: 0, height: 0 };
    window.APP_STATE.currentStage = 1;
    clearPreviewImage('portrait');
    clearPreviewImage('landscape');
}

/**
 * Delete saved crop for one orientation; resolves to the server response
 */
function deleteCropMetadata(assetId, orientation) {
    return postJSON(`/crop-data/${encodeURIComponent(assetId)}/${orientation}`, {}, 'DELETE');
}

/**
 * Clear preview image for a specific orientation
 * @param {string} orientation - 'portrait' or 'landscape'
 */
function clearPreviewImage(orientation) {
    const previewImg = orientation === 'portrait'
        ? window.ELEMENTS.portraitPreviewImgEl
        : window.ELEMENTS.landscapePreviewImgEl;

    if (previewImg) {
        previewImg.src = '';
        previewImg.style.opacity = '1';

        // Remove any loading indicators
        const loadingIndicator = previewImg.parentElement.querySelector('.loading-indicator');
        if (loadingIndicator) {
            loadingIndicator.style.display = 'none';
        }
    }
}
