/**
 * crop-engine.js - Core cropping functionality
 *
 * Implements image cropping, positioning, and manipulation
 */

/**
 * Position an element to match exact position of an image
 * @param {HTMLElement} element - Element to position
 * @param {HTMLElement} image - Image to match position
 * @param {HTMLElement} container - Container element
 * @returns {Object|null} Position data or null
 */
function positionElementToImage(element, image, container) {
    if (!element || !image || !container) return null;

    // Get the exact position of the image
    const imgRect = image.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    // Calculate the relative position - this is crucial for proper positioning
    const left = imgRect.left - containerRect.left;
    const top = imgRect.top - containerRect.top;

    console.log('Image position:', { left, top, width: imgRect.width, height: imgRect.height });

    // Set position and size to match the image exactly
    element.style.position = 'absolute';
    element.style.left = left + 'px';
    element.style.top = top + 'px';
    element.style.width = imgRect.width + 'px';
    element.style.height = imgRect.height + 'px';

    // Store the image dimensions in the container's dataset
    container.dataset.imgLeft = left;
    container.dataset.imgTop = top;
    container.dataset.imgWidth = imgRect.width;
    container.dataset.imgHeight = imgRect.height;

    return { left, top, width: imgRect.width, height: imgRect.height };
}

/**
 * Ensure image fits in viewport and crop box stays on image
 * Added enhanced timing to work properly with the first image
 */
