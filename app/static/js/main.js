/**
 * main.js - Entry point for Meural Canvas Image Cropper
 */

// Initialize application state and elements
async function initializeApp() {
    if (window.APP_STATE.initialized) {
        console.warn('Application already initialized');
        return;
    }

    await (window.configReady || (window.configReady = initializeConfig()));
    console.log('Starting application initialization...');

    // Setup button handlers - only once!
    const setupButtonHandler = (button, handler) => {
        if (!button || button._hasHandler) return; // Skip if button not found or already has handler

        button.addEventListener('click', handler);
        button._hasHandler = true;
    };

    async function runCropAction(action) {
        if (window.APP_STATE.syncing || window.APP_STATE.cropBusy) return;
        window.APP_STATE.cropBusy = true;
        const controls = ['btnCropEl', 'btnSkipEl', 'btnBackEl', 'btnResetEl', 'btnSaveEl',
            'btnImmichSyncEl', 'btnImmichUploadEl', 'btnMeuralPreviewEl'];
        const buttons = controls.map(key => [window.ELEMENTS[key], window.ELEMENTS[key]?.disabled]);
        buttons.forEach(([button]) => { if (button) button.disabled = true; });
        try {
            await action();
        } catch (error) {
            showToast(error.message || String(error), 'error');
        } finally {
            window.APP_STATE.cropBusy = false;
            buttons.forEach(([button, disabled]) => { if (button) button.disabled = disabled; });
            updateStage();
        }
    }

    setupButtonHandler(window.ELEMENTS.btnCropEl, () => runCropAction(async () => {
        const stage = window.APP_STATE.currentStage;
        if (stage !== 1 && stage !== 2) return;
        await performCrop(stage === 1 ? 'portrait' : 'landscape');
        window.APP_STATE.currentStage = stage + 1;
    }));

    setupButtonHandler(window.ELEMENTS.btnSkipEl, () => runCropAction(async () => {
        const currentImage = window.APP_STATE.currentImage;
        const stage = window.APP_STATE.currentStage;
        if (!currentImage || (stage !== 1 && stage !== 2)) return;
        const orientation = stage === 1 ? 'portrait' : 'landscape';
        if (currentImage.uploaded?.[orientation] && !await confirmDialog(
            `This ${orientation} crop is already in Immich. Skipping it moves that copy to the Immich trash.`,
            `Skip ${orientation}`, true)) return;
        await deleteCropMetadata(currentImage.asset_id, orientation);
        window.APP_STATE[orientation + 'Crop'] = { x: 0, y: 0, width: 0, height: 0 };
        clearPreviewImage(orientation);
        window.APP_STATE.currentStage = stage + 1;
    }));

    setupButtonHandler(window.ELEMENTS.btnBackEl, () => {
        if (!window.APP_STATE.syncing) {
            if (window.APP_STATE.currentStage === 2) {
                window.APP_STATE.currentStage = 1;
            } else if (window.APP_STATE.currentStage === 3) {
                window.APP_STATE.currentStage = 2;
            }

            updateStage();
        }
    });

    // On Review, clicking a framed crop goes back to adjust it.
    for (const frame of document.querySelectorAll('#preview-view .photo-frame')) {
        setupButtonHandler(frame, () => {
            if (window.APP_STATE.syncing || window.APP_STATE.cropBusy || window.APP_STATE.currentStage !== 3) return;
            window.APP_STATE.currentStage = Number(frame.dataset.stage);
            updateStage();
        });
    }

    setupButtonHandler(window.ELEMENTS.btnResetEl, () => runCropAction(() => resetImage()));

    setupButtonHandler(window.ELEMENTS.btnSaveEl, () => runCropAction(async () => {
        if (!window.APP_STATE.portraitCrop.width && !window.APP_STATE.landscapeCrop.width) {
            navigateToNextImage();
        } else {
            await completeImage();
        }
    }));

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
                .catch(() => {}) // The API service already reports upload errors.
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

    setupEditorResize();

    // 4. Load initial images - WITHOUT sync
    try {
        // Note which sync the list reflects, so a startup or scheduled sync refreshes it.
        await watchBackgroundJobs();
        setInterval(watchBackgroundJobs, 15000);

        console.log('Loading initial images without sync...');

        // Just load the image list directly
        const response = await fetch('/images');
        const imageList = await response.json();

        // Update state
        window.APP_STATE.imageList = imageList;
        console.log(`Loaded ${imageList.length} images`);

        // Render grid view
        renderImageList();

        // Show the landing page until an image is selected
        window.APP_STATE.currentImage = null;
        showView('no-image-view');

        // Set initialized state
        window.APP_STATE.initialized = true;
        console.log('Application initialization complete');

        // First run: nothing works until Immich is connected.
        const settings = await (await fetch('/settings')).json();
        if (!settings.configured) showSettingsModal();
    } catch (error) {
        console.error('Failed to initialize:', error);
        if (window.ELEMENTS.imageGridEl) {
            window.ELEMENTS.imageGridEl.innerHTML = '<div class="alert alert-danger m-3">Error loading images</div>';
        }
        showView('no-image-view');
    }
}

// Scripts load at the end of <body>; initializeApp itself refuses a second run.
initializeApp().catch(error => console.error('Initialization failed:', error));

/**
 * Navigate to the next image in the list
 */
function navigateToNextImage() {
    const currentImage = window.APP_STATE.currentImage;
    const imageList = window.APP_STATE.imageList;

    if (!currentImage || !imageList) return;

    // Find the current image index
    const currentIndex = imageList.findIndex(img =>
        img.asset_id === currentImage.asset_id
    );

    if (currentIndex === -1) {
        console.error('Current image not found in image list');
        return;
    }

    // Check if the unprocessed filter is active
    const filterSwitch = window.ELEMENTS.unprocessedFilterEl;
    const showOnlyUnprocessed = filterSwitch && filterSwitch.checked;

    // Helper function to check if an image is visible (not filtered)
    function isImageVisible(image) {
        if (!showOnlyUnprocessed) return true;

        // When filter is active, only show unprocessed images
        return image.status !== 'completed';
    }

    // Go to the next image in sequence
    let nextIndex = currentIndex + 1;
    let attempts = 0;
    const maxAttempts = imageList.length;

    // Keep looking for the next visible image
    while (attempts < maxAttempts) {
        // If we're at the end of the list, wrap around to the beginning
        if (nextIndex >= imageList.length) {
            nextIndex = 0;
        }

        // If we've wrapped around and are back to the same image, we've checked all
        if (nextIndex === currentIndex) {
            break;
        }

        const candidateImage = imageList[nextIndex];

        if (candidateImage && isImageVisible(candidateImage)) {
            // Found a visible image, select it
            requestAnimationFrame(() => {
                if (!window.APP_STATE.syncing) {
                    selectImage(candidateImage.asset_id);
                }
            });
            return;
        }

        nextIndex++;
        attempts++;
    }

    // No visible images found - either all are processed or filter shows nothing
    requestAnimationFrame(() => {
        if (!window.APP_STATE.syncing) {
            window.APP_STATE.currentImage = null;
            if (window.ELEMENTS.currentImageEl) {
                window.ELEMENTS.currentImageEl.style.display = 'none';
            }
            showView('no-image-view');

            if (showOnlyUnprocessed) {
                showToast('All unprocessed images are done. Turn off the filter to see all images.', 'success');
            } else {
                showToast('All images have been processed!', 'success');
            }
        }
    });
}
