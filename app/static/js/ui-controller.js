/**
 * ui-controller.js - UI State Management
 */

// Every element the app uses, looked up once. Scripts load at the end of <body>,
// so the DOM is already parsed; each is available as ELEMENTS.<key>El.
const ELEMENT_IDS = {
    imageGrid: 'image-grid',
    imageCount: 'image-count',
    unprocessedFilter: 'show-unprocessed-only',
    currentImage: 'current-image',
    cropRectangle: 'crop-rectangle',
    cropOverlay: 'crop-overlay',
    cropResolution: 'crop-resolution',
    editorView: 'editor-view',
    editorContainer: 'editor-container',
    noImageView: 'no-image-view',
    previewView: 'preview-view',
    portraitPreview: 'portrait-preview',
    landscapePreview: 'landscape-preview',
    portraitPreviewImg: 'portrait-preview-img',
    landscapePreviewImg: 'landscape-preview-img',
    stageName: 'stage-name',
    stage1: 'stage-1',
    stage2: 'stage-2',
    stage3: 'stage-3',
    stage1Label: 'stage-1-label',
    stage2Label: 'stage-2-label',
    stage3Label: 'stage-3-label',
    btnBack: 'btn-back',
    btnSkip: 'btn-skip',
    btnReset: 'btn-reset',
    btnRemoveFromAlbum: 'btn-remove-from-album',
    btnCrop: 'btn-crop',
    btnSave: 'btn-save',
    btnImmichSync: 'btn-immich-sync',
    btnImmichUpload: 'btn-immich-upload',
    btnMeuralPreview: 'btn-meural-preview',
    btnManage: 'btn-manage',
    btnLibrary: 'btn-library',
    btnGallery: 'btn-gallery',
    galleryModal: 'gallery-modal',
    manageModal: 'manage-modal',
    manageModalClose: 'manage-modal-close',
    manageTableLoading: 'manage-table-loading',
    manageTableWrapper: 'manage-table-wrapper',
    manageTableEmpty: 'manage-table-empty',
    manageTableBody: 'manage-table-body',
    btnSettings: 'btn-settings',
    settingsModal: 'settings-modal',
    settingsForm: 'settings-form',
    settingsWelcome: 'settings-welcome',
    settingsAlbumStatus: 'settings-album-status',
    settingsDevices: 'settings-devices'
};
window.ELEMENTS = Object.fromEntries(Object.entries(ELEMENT_IDS).map(([key, id]) => {
    const element = document.getElementById(id);
    if (!element) console.error(`Failed to find element: ${id}`);
    return [key + 'El', element];
}));

const STAGE_ORIENTATIONS = { 1: 'portrait', 2: 'landscape' };  // stage 3 is review

const orientationName = orientation => orientation[0].toUpperCase() + orientation.slice(1);

function orientationSize(orientation) {
    const { width, height } = getDimensions(orientation);
    return `(${width}×${height})`;
}

const show = (element, visible) => { element.style.display = visible ? 'block' : 'none'; };