function forceImageFit() {
    if (!window.ELEMENTS.currentImageEl || !window.ELEMENTS.editorContainerEl) return;

    console.log("Forcing image fit");

    // Prevent duplicate calls in quick succession
    if (window._forceImageFitInProgress) {
        console.log("Image fit already in progress, skipping duplicate call");
        return;
    }
    window._forceImageFitInProgress = true;

    // Get container dimensions
    const containerWidth = window.ELEMENTS.editorContainerEl.clientWidth;
    const containerHeight = window.ELEMENTS.editorContainerEl.clientHeight;

    console.log("Container dimensions:", containerWidth, containerHeight);

    // Reset image sizing to default natural size first
    window.ELEMENTS.currentImageEl.style.maxHeight = 'none';
    window.ELEMENTS.currentImageEl.style.maxWidth = 'none';
    window.ELEMENTS.currentImageEl.style.width = 'auto';
    window.ELEMENTS.currentImageEl.style.height = 'auto';

    // Ensure the image is loaded before continuing
    if (!window.ELEMENTS.currentImageEl.complete ||
        !window.ELEMENTS.currentImageEl.naturalWidth) {
        console.log("Image not fully loaded, waiting...");
        window.ELEMENTS.currentImageEl.onload = () => {
            // Retry after image loads
            setTimeout(forceImageFit, 10);
        };
        return;
    }

    // Get natural image dimensions
    const imgNaturalWidth = window.ELEMENTS.currentImageEl.naturalWidth;
    const imgNaturalHeight = window.ELEMENTS.currentImageEl.naturalHeight;

    console.log("Natural image dimensions:", imgNaturalWidth, imgNaturalHeight);

    // Calculate the scaling factor to fit the image within the container
    // with a small margin for aesthetics
    const margin = 40; // 20px on each side
    const scaleX = (containerWidth - margin) / imgNaturalWidth;
    const scaleY = (containerHeight - margin) / imgNaturalHeight;

    // Use the smaller scale to ensure image fits both dimensions
    const scale = Math.min(scaleX, scaleY);

    // Set explicit width and height (more reliable than max-width/max-height)
    const targetWidth = Math.floor(imgNaturalWidth * scale);
    const targetHeight = Math.floor(imgNaturalHeight * scale);

    console.log("Calculated dimensions:", targetWidth, targetHeight, "scale:", scale);

    // Apply calculated dimensions directly
    window.ELEMENTS.currentImageEl.style.width = targetWidth + 'px';
    window.ELEMENTS.currentImageEl.style.height = targetHeight + 'px';

    // Make sure container is set up correctly
    window.ELEMENTS.editorContainerEl.style.display = 'flex';
    window.ELEMENTS.editorContainerEl.style.justifyContent = 'center';
    window.ELEMENTS.editorContainerEl.style.alignItems = 'center';
    window.ELEMENTS.editorContainerEl.style.position = 'relative';

    // Force immediate application by triggering layout
    window.ELEMENTS.currentImageEl.offsetHeight; // Force reflow

    // Use requestAnimationFrame to ensure DOM updates are complete
    requestAnimationFrame(() => {
        // For the first image, wait a bit longer to ensure everything is loaded
        const delay = window.APP_STATE.firstImageLoad ? 200 : 100;
        window.APP_STATE.firstImageLoad = false;

        setTimeout(() => {
            // Position the overlay to exactly match the image
            if (window.ELEMENTS.cropOverlayEl) {
                // Get the exact position of the image
                const imgRect = window.ELEMENTS.currentImageEl.getBoundingClientRect();
                const containerRect = window.ELEMENTS.editorContainerEl.getBoundingClientRect();

                // Calculate the relative position
                const left = imgRect.left - containerRect.left;
                const top = imgRect.top - containerRect.top;

                console.log('Image position after fit:', { left, top, width: imgRect.width, height: imgRect.height });

                // Set overlay position and size to cover the entire editor container
                window.ELEMENTS.cropOverlayEl.style.position = 'absolute';
                window.ELEMENTS.cropOverlayEl.style.left = '0';
                window.ELEMENTS.cropOverlayEl.style.top = '0';
                window.ELEMENTS.cropOverlayEl.style.width = '100%';
                window.ELEMENTS.cropOverlayEl.style.height = '100%';
                window.ELEMENTS.cropOverlayEl.style.display = 'block';
                window.ELEMENTS.cropOverlayEl.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';

                // Store the image dimensions in the container's dataset
                window.ELEMENTS.editorContainerEl.dataset.imgLeft = left;
                window.ELEMENTS.editorContainerEl.dataset.imgTop = top;
                window.ELEMENTS.editorContainerEl.dataset.imgWidth = imgRect.width;
                window.ELEMENTS.editorContainerEl.dataset.imgHeight = imgRect.height;

                // Reinitialize the crop rectangle if needed, but only if we're not already inside
                // the initCropRectangle function (to prevent recursion and shrinkage)
                if (window.ELEMENTS.cropRectangleEl && !window._initializingCropRectangle) {
                    const { currentStage } = window.APP_STATE;
                    // Only initialize crop rectangle if we're in stage 1 or 2 (not in review stage)
                    if (currentStage === 1) {
                        // Make sure elements are visible in portrait stage
                        window.ELEMENTS.cropOverlayEl.style.display = 'block';
                        window.ELEMENTS.cropRectangleEl.style.display = 'block';
                        window.ELEMENTS.previewViewEl.style.display = 'none';
                        initCropRectangle(getAspectRatio('portrait')); // Portrait ratio
                    } else if (currentStage === 2) {
                        // Make sure elements are visible in landscape stage
                        window.ELEMENTS.cropOverlayEl.style.display = 'block';
                        window.ELEMENTS.cropRectangleEl.style.display = 'block';
                        window.ELEMENTS.previewViewEl.style.display = 'none';
                        initCropRectangle(getAspectRatio('landscape')); // Landscape ratio
                    } else if (currentStage === 3) {
                        // In review stage - hide crop elements and show preview
                        window.ELEMENTS.cropOverlayEl.style.display = 'none';
                        window.ELEMENTS.cropRectangleEl.style.display = 'none';
                        window.ELEMENTS.previewViewEl.style.display = 'block';
                    }
                }
            }
            // Reset progress flag
            window._forceImageFitInProgress = false;
        }, delay);
    });
}

/**
 * Initialize crop rectangle for current image
 * @param {number} aspectRatio - Desired aspect ratio for crop
 */
