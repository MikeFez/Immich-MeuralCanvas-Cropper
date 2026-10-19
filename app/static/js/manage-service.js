/**
 * manage-service.js - Image Management Modal
 *
 * Handles the image management interface with 3-column table view
 */

/**
 * Show the manage modal
 */
function showManageModal() {
    // Opens during a sync too, so its progress is visible on the Sync button.
    if (window.APP_STATE.cropBusy) return;
    const modal = window.ELEMENTS.manageModalEl;
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
    const modal = window.ELEMENTS.manageModalEl;
    if (!modal) return;

    modal.style.display = 'none';
    document.body.style.overflow = 'auto';
}

/**
 * Load and display images in the manage table
 */
async function loadManageData() {
    const loadingEl = window.ELEMENTS.manageTableLoadingEl;
    const wrapperEl = window.ELEMENTS.manageTableWrapperEl;
    const emptyEl = window.ELEMENTS.manageTableEmptyEl;
    const tableBodyEl = window.ELEMENTS.manageTableBodyEl;

    // Show loading state
    loadingEl.style.display = 'flex';
    wrapperEl.style.display = 'none';
    emptyEl.style.display = 'none';

    try {
        const images = await (await fetch('/images')).json();
        window.APP_STATE.imageList = images;
        renderImageList();
        const processedImages = images.filter(image => image.crops.portrait || image.crops.landscape);

        tableBodyEl.innerHTML = '';
        if (processedImages.length === 0) {
            loadingEl.style.display = 'none';
            emptyEl.style.display = 'flex';
            return;
        }

        // Generate table rows
        tableBodyEl.append(...processedImages.map(createManageTableRow));

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
function manageButton(className, label, action) {
    const button = makeElement('button', `manage-action-btn ${className}`, label);
    button.addEventListener('click', () => action(button));
    return button;
}

function createManageTableRow(image) {
    const identifier = image.asset_id;
    const name = image.original_filename || image.filename;
    const metadata = image.crops;
    const row = document.createElement('tr');
    row.dataset.identifier = identifier;
    const original = makeElement('td', 'original-column');
    const cell = makeElement('div', 'manage-image-cell');
    const preview = makeElement('img', 'manage-image-preview');
    preview.src = thumbnailURL(image);
    preview.alt = name;
    const info = makeElement('div', 'manage-image-info');
    info.append(makeElement('div', 'manage-image-filename', truncateFilename(name, 25)));
    const actions = makeElement('div', 'manage-image-actions');
    actions.append(manageButton('delete-original', 'Remove Original', button => deleteOriginalImage(identifier, button)));
    cell.append(preview, info, actions);
    original.append(cell);
    row.append(original);
    for (const orientation of ['portrait', 'landscape']) {
        const column = makeElement('td', orientation + '-column');
        if (!metadata[orientation]) {
            column.append(makeElement('div', 'manage-no-image', `No ${orientation} crop`));
        } else {
            const cropCell = makeElement('div', 'manage-image-cell');
            const cropPreview = makeElement('img', 'manage-image-preview');
            cropPreview.src = previewURL(identifier, orientation, metadata[orientation]);
            cropPreview.alt = orientation + ' crop';
            const cropInfo = makeElement('div', 'manage-image-info');
            const dimensions = getDimensions(orientation);
            cropInfo.append(makeElement('div', 'manage-image-filename', orientation === 'portrait' ? 'Portrait Crop' : 'Landscape Crop'),
                makeElement('div', 'manage-image-dimensions', `${dimensions.width} × ${dimensions.height}`));
            const cropActions = makeElement('div', 'manage-image-actions');
            cropActions.append(
                manageButton('delete', 'Delete', () => deleteCropImage(identifier, orientation)),
                manageButton('reupload', 'Re-upload', button => reuploadCropImage(identifier, orientation, button)),
                manageButton('recrop', 'Re-crop', () => recropImage(identifier, orientation))
            );
            cropCell.append(cropPreview, cropInfo, cropActions);
            column.append(cropCell);
        }
        row.append(column);
    }
    return row;
}

/**
 * Delete a crop image (portrait or landscape)
 */
async function deleteCropImage(identifier, orientation) {
    if (!await confirmDialog(`Delete the ${orientation} crop?`, 'Delete', true)) {
        return;
    }

    try {
        await deleteCropMetadata(identifier, orientation);
        await loadManageData();
        if (window.APP_STATE.currentImage?.asset_id === identifier) {
            window.APP_STATE[orientation + 'Crop'] = { x: 0, y: 0, width: 0, height: 0 };
            clearPreviewImage(orientation);
        }
        showToast(`${orientation} crop deleted successfully`, 'success');
    } catch (error) {
        console.error(`Error deleting ${orientation} crop:`, error);
        showToast(`Error deleting ${orientation} crop: ${error.message}`, 'error');
    }
}

/**
 * Re-upload a crop image to Immich
 */
async function reuploadCropImage(identifier, orientation, button) {
    if (!await confirmDialog(`Re-upload the ${orientation} crop to Immich?`, 'Re-upload')) {
        return;
    }

    const originalContent = button?.innerHTML;
    try {
        // Show loading state
        if (button) button.disabled = true;
        if (button) button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';

        await postJSON('/upload-single', { identifier, orientation });
        showToast(`${orientation} crop uploaded successfully`, 'success');
    } catch (error) {
        console.error(`Error uploading ${orientation} crop:`, error);
        showToast(`Error uploading ${orientation} crop: ${error.message}`, 'error');
    } finally {
        // Reset button state
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
    if (window.APP_STATE.cropBusy || window.APP_STATE.syncing) return;
    hideManageModal();
    selectImage(identifier, orientation === 'portrait' ? 1 : 2);
}

/**
 * Delete original image from source album
 */
async function deleteOriginalImage(identifier, button) {
    const confirmed = await confirmDialog(
        'Remove this image from the source album? The original photo will remain in your Immich library.',
        'Remove', true
    );

    if (!confirmed) return;

    const originalContent = button?.innerHTML;
    try {
        // Show loading state
        if (button) button.disabled = true;
        if (button) button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting...';

        await postJSON('/delete-original', { identifier }, 'DELETE');
        document.querySelector(`tr[data-identifier="${identifier}"]`)?.remove();
        window.APP_STATE.imageList = window.APP_STATE.imageList.filter(img => img.asset_id !== identifier);
        renderImageList();
        if (window.APP_STATE.currentImage?.asset_id === identifier) {
            window.APP_STATE.currentImage = null;
            showView('no-image-view');
        }
        showToast('Removed from source album', 'success');
    } catch (error) {
        console.error('Error deleting original image:', error);
        showToast(`Error deleting original image: ${error.message}`, 'error');
    } finally {
        // Reset button state
        if (button) {
            button.disabled = false;
            button.innerHTML = originalContent;
        }
    }
}

/**
 * Setup manage modal event handlers
 */
function setupManageModal() {
    // Manage button click handler
    const manageButton = window.ELEMENTS.btnManageEl;
    if (manageButton) {
        manageButton.addEventListener('click', showManageModal);
    }

    // Close button handler
    const closeButton = window.ELEMENTS.manageModalCloseEl;
    if (closeButton) {
        closeButton.addEventListener('click', hideManageModal);
    }

    // Modal backdrop click handler
    const modal = window.ELEMENTS.manageModalEl;
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
            const modal = window.ELEMENTS.manageModalEl;
            if (modal && modal.style.display !== 'none') {
                hideManageModal();
            }
        }
    });
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', setupManageModal);