/** Render the stage indicator, buttons and editor tools for APP_STATE.currentStage. */
function updateStage() {
    if (!APP_STATE.initialized || APP_STATE.syncing) return;
    const stage = APP_STATE.currentStage;
    const orientation = STAGE_ORIENTATIONS[stage];
    const review = !orientation;
    const E = ELEMENTS;

    for (const n of [1, 2, 3]) {
        const state = n < stage ? ' completed' : n === stage ? ' active' : '';
        E[`stage${n}El`].className = 'stage-dot' + state;
        E[`stage${n}LabelEl`].className = 'stage-label' + state;
    }
    E.btnBackEl.disabled = stage === 1;
    show(E.btnCropEl, !review);
    show(E.btnSkipEl, !review);
    show(E.btnSaveEl, review);
    E.cropResolutionEl.hidden = review;
    E.editorViewEl.classList.toggle('reviewing', review);

    if (review) {
        E.stageNameEl.innerHTML = '<strong>Review</strong> Crops';
        const hasPortrait = APP_STATE.portraitCrop.width > 0;
        const hasLandscape = APP_STATE.landscapeCrop.width > 0;
        for (const [o, has] of [['portrait', hasPortrait], ['landscape', hasLandscape]]) {
            show(E[o + 'PreviewEl'], has);
            E[o + 'PreviewEl'].querySelector('.frame-label').textContent = `${orientationName(o)} ${orientationSize(o)}`;
        }
        // With both orientations skipped, the save button skips the image instead.
        const anyCrop = hasPortrait || hasLandscape;
        E.btnSaveEl.innerHTML = anyCrop
            ? '<i class="fas fa-save"></i> Upload Crops'
            : '<i class="fas fa-forward"></i> Skip Image';
        E.btnSaveEl.className = `btn btn-meural ${anyCrop ? 'btn-success' : 'btn-warning'}`;
        E.btnMeuralPreviewEl.disabled = !anyCrop;
        E.btnMeuralPreviewEl.title = anyCrop ? 'Preview on Meural' : 'No crops available to preview';
    } else {
        const name = orientationName(orientation);
        E.stageNameEl.innerHTML = `<strong>${name}</strong> Crop ${orientationSize(orientation)}`;
        E.btnSkipEl.innerHTML = `<i class="fas fa-forward"></i> Skip ${name}`;
    }

    if (!APP_STATE.currentImage) return;
    show(E.previewViewEl, review);
    if (review) {
        show(E.cropOverlayEl, false);
        show(E.cropRectangleEl, false);
    }
    // Wait a frame so the editor has its final layout before sizing the crop box.
    requestAnimationFrame(() => {
        if (APP_STATE.syncing) return;
        showView('editor-view');
        if (!review && APP_STATE.currentImage) {
            show(E.cropOverlayEl, true);
            show(E.cropRectangleEl, true);
            initCropRectangle(getAspectRatio(orientation));
        }
    });
}

/** Change view synchronously; layout is owned by the crop engine. */
function showView(viewName) {
    const editing = viewName === 'editor-view' && !!APP_STATE.currentImage;
    // '' falls back to the stylesheet's flex layout.
    ELEMENTS.editorViewEl.style.display = editing ? '' : 'none';
    ELEMENTS.noImageViewEl.style.display = editing ? 'none' : '';
    // On phones this switches between the library and the editor pane.
    document.body.classList.toggle('editing', editing);
    if (!editing) {
        ELEMENTS.cropOverlayEl.style.display = 'none';
        ELEMENTS.cropRectangleEl.style.display = 'none';
        ELEMENTS.previewViewEl.style.display = 'none';
    }
}

/**
 * Non-blocking notification (replaces alert). Errors stay longer; click to dismiss.
 * @param {string} type - 'info', 'success' or 'error'
 */
function showToast(message, type = 'info') {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
        stack = makeElement('div', 'toast-stack');
        stack.id = 'toast-stack';
        document.body.appendChild(stack);
    }
    const toast = makeElement('div', `app-toast ${type}`, message);
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const dismiss = () => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    };
    toast.addEventListener('click', dismiss);
    stack.appendChild(toast);
    setTimeout(dismiss, type === 'error' ? 8000 : 3000);
}

/**
 * Promise-based confirmation in the app's dialog style (replaces confirm).
 * Enter confirms, Escape or a click outside cancels.
 */
function confirmDialog(message, confirmLabel = 'OK', danger = false) {
    return new Promise(resolve => {
        const overlay = makeElement('div', 'meural-device-dialog confirm-dialog');
        const content = makeElement('div', 'meural-device-dialog-content');
        const buttons = makeElement('div', 'dialog-buttons');
        const cancel = makeElement('button', 'btn btn-meural btn-secondary', 'Cancel');
        const ok = makeElement('button', `btn btn-meural${danger ? ' btn-danger' : ''} confirm-ok`, confirmLabel);
        const close = result => {
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            resolve(result);
        };
        // Capture phase, so Escape here does not also close the Manage modal underneath.
        const onKey = event => {
            if (event.key !== 'Escape' && event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            close(event.key === 'Enter');
        };
        cancel.addEventListener('click', () => close(false));
        ok.addEventListener('click', () => close(true));
        overlay.addEventListener('click', event => { if (event.target === overlay) close(false); });
        document.addEventListener('keydown', onKey, true);
        buttons.append(cancel, ok);
        content.append(makeElement('p', 'confirm-message', message), buttons);
        overlay.append(content);
        document.body.append(overlay);
        ok.focus();
    });
}