function initCropRectangle(aspectRatio) {
    // Prevent recursive calls
    if (window._initializingCropRectangle) {
        console.log("Already initializing crop rectangle, skipping duplicate call");
        return;
    }

    // Set flag to prevent recursive calls
    window._initializingCropRectangle = true;

    // Ensure the image is fully loaded before getting measurements
    if (!window.ELEMENTS.currentImageEl.complete ||
        !window.ELEMENTS.currentImageEl.naturalWidth) {
        console.log("Image not fully loaded, delaying initialization");
        setTimeout(() => {
            window._initializingCropRectangle = false;
            initCropRectangle(aspectRatio);
        }, 100);
        return;
    }

    // Get direct measurements of the image
    const imgRect = window.ELEMENTS.currentImageEl.getBoundingClientRect();
    const containerRect = window.ELEMENTS.editorContainerEl.getBoundingClientRect();

    // Calculate exact position of image relative to container
    const imgLeft = imgRect.left - containerRect.left;
    const imgTop = imgRect.top - containerRect.top;
    const imgWidth = imgRect.width;
    const imgHeight = imgRect.height;

    console.log("Image position:", imgLeft, imgTop, imgWidth, imgHeight);

    // Calculate crop size based on aspect ratio
    let cropWidth, cropHeight, cropX, cropY;

    // Get current stage and check for saved crop data
    const { currentStage } = window.APP_STATE;
    const savedCrop = currentStage === 1
        ? window.APP_STATE.portraitCrop
        : window.APP_STATE.landscapeCrop;

    // Check if we have valid saved crop data
    if (savedCrop && savedCrop.width > 0 && savedCrop.height > 0) {
        // Get current image's natural dimensions vs display dimensions
        // Calculate scaling once based on natural image size vs display size
        // This ensures we're always working with the original coordinates and not re-scaling already scaled values
        const scaleX = imgWidth / window.ELEMENTS.currentImageEl.naturalWidth;
        const scaleY = imgHeight / window.ELEMENTS.currentImageEl.naturalHeight;

        // Calculate the absolute values based on the original saved crop (relative to original image)
        cropWidth = Math.round(savedCrop.width * scaleX);
        cropHeight = Math.round(savedCrop.height * scaleY);
        cropX = Math.round(imgLeft + (savedCrop.x * scaleX));
        cropY = Math.round(imgTop + (savedCrop.y * scaleY));

        // Ensure crop dimensions don't exceed current image bounds
        cropWidth = Math.min(cropWidth, imgWidth);
        cropHeight = Math.min(cropHeight, imgHeight);

        // Ensure crop doesn't extend beyond image edges
        if (cropX + cropWidth > imgLeft + imgWidth) {
            cropX = imgLeft + imgWidth - cropWidth;
        }
        if (cropY + cropHeight > imgTop + imgHeight) {
            cropY = imgTop + imgHeight - cropHeight;
        }

        console.log("Using scaled saved crop data:", {
            original: savedCrop,
            scaled: {x: cropX - imgLeft, y: cropY - imgTop, width: cropWidth, height: cropHeight},
            scaleFactors: {x: scaleX, y: scaleY}
        });
    } else {
        // Calculate default crop based on aspect ratio
        if (imgWidth / imgHeight > aspectRatio) {
            // Image is wider than crop ratio
            cropHeight = imgHeight; // Use full image height
            cropWidth = cropHeight * aspectRatio;
        } else {
            // Image is taller than crop ratio
            cropWidth = imgWidth; // Use full image width
            cropHeight = cropWidth / aspectRatio;
        }

        // Ensure crop isn't bigger than image
        cropWidth = Math.min(cropWidth, imgWidth);
        cropHeight = Math.min(cropHeight, imgHeight);

        // Center the crop rectangle on the image
        cropX = imgLeft + (imgWidth - cropWidth) / 2;
        cropY = imgTop + (imgHeight - cropHeight) / 2;
    }

    console.log("Crop rectangle:", cropX, cropY, cropWidth, cropHeight);

    // Position the crop rectangle
    window.ELEMENTS.cropRectangleEl.style.position = 'absolute';
    window.ELEMENTS.cropRectangleEl.style.left = cropX + 'px';
    window.ELEMENTS.cropRectangleEl.style.top = cropY + 'px';
    window.ELEMENTS.cropRectangleEl.style.width = cropWidth + 'px';
    window.ELEMENTS.cropRectangleEl.style.height = cropHeight + 'px';
    window.ELEMENTS.cropRectangleEl.style.display = 'block';

    // Store crop values relative to the image
    if (currentStage === 1) {
        window.APP_STATE.portraitCrop = {
            x: cropX - imgLeft,
            y: cropY - imgTop,
            width: cropWidth,
            height: cropHeight
        };
    } else if (currentStage === 2) {
        window.APP_STATE.landscapeCrop = {
            x: cropX - imgLeft,
            y: cropY - imgTop,
            width: cropWidth,
            height: cropHeight
        };
    }

    // Delay the update of overlay position to ensure elements are ready
    setTimeout(() => {
        updateOverlayPosition();
        // Setup crop handlers
        setupCropHandlers();

        // Reset initialization flag
        window._initializingCropRectangle = false;
    }, 50);
}

