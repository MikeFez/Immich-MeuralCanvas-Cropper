/**
 * ui-controller.js - UI State Management
 */

// Initialize required elements that might be missing
function ensureElementsInitialized() {
    if (!window.ELEMENTS.portraitPreviewImgEl) {
        window.ELEMENTS.portraitPreviewImgEl = document.getElementById('portrait-preview-img');
    }
    if (!window.ELEMENTS.landscapePreviewImgEl) {
        window.ELEMENTS.landscapePreviewImgEl = document.getElementById('landscape-preview-img');
    }
    if (!window.ELEMENTS.imageGridEl) {
        window.ELEMENTS.imageGridEl = document.getElementById('image-grid');
    }
    if (!window.ELEMENTS.editorViewEl) {
        window.ELEMENTS.editorViewEl = document.getElementById('editor-view');
    }
    if (!window.ELEMENTS.noImageViewEl) {
        window.ELEMENTS.noImageViewEl = document.getElementById('no-image-view');
    }
    if (!window.ELEMENTS.previewViewEl) {
        window.ELEMENTS.previewViewEl = document.getElementById('preview-view');
    }
    if (!window.ELEMENTS.cropOverlayEl) {
        window.ELEMENTS.cropOverlayEl = document.getElementById('crop-overlay');
    }
    if (!window.ELEMENTS.cropRectangleEl) {
        window.ELEMENTS.cropRectangleEl = document.getElementById('crop-rectangle');
    }
}

