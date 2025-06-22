/**
 * image-loader.js - Image loading and selection functionality
 */

/**
 * Load image list from server without triggering sync
 * @param {boolean} skipStateCheck - Skip state checks for initial load
 */
let imageLoadPromise = null;

async function loadImageList(skipStateCheck = false) {
    // Don't load if another load is in progress
    if (imageLoadPromise) {
        console.log("Skipping - load already in progress");
        return imageLoadPromise;
    }

    // Only check state if not skipping checks (for initial load)
    if (!skipStateCheck && (window.APP_STATE.syncing || !window.APP_STATE.initialized)) {
        console.log("Skipping image list load - invalid state", {
            syncing: window.APP_STATE.syncing,
            initialized: window.APP_STATE.initialized,
            timestamp: new Date().toISOString()
        });
        return Promise.resolve(window.APP_STATE.imageList);
    }

    console.log("Loading image list...");

    // Track this load attempt
    imageLoadPromise = (async () => {
        try {
            // Direct fetch without syncing first
            const response = await fetch('/images');
            const data = await response.json();

            console.log("Received image data:", data);

            // Only update if we have new data
            const currentList = JSON.stringify(window.APP_STATE.imageList);
            const newList = JSON.stringify(data);

            if (currentList !== newList) {
                window.APP_STATE.imageList = data;
                // Don't trigger renders during initialization
                if (window.APP_STATE.initialized && !window.APP_STATE.syncing) {
                    requestAnimationFrame(() => renderImageList());
                }
            } else {
                console.log("Image list unchanged - skipping update");
            }
            return data;
        } catch (error) {
            console.error('Error loading image list:', error);
            if (!skipStateCheck) { // Only show error if not initial load
                window.ELEMENTS.imageGridEl.innerHTML = '<div class="alert alert-danger m-3">Error loading images</div>';
            }
            throw error;
        } finally {
            imageLoadPromise = null;
        }
    })();

    return imageLoadPromise;
}

/**
 * Render image list in grid view
 */
function renderImageList() {
    if (window.APP_STATE.syncing) {
        console.log("Skipping render during sync");
        return;
    }

    const { imageList } = window.APP_STATE;
    const imageGridEl = window.ELEMENTS.imageGridEl;
    const imageCountEl = window.ELEMENTS.imageCountEl;

    if (!imageList || imageList.length === 0) {
        if (imageGridEl) {
            imageGridEl.innerHTML = '<div class="alert alert-info m-3">No images found</div>';
        }
        if (imageCountEl) {
            imageCountEl.textContent = '0';
        }
        return;
    }

    if (imageCountEl) {
        imageCountEl.textContent = imageList.length;
    }

    // Render grid view
    if (imageGridEl) {
        const gridHtml = imageList.map(image => {
            let statusClass = '';
            let statusIcon = '<i class="fas fa-circle text-secondary"></i>';

            // Determine if image has any crops to show split view
            const hasCrops = image.status && image.status !== 'unprocessed';

            if (hasCrops) {
                // Show split icons for images with at least one crop
                const hasPortrait = image.status === 'portrait' || image.status === 'both';
                const hasLandscape = image.status === 'landscape' || image.status === 'both';

                const portraitClass = hasPortrait ? 'text-success' : 'text-secondary';
                const landscapeClass = hasLandscape ? 'text-success' : 'text-secondary';

                statusIcon = `
                    <div class="split-status-icons">
                        <div class="status-icon-circle">
                            <i class="fas fa-mobile-alt ${portraitClass}" title="Portrait"></i>
                        </div>
                        <div class="status-icon-circle">
                            <i class="fas fa-desktop ${landscapeClass}" title="Landscape"></i>
                        </div>
                    </div>
                `;

                if (image.status === 'both') {
                    statusClass = 'completed';
                }
            } else {
                // Single icon for uncropped images
                statusIcon = '<i class="fas fa-circle text-secondary"></i>';
            }

            // Get the display name (original_filename if available, else filename)
            const displayName = image.original_filename || image.filename;

            // Add asset_id to data attributes if available
            const assetIdAttr = image.asset_id ?
                `data-asset-id="${image.asset_id}"` : '';

            // Always include filename attribute for backward compatibility
            const filenameAttr = `data-filename="${image.filename}"`;

            // Use asset_id as the primary identifier if available, otherwise filename
            const identifier = image.asset_id || image.filename;

            // Generate thumbnail URL
            const thumbnailUrl = `/image/${encodeURIComponent(identifier)}?t=${Date.now()}`;

            // Add data-status attribute for filtering
            return `<div class="image-grid-item ${statusClass}" ${assetIdAttr} ${filenameAttr} data-status="${image.status || 'unprocessed'}" data-identifier="${identifier}">
                <div class="thumbnail-container">
                    <img class="thumbnail-image" src="${thumbnailUrl}" alt="${displayName}" loading="lazy">
                    <div class="image-status">${statusIcon}</div>
                </div>
                <div class="image-name">${truncateFilename(displayName, 20)}</div>
            </div>`;
        }).join('');

        // Only update DOM if content has changed
        if (imageGridEl.innerHTML !== gridHtml) {
            imageGridEl.innerHTML = gridHtml;
        }
    }

    // Don't add handlers during sync
    if (!window.APP_STATE.syncing) {
        addImageClickHandlers();
        // Setup filter after rendering the list
        setupUnprocessedFilter();
    }
}