/**
 * Update overlay position to match crop rectangle
 */
function updateOverlayPosition() {
    if (!window.ELEMENTS.cropRectangleEl || !window.ELEMENTS.cropOverlayEl ||
        !window.ELEMENTS.editorContainerEl || !window.ELEMENTS.currentImageEl) {
        console.error("Missing elements for overlay positioning");
        return;
    }

    // Use getBoundingClientRect for precise measurements relative to viewport
    const containerRect = window.ELEMENTS.editorContainerEl.getBoundingClientRect();
    const cropRect = window.ELEMENTS.cropRectangleEl.getBoundingClientRect();
    const overlayRect = window.ELEMENTS.cropOverlayEl.getBoundingClientRect();
    const imageRect = window.ELEMENTS.currentImageEl.getBoundingClientRect();

    // Log detailed positions for debugging
    console.log("Overlay positioning measurements:", {
        container: {
            left: containerRect.left,
            top: containerRect.top,
            width: containerRect.width,
            height: containerRect.height
        },
        cropRect: {
            left: cropRect.left,
            top: cropRect.top,
            width: cropRect.width,
            height: cropRect.height
        },
        overlay: {
            left: overlayRect.left,
            top: overlayRect.top,
            width: overlayRect.width,
            height: overlayRect.height
        },
        image: {
            left: imageRect.left,
            top: imageRect.top,
            width: imageRect.width,
            height: imageRect.height
        }
    });

    // First ensure the overlay covers the entire container
    window.ELEMENTS.cropOverlayEl.style.position = 'absolute';
    window.ELEMENTS.cropOverlayEl.style.left = '0';
    window.ELEMENTS.cropOverlayEl.style.top = '0';
    window.ELEMENTS.cropOverlayEl.style.width = '100%';
    window.ELEMENTS.cropOverlayEl.style.height = '100%';
    window.ELEMENTS.cropOverlayEl.style.display = 'block';
    window.ELEMENTS.cropOverlayEl.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';

    // Calculate crop position relative to the container instead of the overlay
    // This is more reliable as the container position is stable
    const cropLeft = cropRect.left - containerRect.left;
    const cropTop = cropRect.top - containerRect.top;
    const cropRight = cropLeft + cropRect.width;
    const cropBottom = cropTop + cropRect.height;

    // Set variables for the clip path with pixel values
    window.ELEMENTS.cropOverlayEl.style.setProperty('--crop-left', `${cropLeft}px`);
    window.ELEMENTS.cropOverlayEl.style.setProperty('--crop-top', `${cropTop}px`);
    window.ELEMENTS.cropOverlayEl.style.setProperty('--crop-right', `${cropRight}px`);
    window.ELEMENTS.cropOverlayEl.style.setProperty('--crop-bottom', `${cropBottom}px`);

    // Force a repaint to ensure the overlay is updated
    window.ELEMENTS.cropOverlayEl.style.display = 'none';
    window.ELEMENTS.cropOverlayEl.offsetHeight; // Force reflow
    window.ELEMENTS.cropOverlayEl.style.display = 'block';

    console.log('Overlay update:', {
        crop: { left: cropLeft, top: cropTop, right: cropRight, bottom: cropBottom }
    });
}

/**
 * Setup drag and resize handlers for crop rectangle
 */
