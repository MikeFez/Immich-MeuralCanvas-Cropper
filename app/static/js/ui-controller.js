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

        requestAnimationFrame(() => {
            if (!APP_STATE.syncing) {
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
        btnSaveEl.style.display = 'block';
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

        // Return to stage 1 if no crops are set
        if (!hasPortrait && !hasLandscape) {
            APP_STATE.currentStage = 1;
            requestAnimationFrame(() => {
                if (!APP_STATE.syncing) {
                    updateStage();
                }
            });
            return;
        }
    }

    // Only show/hide views during stage updates if not syncing and in edit mode
    if (!APP_STATE.syncing && APP_STATE.currentImage) {
        if (currentStage === 3) {
            // Review stage - show preview
            previewViewEl.style.display = 'block';
            cropOverlayEl.style.display = 'none';
            cropRectangleEl.style.display = 'none';
        } else {
            // Editing stages
            previewViewEl.style.display = 'none';

            // Ensure crop tools are visible during editing stages
            requestAnimationFrame(() => {
                if (!APP_STATE.syncing) {
                    cropOverlayEl.style.display = 'block';
                    cropRectangleEl.style.display = 'block';
                }
            });
        }

        requestAnimationFrame(() => {
            if (!APP_STATE.syncing && !isViewTransitioning) {
                editorViewEl.style.display = 'block';
                noImageViewEl.style.display = 'none';
                document.body.classList.add('has-image');
            }
        });
    }
}

// Track view transitions
let isViewTransitioning = false;

/**
 * Show either editor or no-image view
 * @param {string} viewName - 'editor-view' or 'no-image-view'
 */
function showView(viewName) {
    // Prevent view changes during operations
    if (APP_STATE.syncing || isViewTransitioning) {
        console.log('View change blocked:', {
            syncing: APP_STATE.syncing,
            transitioning: isViewTransitioning,
            requestedView: viewName,
            timestamp: new Date().toISOString()
        });
        return;
    }

    // Ensure all required elements are initialized
    ensureElementsInitialized();

    isViewTransitioning = true;

    try {
        if (viewName === 'editor-view' && APP_STATE.currentImage) {
            requestAnimationFrame(() => {
                if (!APP_STATE.syncing) {
                    // First clear all display states
                    ELEMENTS.previewViewEl.style.display = 'none';
                    ELEMENTS.cropOverlayEl.style.display = 'none';
                    ELEMENTS.cropRectangleEl.style.display = 'none';

                    // Then show editor view
                    ELEMENTS.editorViewEl.style.display = 'block';
                    ELEMENTS.noImageViewEl.style.display = 'none';
                    document.body.classList.add('has-image');

                    // Only call forceImageFit once to ensure proper sizing
                    setTimeout(() => {
                        if (!APP_STATE.syncing) {
                            forceImageFit();
                        }
                    }, 50);

                    // Only show crop overlay in edit mode and not preview
                    if (APP_STATE.currentStage !== 3 && !APP_STATE.syncing) {
                        // Add a slight delay for DOM updates to complete
                        setTimeout(() => {
                            if (!APP_STATE.syncing) {
                                ELEMENTS.cropOverlayEl.style.display = 'block';
                                ELEMENTS.cropRectangleEl.style.display = 'block';

                                // No need to call initCropRectangle here, forceImageFit will do it
                            }
                        }, 70);
                    } else if (APP_STATE.currentStage === 3) {
                        // Show preview in review stage
                        ELEMENTS.previewViewEl.style.display = 'block';
                    }
                }
                isViewTransitioning = false;
            });
        } else {
            requestAnimationFrame(() => {
                if (!APP_STATE.syncing) {
                    // Hide all editor elements
                    ELEMENTS.editorViewEl.style.display = 'none';
                    ELEMENTS.cropOverlayEl.style.display = 'none';
                    ELEMENTS.cropRectangleEl.style.display = 'none';
                    ELEMENTS.previewViewEl.style.display = 'none';

                    // Show no-image view
                    ELEMENTS.noImageViewEl.style.display = 'block';
                    document.body.classList.remove('has-image');
                }
                isViewTransitioning = false;
            });
        }
    } catch (error) {
        console.error('Error during view transition:', error);
        isViewTransitioning = false;
    }
}

/**
 * CSS for loading indicator
 */
function addLoadingIndicatorStyles() {
    const style = document.createElement('style');
    style.textContent = `
    .loading-indicator {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        display: flex;
        justify-content: center;
        align-items: center;
        background-color: rgba(255, 255, 255, 0.5);
        font-size: 2rem;
        color: var(--primary-color);
    }

    .frame-mat {
        position: relative;
    }
    `;
    document.head.appendChild(style);
}

// Ensure preview elements are initialized on load
document.addEventListener('DOMContentLoaded', function() {
    ensureElementsInitialized();
    addLoadingIndicatorStyles();

    // Initialize grid view on load
    const imageGridEl = document.getElementById('image-grid');
    if (imageGridEl) {
        imageGridEl.style.display = 'grid';
    }
});

// Enhanced resize handling
window.addEventListener('resize', function() {
    if (APP_STATE.currentImage && !APP_STATE.syncing) {
        // Debounce resize handling
        if (window.resizeTimer) clearTimeout(window.resizeTimer);
        window.resizeTimer = setTimeout(function() {
            forceImageFit();

            // After forcing image fit, reinitialize crop rectangle if needed
            if (APP_STATE.currentStage === 1 || APP_STATE.currentStage === 2) {
                const orientation = APP_STATE.currentStage === 1 ? 'portrait' : 'landscape';
                initCropRectangle(getAspectRatio(orientation));
            }
        }, 250);
    }
});

// Also handle orientation change for mobile devices
window.addEventListener('orientationchange', function() {
    if (APP_STATE.currentImage && !APP_STATE.syncing) {
        // Add a delay to ensure orientation change is complete
        setTimeout(function() {
            forceImageFit();

            // After forcing image fit, reinitialize crop rectangle if needed
            if (APP_STATE.currentStage === 1 || APP_STATE.currentStage === 2) {
                const orientation = APP_STATE.currentStage === 1 ? 'portrait' : 'landscape';
                initCropRectangle(getAspectRatio(orientation));
            }
        }, 300);
    }
});