/**
 * Apply unprocessed images filter
 */
function applyUnprocessedFilter() {
    const filterSwitch = document.getElementById('show-unprocessed-only');
    const showOnlyUnprocessed = filterSwitch && filterSwitch.checked;

    // Apply filter to all image grid items
    document.querySelectorAll('.image-grid-item').forEach(item => {
        const status = item.getAttribute('data-status');

        if (showOnlyUnprocessed) {
            // Only show unprocessed images
            if (status === 'unprocessed') {
                item.classList.remove('filtered');
            } else {
                item.classList.add('filtered');
            }
        } else {
            // Show all images
            item.classList.remove('filtered');
        }
    });

    // Update image count to show filtered count - no more division by 2
    const visibleCount = document.querySelectorAll('.image-grid-item:not(.filtered)').length;
    const totalCount = document.querySelectorAll('.image-grid-item').length;
    const imageCountEl = window.ELEMENTS.imageCountEl;
    if (imageCountEl) {
        if (showOnlyUnprocessed) {
            imageCountEl.textContent = `${visibleCount}/${totalCount}`;
        } else {
            imageCountEl.textContent = totalCount;
        }
    }
}

/**
 * Set up unprocessed filter handling
 */
function setupUnprocessedFilter() {
    const filterSwitch = document.getElementById('show-unprocessed-only');
    if (!filterSwitch) return;

    // Add change handler
    filterSwitch.addEventListener('change', function() {
        applyUnprocessedFilter();
    });

    // Initial filter application
    applyUnprocessedFilter();
}

/**
 * Add click handlers to image grid items
 */
function addImageClickHandlers() {
    // Handle grid view items
    document.querySelectorAll('.image-grid-item').forEach(item => {
        // Get primary identifier - prefer asset_id, fallback to filename
        const identifier = item.getAttribute('data-identifier');

        // Remove existing handler if any
        const oldHandler = item._clickHandler;
        if (oldHandler) {
            item.removeEventListener('click', oldHandler);
        }

        // Add new handler
        const newHandler = () => {
            if (!window.APP_STATE.syncing) {
                selectImage(identifier);

                // Update active class
                document.querySelectorAll('.image-grid-item').forEach(i => {
                    if (i.getAttribute('data-identifier') === identifier) {
                        i.classList.add('active');
                    } else {
                        i.classList.remove('active');
                    }
                });
            }
        };
        item._clickHandler = newHandler;
        item.addEventListener('click', newHandler);
    });
}

/**
 * Select image for processing
 */
let isSelectingImage = false;