function setupCropHandlers() {
    const handles = window.ELEMENTS.cropRectangleEl.querySelectorAll('.crop-handle');
    let isDragging = false;
    let isResizing = false;
    let currentHandle = null;
    let startX, startY;
    let startLeft, startTop, startWidth, startHeight;

    // Get image boundaries
    const getImageBounds = () => {
        return {
            left: parseFloat(window.ELEMENTS.editorContainerEl.dataset.imgLeft) || 0,
            top: parseFloat(window.ELEMENTS.editorContainerEl.dataset.imgTop) || 0,
            width: parseFloat(window.ELEMENTS.editorContainerEl.dataset.imgWidth) || window.ELEMENTS.currentImageEl.offsetWidth,
            height: parseFloat(window.ELEMENTS.editorContainerEl.dataset.imgHeight) || window.ELEMENTS.currentImageEl.offsetHeight
        };
    };

    // Move the crop rectangle
    window.ELEMENTS.cropRectangleEl.addEventListener('mousedown', function(e) {
        if (e.target === window.ELEMENTS.cropRectangleEl) {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            startLeft = parseInt(window.ELEMENTS.cropRectangleEl.style.left) || 0;
            startTop = parseInt(window.ELEMENTS.cropRectangleEl.style.top) || 0;
            e.preventDefault();
        }
    });

    // Handle touch events for mobile
    window.ELEMENTS.cropRectangleEl.addEventListener('touchstart', function(e) {
        if (e.target === window.ELEMENTS.cropRectangleEl) {
            isDragging = true;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            startLeft = parseInt(window.ELEMENTS.cropRectangleEl.style.left) || 0;
            startTop = parseInt(window.ELEMENTS.cropRectangleEl.style.top) || 0;
            e.preventDefault();
        }
    }, { passive: false });

    // Resize using handles
    handles.forEach(handle => {
        handle.addEventListener('mousedown', function(e) {
            isResizing = true;
            currentHandle = this;
            startX = e.clientX;
            startY = e.clientY;
            startLeft = parseInt(window.ELEMENTS.cropRectangleEl.style.left) || 0;
            startTop = parseInt(window.ELEMENTS.cropRectangleEl.style.top) || 0;
            startWidth = parseInt(window.ELEMENTS.cropRectangleEl.style.width) || 0;
            startHeight = parseInt(window.ELEMENTS.cropRectangleEl.style.height) || 0;
            e.preventDefault();
            e.stopPropagation();
        });

        // Handle touch events for mobile
        handle.addEventListener('touchstart', function(e) {
            isResizing = true;
            currentHandle = this;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            startLeft = parseInt(window.ELEMENTS.cropRectangleEl.style.left) || 0;
            startTop = parseInt(window.ELEMENTS.cropRectangleEl.style.top) || 0;
            startWidth = parseInt(window.ELEMENTS.cropRectangleEl.style.width) || 0;
            startHeight = parseInt(window.ELEMENTS.cropRectangleEl.style.height) || 0;
            e.preventDefault();
            e.stopPropagation();
        }, { passive: false });
    });

    // Handle mouse move
    document.addEventListener('mousemove', function(e) {
        handleMoveResize(e.clientX, e.clientY);
    });

    // Handle touch move
    document.addEventListener('touchmove', function(e) {
        if (isDragging || isResizing) {
            handleMoveResize(e.touches[0].clientX, e.touches[0].clientY);
            e.preventDefault();
        }
    }, { passive: false });

    // Combined handler for mouse and touch events
    function handleMoveResize(clientX, clientY) {
        // Force refresh image bounds each time to ensure accuracy
        const imgBounds = getImageBounds();
        const { currentStage } = window.APP_STATE;

        if (isDragging) {
            const dx = clientX - startX;
            const dy = clientY - startY;

            // Calculate new position
            let newLeft = startLeft + dx;
            let newTop = startTop + dy;

            // Strict enforcement of image bounds
            newLeft = Math.max(imgBounds.left, Math.min(newLeft, imgBounds.left + imgBounds.width - parseInt(window.ELEMENTS.cropRectangleEl.style.width)));
            newTop = Math.max(imgBounds.top, Math.min(newTop, imgBounds.top + imgBounds.height - parseInt(window.ELEMENTS.cropRectangleEl.style.height)));

            // Apply position
            window.ELEMENTS.cropRectangleEl.style.left = newLeft + 'px';
            window.ELEMENTS.cropRectangleEl.style.top = newTop + 'px';

            // Update overlay in real-time during dragging
            updateOverlayPosition();
        } else if (isResizing && currentHandle) {
            const dx = clientX - startX;
            const dy = clientY - startY;

            // Calculate aspect ratio using config
            const orientation = currentStage === 1 ? 'portrait' : 'landscape';
            const aspectRatio = getAspectRatio(orientation);

            // Get which handle is being used
            const isTopLeft = currentHandle.classList.contains('top-left');
            const isTopRight = currentHandle.classList.contains('top-right');
            const isBottomLeft = currentHandle.classList.contains('bottom-left');
            const isBottomRight = currentHandle.classList.contains('bottom-right');

            let newWidth, newHeight, newLeft, newTop;

            // Calculate new size and position based on handle
            if (isBottomRight) {
                newWidth = Math.max(50, startWidth + dx);
                newHeight = newWidth / aspectRatio;
                newLeft = startLeft;
                newTop = startTop;
            } else if (isTopRight) {
                newWidth = Math.max(50, startWidth + dx);
                newHeight = newWidth / aspectRatio;
                newLeft = startLeft;
                newTop = startTop + startHeight - newHeight;
            } else if (isBottomLeft) {
                newWidth = Math.max(50, startWidth - dx);
                newHeight = newWidth / aspectRatio;
                newLeft = startLeft + startWidth - newWidth;
                newTop = startTop;
            } else if (isTopLeft) {
                newWidth = Math.max(50, startWidth - dx);
                newHeight = newWidth / aspectRatio;
                newLeft = startLeft + startWidth - newWidth;
                newTop = startTop + startHeight - newHeight;
            }

            // Make sure new dimensions don't exceed image bounds
            if (newLeft < imgBounds.left) {
                const diff = imgBounds.left - newLeft;
                newLeft = imgBounds.left;
                newWidth -= diff;
                newHeight = newWidth / aspectRatio;
            }

            if (newTop < imgBounds.top) {
                const diff = imgBounds.top - newTop;
                newTop = imgBounds.top;
                newHeight -= diff;
                newWidth = newHeight * aspectRatio;
            }

            if (newLeft + newWidth > imgBounds.left + imgBounds.width) {
                newWidth = imgBounds.left + imgBounds.width - newLeft;
                newHeight = newWidth / aspectRatio;
            }

            if (newTop + newHeight > imgBounds.top + imgBounds.height) {
                newHeight = imgBounds.top + imgBounds.height - newTop;
                newWidth = newHeight * aspectRatio;
            }

            // Apply new size and position
            window.ELEMENTS.cropRectangleEl.style.width = newWidth + 'px';
            window.ELEMENTS.cropRectangleEl.style.height = newHeight + 'px';
            window.ELEMENTS.cropRectangleEl.style.left = newLeft + 'px';
            window.ELEMENTS.cropRectangleEl.style.top = newTop + 'px';

            // Update overlay in real-time during resizing
            updateOverlayPosition();
        }
    }

    // Handle mouse up
    document.addEventListener('mouseup', function() {
        if (isDragging || isResizing) {
            isDragging = false;
            isResizing = false;
            currentHandle = null;

            // Force a final position check to ensure crop rectangle stays on image
            const imgBounds = getImageBounds();
            const cropLeft = parseInt(window.ELEMENTS.cropRectangleEl.style.left) || 0;
            const cropTop = parseInt(window.ELEMENTS.cropRectangleEl.style.top) || 0;
            const cropWidth = parseInt(window.ELEMENTS.cropRectangleEl.style.width) || 0;
            const cropHeight = parseInt(window.ELEMENTS.cropRectangleEl.style.height) || 0;

            // Final boundary check
            let newLeft = Math.max(imgBounds.left, Math.min(cropLeft, imgBounds.left + imgBounds.width - cropWidth));
            let newTop = Math.max(imgBounds.top, Math.min(cropTop, imgBounds.top + imgBounds.height - cropHeight));

            if (newLeft !== cropLeft || newTop !== cropTop) {
                window.ELEMENTS.cropRectangleEl.style.left = newLeft + 'px';
                window.ELEMENTS.cropRectangleEl.style.top = newTop + 'px';
            }

            // Update overlay position and stored crop values
            updateOverlayPosition();
            updateCropValues();
        }
    });

    // Handle touch end
    document.addEventListener('touchend', function() {
        if (isDragging || isResizing) {
            isDragging = false;
            isResizing = false;
            currentHandle = null;

            // Update overlay position and stored crop values
            updateOverlayPosition();
            updateCropValues();
        }
    });
}

