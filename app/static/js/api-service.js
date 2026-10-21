/**
 * api-service.js - API Communication
 *
 * Handles all backend API calls
 */

// Jobs this page started; watchBackgroundJobs notices the others.
let syncInProgress = false;
let uploadInProgress = false;
let lastSyncSeen;  // ID of the sync the image list reflects
let lastJobChange;

/**
 * Start a background job ('sync' or 'upload-all') and resolve with its result.
 * If the same kind of job is already running (e.g. the startup sync), follow it instead.
 * @param {function} onProgress - called with the job while it runs
 */
async function runJob(kind, onProgress) {
    const response = await fetch(`/${kind}`, { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    let job = data.job;
    if (!job || (!response.ok && job.kind !== kind)) throw new Error(data.error || `${kind} failed`);
    return followJob(job, onProgress);
}

async function followJob(job, onProgress) {
    while (job.status === 'running') {
        onProgress?.(job);
        await new Promise(resolve => setTimeout(resolve, 500));
        const poll = await fetch(`/jobs/${job.id}`);
        if (!poll.ok) throw new Error(`Lost track of job ${job.id}`);
        job = (await poll.json()).job;
    }
    if (job.status === 'failed' || job.status === 'interrupted') throw new Error(job.error || `${job.kind} failed`);
    if (job.status === 'cancelled') {
        showToast('Job cancelled. Completed images were kept.', 'info');
        return { ...job.result, cancelled: true };
    }
    return job.result;
}

/** "Label 3/10" while a job runs, once its total is known. */
function progressLabel(label, job) {
    return job.total ? `${label} ${job.done}/${job.total}` : `${label}…`;
}

/** Spin the header's Manage icon while a Sync or Upload All job runs. */
function showJobRunning(running) {
    const icon = window.ELEMENTS.btnManageEl?.querySelector('i');
    if (icon) icon.className = running ? 'fas fa-sync-alt fa-spin' : 'fas fa-list';
}

/** Refresh the Manage table after a job, if it is open. */
function refreshManageModal() {
    if (window.ELEMENTS.manageModalEl.style.display !== 'none') loadManageData();
}

/**
 * Reload the image list after a sync or upload. The open image stays open unless
 * it left the album (back to the landing page) or changed in Immich (reloaded).
 */
async function refreshImages() {
    const current = window.APP_STATE.currentImage;
    const images = await (await fetch('/images')).json();
    window.APP_STATE.imageList = images;
    const updated = current && images.find(image => image.asset_id === current.asset_id);
    window.APP_STATE.currentImage = updated || null;
    renderImageList();
    if (!updated) showView('no-image-view');
    else if (current.source_version !== updated.source_version) selectImage(updated.asset_id);
    refreshManageModal();
}

/**
 * Sync images from Immich input album
 */
async function syncWithImmich() {
    if (!window.APP_STATE.initialized || window.APP_STATE.syncing || window.APP_STATE.cropBusy || syncInProgress) {
        return { success: false, message: 'Another operation is in progress' };
    }
    const button = window.ELEMENTS.btnImmichSyncEl;
    let result;
    syncInProgress = window.APP_STATE.syncing = true;
    showJobRunning(true);
    if (button) {
        button.disabled = true;
        button.textContent = 'Syncing…';
    }
    try {
        result = await runJob('sync', job => { if (button) button.textContent = progressLabel('Syncing', job); });
        if (result?.reuploads) {
            showToast(`${result.reuploads} image${result.reuploads === 1 ? ' has crops' : 's have crops'} no longer in Immich; ` +
                'they need uploading again', 'info');
        }
    } catch (error) {
        showToast('Error syncing with Immich: ' + error.message, 'error');
        throw error;
    } finally {
        syncInProgress = window.APP_STATE.syncing = false;
        showJobRunning(false);
        if (button) {
            button.disabled = false;
            button.innerHTML = '<i class="fas fa-sync-alt"></i> Sync';
        }
        await refreshImages();
        await watchBackgroundJobs();
    }
    return result;
}

/**
 * Notice jobs this page didn't start: the startup sync and scheduled syncs.
 * The image list is refreshed whenever a newer sync has finished.
 */
async function watchBackgroundJobs() {
    try {
        const data = await (await fetch('/jobs')).json();
        showJobRunning(!!data.running || syncInProgress || uploadInProgress);
        const change = (data.history || []).filter(job => job.status !== 'running')
            .map(job => `${job.id}:${job.status}`).join(',');
        const jobChanged = lastJobChange !== undefined && change !== lastJobChange;
        if (!window.APP_STATE.syncing && !window.APP_STATE.cropBusy && !uploadInProgress) {
            lastJobChange = change;
            if (jobChanged) await refreshImages();
        }
        if (lastSyncSeen === undefined) {
            lastSyncSeen = data.last_sync;
        } else if (data.last_sync !== lastSyncSeen && !window.APP_STATE.syncing && !window.APP_STATE.cropBusy) {
            lastSyncSeen = data.last_sync;
            await refreshImages();
        }
    } catch (error) {
        console.warn('Could not check background jobs:', error);
    }
}

/**
 * Upload all processed images to Immich
 */
async function uploadAllToImmich() {
    if (syncInProgress || window.APP_STATE.syncing) {
        return { success: false, message: "Sync in progress" };
    }
    const button = window.ELEMENTS.btnImmichUploadEl;
    const label = button?.innerHTML;
    uploadInProgress = true;
    showJobRunning(true);
    try {
        const data = await runJob('upload-all', job => { if (button) button.textContent = progressLabel('Uploading', job); });
        // Refresh even on partial failure: some images may now be completed.
        if (data.uploaded_assets?.length) await refreshImages();
        if (data.cancelled) return data.uploaded_assets || [];
        if (!data.success) {
            const uploaded = data.uploaded_assets?.length || 0;
            const failed = data.failed_assets?.length || 0;
            throw new Error(failed
                ? `${uploaded} crop(s) uploaded, ${failed} image(s) failed. ${data.error || ''}`.trim()
                : data.error || 'Unknown error');
        }
        const count = data.uploaded_assets?.length || 0;
        showToast(count ? `Uploaded ${count} new or changed crop${count === 1 ? '' : 's'} to Immich`
            : 'Every crop is already in Immich', 'success');
        return data.uploaded_assets;
    } catch (error) {
        console.error('Error uploading to Immich:', error);
        showToast('Error uploading to Immich: ' + error.message, 'error');
        throw error;
    } finally {
        uploadInProgress = false;
        showJobRunning(false);
        if (button) button.innerHTML = label;
        await refreshImages();
        await watchBackgroundJobs();
    }
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
    }
}