function selectImage(identifier) {
    if (window.APP_STATE.syncing || isSelectingImage) {
        console.log("Skipping image selection - operation in progress");
        return;
    }

    isSelectingImage = true;

    try {
        // Reset flags for new image selection
        window._loadingNewImage = false;
        window._cropRectangleInitialized = false;

        // Reset state and clear UI
        window.APP_STATE.currentStage = 1;
        window.APP_STATE.portraitCrop = { x: 0, y: 0, width: 0, height: 0 };
        window.APP_STATE.landscapeCrop = { x: 0, y: 0, width: 0, height: 0 };

        // Explicitly reset the view when switching images
        if (window.ELEMENTS.previewViewEl) {
            window.ELEMENTS.previewViewEl.style.display = 'none';
        }
        if (window.ELEMENTS.cropOverlayEl) {
            window.ELEMENTS.cropOverlayEl.style.display = 'none';
        }
        if (window.ELEMENTS.cropRectangleEl) {
            window.ELEMENTS.cropRectangleEl.style.display = 'none';
        }

        // Update selection in both list and grid views
        document.querySelectorAll('.image-list-item, .image-grid-item').forEach(item => {
            item.classList.remove('active');

            // Check if this item matches the identifier
            if (item.getAttribute('data-identifier') === identifier) {
                item.classList.add('active');
            }
        });

        // Find and set current image by matching on asset_id or filename
        window.APP_STATE.currentImage = window.APP_STATE.imageList.find(img =>
            (img.asset_id === identifier) || (img.filename === identifier)
        );

        if (!window.APP_STATE.currentImage) {
            console.error('Image not found:', identifier);
            isSelectingImage = false;
            return;
        }

        // Log which image was selected
        console.log("Selected image:", {
            identifier: identifier,
            asset_id: window.APP_STATE.currentImage.asset_id,
            filename: window.APP_STATE.currentImage.filename
        });

        // Load saved crop data and continue with image loading
        loadSavedCropData(window.APP_STATE.currentImage.asset_id || identifier)
            .then(() => {
                loadImageAndInitCrop(window.APP_STATE.currentImage.asset_id || identifier);
            })
            .catch(error => {
                console.error("Error loading crop data:", error);
                // Continue anyway
                loadImageAndInitCrop(window.APP_STATE.currentImage.asset_id || identifier);
            });
    } catch (error) {
        console.error('Error selecting image:', error);
        window._loadingNewImage = false; // Reset flag on error
        isSelectingImage = false;
    }
}

// Function to load saved crop data from JSON
async function loadSavedCropData(identifier) {
    try {
        // Check for portrait crop data
        const portraitResponse = await fetch(`/crop-data/${encodeURIComponent(identifier)}/portrait`);
        const portraitData = await portraitResponse.json();

        if (portraitData.success && portraitData.crop) {
            window.APP_STATE.portraitCrop = portraitData.crop;
            console.log("Loaded saved portrait crop:", portraitData.crop);
        }

        // Check for landscape crop data
        const landscapeResponse = await fetch(`/crop-data/${encodeURIComponent(identifier)}/landscape`);
        const landscapeData = await landscapeResponse.json();

        if (landscapeData.success && landscapeData.crop) {
            window.APP_STATE.landscapeCrop = landscapeData.crop;
            console.log("Loaded saved landscape crop:", landscapeData.crop);
        }

        return {
            hasPortraitCrop: portraitData.success && portraitData.crop,
            hasLandscapeCrop: landscapeData.success && landscapeData.crop
        };
    } catch (error) {
        console.warn("Error loading crop data:", error);
        return {
            hasPortraitCrop: false,
            hasLandscapeCrop: false
        };
    }
}