/**
 * Update crop values based on current position
 */
function updateCropValues() {
    // Get image position from dataset (stored by forceImageFit)
    const imgLeft = parseFloat(window.ELEMENTS.editorContainerEl.dataset.imgLeft) || 0;
    const imgTop = parseFloat(window.ELEMENTS.editorContainerEl.dataset.imgTop) || 0;

    // Get crop rectangle position and size directly from DOM
    // We use parseInt to ensure we're working with whole numbers
    const cropX = parseInt(window.ELEMENTS.cropRectangleEl.style.left) || 0;
    const cropY = parseInt(window.ELEMENTS.cropRectangleEl.style.top) || 0;
    const cropWidth = parseInt(window.ELEMENTS.cropRectangleEl.style.width) || 0;
    const cropHeight = parseInt(window.ELEMENTS.cropRectangleEl.style.height) || 0;

    console.log("Updating crop values:", {
        image: { left: imgLeft, top: imgTop },
        crop: { x: cropX, y: cropY, width: cropWidth, height: cropHeight },
        relativeCrop: { x: cropX - imgLeft, y: cropY - imgTop }
    });

    // Store values relative to the image
    const { currentStage } = window.APP_STATE;
    if (currentStage === 1) {
        window.APP_STATE.portraitCrop = {
            x: cropX - imgLeft,
            y: cropY - imgTop,
            width: cropWidth,
            height: cropHeight
        };
    } else if (currentStage === 2) {
        window.APP_STATE.landscapeCrop = {
            x: cropX - imgLeft,
            y: cropY - imgTop,
            width: cropWidth,
            height: cropHeight
        };
    }
}