function updateStage() {
    const { currentStage, portraitCrop, landscapeCrop } = APP_STATE;

    // Early return if we're not initialized or in a sync operation
    if (!APP_STATE.initialized || APP_STATE.syncing) {
        console.log("Skipping stage update - app not ready or syncing");
        return;
    }

    // Ensure all required elements are initialized
    ensureElementsInitialized();

    console.log("Updating stage:", {
        currentStage,
        timestamp: new Date().toISOString()
    });

    const {
        stage1El, stage2El, stage3El,
        stage1LabelEl, stage2LabelEl, stage3LabelEl,
        stageNameEl, btnSkipEl, btnBackEl,
        cropRectangleEl, cropOverlayEl, previewViewEl,
        btnCropEl, btnSaveEl, editorViewEl, noImageViewEl,
        portraitPreviewImgEl, landscapePreviewImgEl
    } = ELEMENTS;

    // Reset stage indicators
    [stage1El, stage2El, stage3El].forEach(el => el.className = 'stage-dot');
    [stage1LabelEl, stage2LabelEl, stage3LabelEl].forEach(el => el.className = 'stage-label');

    // Update stage-specific UI
    if (currentStage === 1) {
        // Portrait stage
        stage1El.className = 'stage-dot active';
        stage1LabelEl.className = 'stage-label active';
        const portraitDims = getDimensions('portrait');
        stageNameEl.innerHTML = `<strong>Portrait</strong> Crop (${portraitDims.width}×${portraitDims.height})`;
        btnSkipEl.innerHTML = '<i class="fas fa-forward"></i> Skip Portrait';
        btnBackEl.disabled = true;

        requestAnimationFrame(() => {
            if (!APP_STATE.syncing) {
                // Make sure crop overlay and rectangle are visible
                cropOverlayEl.style.display = 'block';
                cropRectangleEl.style.display = 'block';
                previewViewEl.style.display = 'none';

                // Initialize the crop rectangle with proper size
                initCropRectangle(getAspectRatio('portrait'));
            }
        });
    }
    else if (currentStage === 2) {
        // Landscape stage
        stage1El.className = 'stage-dot completed';
        stage2El.className = 'stage-dot active';
        stage1LabelEl.className = 'stage-label completed';
        stage2LabelEl.className = 'stage-label active';
        const landscapeDims = getDimensions('landscape');
        stageNameEl.innerHTML = `<strong>Landscape</strong> Crop (${landscapeDims.width}×${landscapeDims.height})`;
        btnSkipEl.innerHTML = '<i class="fas fa-forward"></i> Skip Landscape';
        btnBackEl.disabled = false;

        // When coming back from review stage, ensure crop elements are properly visible
        requestAnimationFrame(() => {
            if (!APP_STATE.syncing) {
                // Make sure crop overlay and rectangle are visible
                cropOverlayEl.style.display = 'block';
                cropRectangleEl.style.display = 'block';
                previewViewEl.style.display = 'none';

                // Initialize the crop rectangle with proper size
                initCropRectangle(getAspectRatio('landscape'));
            }
        });
    }
    else if (currentStage === 3) {
        // Review stage
        stage1El.className = 'stage-dot completed';
        stage2El.className = 'stage-dot completed';
        stage3El.className = 'stage-dot active';
        stage1LabelEl.className = 'stage-label completed';
        stage2LabelEl.className = 'stage-label completed';
        stage3LabelEl.className = 'stage-label active';
        stageNameEl.innerHTML = '<strong>Review</strong> Crops';
        btnBackEl.disabled = false;

        // Update UI elements for preview stage
        cropRectangleEl.style.display = 'none';
        cropOverlayEl.style.display = 'none';
        previewViewEl.style.display = 'block';
        btnCropEl.style.display = 'none';
        btnSkipEl.style.display = 'none';

        // Check crop status
        const hasPortrait = portraitCrop.width > 0;
        const hasLandscape = landscapeCrop.width > 0;

        // Show/hide previews based on crop status
        const portraitPreviewEl = document.getElementById('portrait-preview');
        const landscapePreviewEl = document.getElementById('landscape-preview');

        if (portraitPreviewEl && landscapePreviewEl) {
            portraitPreviewEl.style.display = hasPortrait ? 'block' : 'none';
            landscapePreviewEl.style.display = hasLandscape ? 'block' : 'none';

            // Update frame labels with dimensions
            const portraitDims = getDimensions('portrait');
            const landscapeDims = getDimensions('landscape');

            const portraitLabel = portraitPreviewEl.querySelector('.frame-label');
            const landscapeLabel = landscapePreviewEl.querySelector('.frame-label');

            if (portraitLabel) {
                portraitLabel.textContent = `Portrait (${portraitDims.width}×${portraitDims.height})`;
            }

            if (landscapeLabel) {
                landscapeLabel.textContent = `Landscape (${landscapeDims.width}×${landscapeDims.height})`;
            }
        }

        // Check if both orientations are skipped (no crops)
        if (!hasPortrait && !hasLandscape) {
            // Both orientations skipped - show "Skip Image" button and disable preview
            btnSaveEl.style.display = 'block';
            btnSaveEl.innerHTML = '<i class="fas fa-forward"></i> Skip Image';
            btnSaveEl.className = 'btn btn-meural btn-warning';

            // Disable preview button
            if (ELEMENTS.btnMeuralPreviewEl) {
                ELEMENTS.btnMeuralPreviewEl.disabled = true;
                ELEMENTS.btnMeuralPreviewEl.title = 'No crops available to preview';
            }
        } else {
            // At least one orientation has crops - show normal "Upload Crops" button
            btnSaveEl.style.display = 'block';
            btnSaveEl.innerHTML = '<i class="fas fa-save"></i> Upload Crops';
            btnSaveEl.className = 'btn btn-meural btn-success';

            // Enable preview button
            if (ELEMENTS.btnMeuralPreviewEl) {
                ELEMENTS.btnMeuralPreviewEl.disabled = false;
                ELEMENTS.btnMeuralPreviewEl.title = 'Preview on Meural';
            }
        }

        // Note: No longer automatically reset to stage 1 when no crops are set
        // This is now handled by the skip button logic to properly navigate to next image
    }

    // Only show/hide views during stage updates if not syncing and in edit mode
    if (!APP_STATE.syncing && APP_STATE.currentImage) {
        if (currentStage === 3) {
            // Review stage - show preview, hide crop tools
            previewViewEl.style.display = 'block';
            cropOverlayEl.style.display = 'none';
            cropRectangleEl.style.display = 'none';

            // Make sure crop button is hidden and save button is shown
            if (ELEMENTS.btnCropEl) ELEMENTS.btnCropEl.style.display = 'none';
            if (ELEMENTS.btnSaveEl) ELEMENTS.btnSaveEl.style.display = 'block';
            if (ELEMENTS.btnSkipEl) ELEMENTS.btnSkipEl.style.display = 'none';
        } else {
            // Editing stages (1 or 2) - hide preview, show crop tools
            previewViewEl.style.display = 'none';

            // Make sure crop button is shown and save button is hidden
            if (ELEMENTS.btnCropEl) ELEMENTS.btnCropEl.style.display = 'block';
            if (ELEMENTS.btnSaveEl) ELEMENTS.btnSaveEl.style.display = 'none';
            if (ELEMENTS.btnSkipEl) ELEMENTS.btnSkipEl.style.display = 'block';

            // Ensure crop tools are visible during editing stages
            requestAnimationFrame(() => {
                if (!APP_STATE.syncing) {
                    cropOverlayEl.style.display = 'block';
                    cropRectangleEl.style.display = 'block';
                }
            });
        }

        requestAnimationFrame(() => {
            if (!APP_STATE.syncing) showView('editor-view');
        });
    }
}

/** Change view synchronously; layout is owned by the crop engine. */
function showView(viewName) {
    ensureElementsInitialized();
    const editing = viewName === 'editor-view' && !!APP_STATE.currentImage;
    // '' falls back to the stylesheet's flex layout.
    ELEMENTS.editorViewEl.style.display = editing ? '' : 'none';
    ELEMENTS.noImageViewEl.style.display = editing ? 'none' : '';
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

document.addEventListener('DOMContentLoaded', ensureElementsInitialized);