// Function to load the image after crop data is retrieved
function loadImageAndInitCrop(identifier) {
    // Get elements
    const currentImageEl = window.ELEMENTS.currentImageEl;
    const previewViewEl = window.ELEMENTS.previewViewEl;
    const btnCropEl = window.ELEMENTS.btnCropEl;
    const btnSaveEl = window.ELEMENTS.btnSaveEl;
    const btnSkipEl = window.ELEMENTS.btnSkipEl;

    // Reset viewport resizing flag when loading a new image
    // This ensures we properly use saved crop data if available
    window._viewportResizing = false;

    // Set flag to indicate we're loading a new image (prevents forceImageFit from overriding)
    window._loadingNewImage = true;

    // Set up image loading with direct sizing
    currentImageEl.onload = function() {
        console.log("Image loaded successfully:", this.naturalWidth, this.naturalHeight);

        // Show editor view properly through the view controller
        showView('editor-view');

        // Make image visible
        currentImageEl.style.display = 'block';

        // Force image to fill container while maintaining aspect ratio
        const containerRect = window.ELEMENTS.editorContainerEl.getBoundingClientRect();
        const containerWidth = containerRect.width - 40; // Leave some margin
        const containerHeight = containerRect.height - 40; // Leave some margin

        // Calculate image scaling to fit container
        const imageRatio = this.naturalWidth / this.naturalHeight;
        const containerRatio = containerWidth / containerHeight;

        let newWidth, newHeight;

        if (imageRatio > containerRatio) {
            // Image is wider than container proportion
            newWidth = containerWidth;
            newHeight = newWidth / imageRatio;
        } else {
            // Image is taller than container proportion
            newHeight = containerHeight;
            newWidth = newHeight * imageRatio;
        }

        // Directly set size on image
        currentImageEl.style.width = newWidth + 'px';
        currentImageEl.style.height = newHeight + 'px';

        console.log("Setting image size to:", newWidth, newHeight);

        // Update UI - ensure we're in the correct state for a new image
        previewViewEl.style.display = 'none';
        btnCropEl.style.display = 'block';
        btnSaveEl.style.display = 'none';
        btnSkipEl.style.display = 'block';

        // Reset crop elements when loading a new image
        if (window.ELEMENTS.cropOverlayEl) {
            window.ELEMENTS.cropOverlayEl.style.display = 'none'; // Will be shown after updateStage
        }
        if (window.ELEMENTS.cropRectangleEl) {
            window.ELEMENTS.cropRectangleEl.style.display = 'none'; // Will be shown after updateStage
        }

        // Store image dimensions for crop calculations
        const imgRect = currentImageEl.getBoundingClientRect();
        window.ELEMENTS.editorContainerEl.dataset.imgLeft = imgRect.left - containerRect.left;
        window.ELEMENTS.editorContainerEl.dataset.imgTop = imgRect.top - containerRect.top;
        window.ELEMENTS.editorContainerEl.dataset.imgWidth = imgRect.width;
        window.ELEMENTS.editorContainerEl.dataset.imgHeight = imgRect.height;

        // Initialize crop controls
        updateStage();
        isSelectingImage = false;
    };

    currentImageEl.onerror = () => {
        console.error('Failed to load image:', identifier);
        window._loadingNewImage = false; // Reset flag on image load error
        showView('no-image-view');
        isSelectingImage = false;
    };

    // Reset all styles on the image
    currentImageEl.removeAttribute('width');
    currentImageEl.removeAttribute('height');
    currentImageEl.style.display = 'none'; // Hide until loaded
    currentImageEl.style.maxWidth = 'none';
    currentImageEl.style.maxHeight = 'none';
    currentImageEl.style.width = 'auto';
    currentImageEl.style.height = 'auto';

    // Load the new image with cache buster
    currentImageEl.src = `/image/${encodeURIComponent(identifier)}?t=${Date.now()}`;
    console.log("Loading image:", identifier);
}

/**
 * Truncate filename if too long
 */
function truncateFilename(filename, maxLength) {
    if (!filename) return "Unknown";
    if (filename.length <= maxLength) return filename;
    const extension = filename.split('.').pop();
    const name = filename.substring(0, filename.length - extension.length - 1);
    return `${name.substring(0, maxLength - extension.length - 3)}...${extension}`;
}