/**
 * Perform crop operation on the server
 * @param {string} orientation - Either 'portrait' or 'landscape'
 */
function performCrop(orientation) {
    if (!window.APP_STATE.currentImage) return;

    const crop = orientation === 'portrait' ? window.APP_STATE.portraitCrop : window.APP_STATE.landscapeCrop;
    const currentImage = window.APP_STATE.currentImage;

    // Get the identifier - prefer asset_id if available
    const identifier = currentImage.asset_id || currentImage.filename;

    // Calculate true coordinates relative to original image
    const imgEl = window.ELEMENTS.currentImageEl;
    const naturalWidth = imgEl.naturalWidth;
    const naturalHeight = imgEl.naturalHeight;
    const displayWidth = parseFloat(window.ELEMENTS.editorContainerEl.dataset.imgWidth) || imgEl.offsetWidth;
    const displayHeight = parseFloat(window.ELEMENTS.editorContainerEl.dataset.imgHeight) || imgEl.offsetHeight;

    // Scale factors
    const scaleX = naturalWidth / displayWidth;
    const scaleY = naturalHeight / displayHeight;

    // Calculate scaled crop coordinates directly without mirroring
    const scaledCrop = {
        x: Math.floor(crop.x * scaleX),
        y: Math.floor(crop.y * scaleY),
        width: Math.floor(crop.width * scaleX),
        height: Math.floor(crop.height * scaleY)
    };

    // Ensure crop dimensions don't exceed image dimensions
    scaledCrop.width = Math.min(scaledCrop.width, naturalWidth - scaledCrop.x);
    scaledCrop.height = Math.min(scaledCrop.height, naturalHeight - scaledCrop.y);

    // Log crop data for debugging
    console.log('Original crop:', crop);
    console.log('Natural dimensions:', naturalWidth, naturalHeight);
    console.log('Display dimensions:', displayWidth, displayHeight);
    console.log('Scale factors:', scaleX, scaleY);
    console.log('Scaled crop:', scaledCrop);

    // Show loading indicator in the appropriate frame
    const previewImg = orientation === 'portrait' ?
        window.ELEMENTS.portraitPreviewImgEl :
        window.ELEMENTS.landscapePreviewImgEl;

    if (previewImg) {
        // Create or update loading indicator
        let loadingIndicator = previewImg.parentElement.querySelector('.loading-indicator');
        if (!loadingIndicator) {
            loadingIndicator = document.createElement('div');
            loadingIndicator.className = 'loading-indicator';
            loadingIndicator.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            previewImg.parentElement.appendChild(loadingIndicator);
        }
        loadingIndicator.style.display = 'flex';
        previewImg.style.opacity = '0.5';
    }

    // Send crop request
    fetch('/crop', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            identifier: identifier,
            orientation: orientation,
            crop: scaledCrop
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            // Update preview - we need to fetch the output images directly
            const timestamp = new Date().getTime(); // Cache-busting

            if (orientation === 'portrait') {
                // Set a direct link to the output file using the identifier
                const portraitOutputPath = currentImage.asset_id ?
                    `/output/portrait/${encodeURIComponent(currentImage.asset_id)}_portrait.jpg?t=${timestamp}` :
                    `/output/portrait/${encodeURIComponent(currentImage.filename.replace('.', '_portrait.'))}?t=${timestamp}`;

                // Preload the image before showing it
                const tempImg = new Image();
                tempImg.onload = function() {
                    window.ELEMENTS.portraitPreviewImgEl.src = portraitOutputPath;
                    window.ELEMENTS.portraitPreviewImgEl.style.opacity = '1';
                    const loadingIndicator = window.ELEMENTS.portraitPreviewImgEl.parentElement.querySelector('.loading-indicator');
                    if (loadingIndicator) {
                        loadingIndicator.style.display = 'none';
                    }
                };
                tempImg.src = portraitOutputPath;
            } else {
                // Set a direct link to the output file using the identifier
                const landscapeOutputPath = currentImage.asset_id ?
                    `/output/landscape/${encodeURIComponent(currentImage.asset_id)}_landscape.jpg?t=${timestamp}` :
                    `/output/landscape/${encodeURIComponent(currentImage.filename.replace('.', '_landscape.'))}?t=${timestamp}`;

                // Preload the image before showing it
                const tempImg = new Image();
                tempImg.onload = function() {
                    window.ELEMENTS.landscapePreviewImgEl.src = landscapeOutputPath;
                    window.ELEMENTS.landscapePreviewImgEl.style.opacity = '1';
                    const loadingIndicator = window.ELEMENTS.landscapePreviewImgEl.parentElement.querySelector('.loading-indicator');
                    if (loadingIndicator) {
                        loadingIndicator.style.display = 'none';
                    }
                };
                tempImg.src = landscapeOutputPath;
            }

            // Update image status
            if (orientation === 'portrait') {
                if (window.APP_STATE.currentImage.status === 'landscape') {
                    window.APP_STATE.currentImage.status = 'both';
                } else {
                    window.APP_STATE.currentImage.status = 'portrait';
                }
            } else {
                if (window.APP_STATE.currentImage.status === 'portrait') {
                    window.APP_STATE.currentImage.status = 'both';
                } else {
                    window.APP_STATE.currentImage.status = 'landscape';
                }
            }
        } else {
            // Remove loading indicator on error
            const previewImg = orientation === 'portrait' ?
                window.ELEMENTS.portraitPreviewImgEl :
                window.ELEMENTS.landscapePreviewImgEl;

            if (previewImg) {
                previewImg.style.opacity = '1';
                const loadingIndicator = previewImg.parentElement.querySelector('.loading-indicator');
                if (loadingIndicator) {
                    loadingIndicator.style.display = 'none';
                }
            }

            alert('Error cropping image: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(error => {
        console.error('Error cropping image:', error);
        alert('Error cropping image: ' + error);

        // Remove loading indicator on error
        const previewImg = orientation === 'portrait' ?
            window.ELEMENTS.portraitPreviewImgEl :
            window.ELEMENTS.landscapePreviewImgEl;

        if (previewImg) {
            previewImg.style.opacity = '1';
            const loadingIndicator = previewImg.parentElement.querySelector('.loading-indicator');
            if (loadingIndicator) {
                loadingIndicator.style.display = 'none';
            }
        }
    });
}
