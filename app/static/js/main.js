/**
 * main.js - Entry point for Meural Canvas Image Cropper
 */

// Initialize application state and elements
async function initializeApp() {
    if (window.APP_STATE.initialized) {
        console.warn('Application already initialized');
        return;
    }

    console.log('Starting application initialization...');

    // 1. Cache DOM elements
    const elements = {
        imageGrid: 'image-grid',
        imageCount: 'image-count',
        currentImage: 'current-image',
        cropRectangle: 'crop-rectangle',
        cropOverlay: 'crop-overlay',
        editorView: 'editor-view',
        noImageView: 'no-image-view',
        previewView: 'preview-view',
        portraitPreview: 'portrait-preview-img',
        landscapePreview: 'landscape-preview-img',
        stageName: 'stage-name',
        editorContainer: 'editor-container',
        stage1Label: 'stage-1-label',
        stage2Label: 'stage-2-label',
        stage3Label: 'stage-3-label',
        btnBack: 'btn-back',
        btnSkip: 'btn-skip',
        btnReset: 'btn-reset',
        btnCrop: 'btn-crop',
        btnSave: 'btn-save',
        btnImmichSync: 'btn-immich-sync',
        btnImmichUpload: 'btn-immich-upload',
        btnMeuralPreview: 'btn-meural-preview',
        stage1: 'stage-1',
        stage2: 'stage-2',
        stage3: 'stage-3'
    };

    // Cache all elements consistently using window.ELEMENTS
    Object.entries(elements).forEach(([key, id]) => {
        window.ELEMENTS[key + 'El'] = document.getElementById(id);
        if (!window.ELEMENTS[key + 'El']) {
            console.error(`Failed to find element: ${id}`);
        }
    });

    // 2. Set initial view states - show landing page by default
    window.ELEMENTS.editorViewEl.style.display = 'none';
    window.ELEMENTS.noImageViewEl.style.display = 'block';

    // 3. Setup button handlers - only once!
    const setupButtonHandler = (button, handler) => {
        if (!button || button._hasHandler) return; // Skip if button not found or already has handler

        button.addEventListener('click', handler);
        button._hasHandler = true;
    };

    setupButtonHandler(window.ELEMENTS.btnCropEl, () => {
        if (!window.APP_STATE.syncing) {
            if (window.APP_STATE.currentStage === 1) {
                performCrop('portrait');
                window.APP_STATE.currentStage = 2;
            } else if (window.APP_STATE.currentStage === 2) {
                performCrop('landscape');
                window.APP_STATE.currentStage = 3;
            }
            updateStage();
        }
    });

    setupButtonHandler(window.ELEMENTS.btnSkipEl, () => {
        if (!window.APP_STATE.syncing) {
            if (window.APP_STATE.currentStage === 1) {
                window.APP_STATE.portraitCrop = { x: 0, y: 0, width: 0, height: 0 };
                window.APP_STATE.currentStage = 2;
            } else if (window.APP_STATE.currentStage === 2) {
                window.APP_STATE.landscapeCrop = { x: 0, y: 0, width: 0, height: 0 };
                window.APP_STATE.currentStage = 3;
            }
            updateStage();
        }
    });

    setupButtonHandler(window.ELEMENTS.btnBackEl, () => {
        if (!window.APP_STATE.syncing) {
            if (window.APP_STATE.currentStage === 2) {
                window.APP_STATE.currentStage = 1;
            } else if (window.APP_STATE.currentStage === 3) {
                // When going back from review stage to landscape crop stage,
                // set viewport resizing flag to force crop rectangle to be properly sized
                window._viewportResizing = true;
                window.APP_STATE.currentStage = 2;
                window.ELEMENTS.btnSkipEl.style.display = 'block';
            }

            updateStage();
        }
    });

    setupButtonHandler(window.ELEMENTS.btnResetEl, () => {
        if (!window.APP_STATE.syncing) {
            resetImage();
        }
    });

    setupButtonHandler(window.ELEMENTS.btnSaveEl, () => {
        if (!window.APP_STATE.syncing) {
            completeImage();
        }
    });

    // Setup Immich sync button handler
    setupButtonHandler(window.ELEMENTS.btnImmichSyncEl, () => {
        if (!window.APP_STATE.syncing && window.APP_STATE.initialized) {
            window.ELEMENTS.btnImmichSyncEl.disabled = true;
            syncWithImmich()
                .catch(error => {
                    console.error('Sync failed:', error);
                })
                .finally(() => {
                    window.ELEMENTS.btnImmichSyncEl.disabled = false;
                });
        }
    });

    setupButtonHandler(window.ELEMENTS.btnImmichUploadEl, () => {
        if (!window.APP_STATE.syncing && window.APP_STATE.initialized) {
            window.ELEMENTS.btnImmichUploadEl.disabled = true;
            uploadAllToImmich()
                .finally(() => {
                    window.ELEMENTS.btnImmichUploadEl.disabled = false;
                });
        }
    });

    // Setup Meural preview button handler
    setupButtonHandler(window.ELEMENTS.btnMeuralPreviewEl, () => {
        if (!window.APP_STATE.syncing && window.APP_STATE.initialized) {
            previewCurrentOnMeural();
        }
    });

    // Debounced resize handler
    const debouncedForceImageFit = debounce(() => {
        if (window.ELEMENTS.currentImageEl?.complete && !window.APP_STATE.syncing) {
            forceImageFit();
        }
    }, 250);

    // Responsive event listeners
    window.addEventListener('resize', debouncedForceImageFit);
    window.addEventListener('orientationchange', () => setTimeout(debouncedForceImageFit, 300));

    // 4. Load initial images - WITHOUT sync
    try {
        console.log('Loading initial images without sync...');

        // Just load the image list directly
        const response = await fetch('/images');
        const imageList = await response.json();

        // Update state
        window.APP_STATE.imageList = imageList;
        console.log(`Loaded ${imageList.length} images`);

        // Render grid view
        renderImageList();

        // Show initial view - proper landing page when no image is selected
        window.APP_STATE.currentImage = null;
        // Explicitly set the views
        window.ELEMENTS.editorViewEl.style.display = 'none';
        window.ELEMENTS.noImageViewEl.style.display = 'block';
        document.body.classList.remove('has-image');

        // Set initialized state
        window.APP_STATE.initialized = true;
        console.log('Application initialization complete');

        // Initialize filter
        initializeFilter();

        // Add click event delegation for the image grid to ensure it works with the landing page
        document.getElementById('image-grid').addEventListener('click', (e) => {
            const gridItem = e.target.closest('.image-grid-item');
            if (gridItem && !window.APP_STATE.syncing) {
                const identifier = gridItem.getAttribute('data-identifier');
                if (identifier) {
                    selectImage(identifier);
                }
            }
        });

    } catch (error) {
        console.error('Failed to initialize:', error);
        if (window.ELEMENTS.imageGridEl) {
            window.ELEMENTS.imageGridEl.innerHTML = '<div class="alert alert-danger m-3">Error loading images</div>';
        }
        showView('no-image-view');
    }
}

// Utility function for debouncing
function debounce(fn, delay) {
    let timeoutId;
    return (...args) => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delay);
    };
}

// Initialize only once when DOM is ready
let initStarted = false;
function safeInitialize() {
    if (initStarted || window.APP_STATE.initialized) {
        console.log('Initialization already in progress or complete');
        return;
    }

    initStarted = true;
    initializeApp().catch(error => {
        console.error('Initialization failed:', error);
        initStarted = false;
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInitialize, { once: true });
} else {
    safeInitialize();
}

// Initialize filter
function initializeFilter() {
    if (document.getElementById('show-unprocessed-only')) {
        setupUnprocessedFilter();
    } else {
        // If filter not found in DOM yet, retry after a short delay
        setTimeout(initializeFilter, 100);
    }
}
