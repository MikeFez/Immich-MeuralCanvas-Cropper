/**
 * crop-engine.js - Core cropping functionality
 *
 * Implements image cropping, positioning, and manipulation
 *
 * IMPORTANT: Crop rectangle logic simplified to:
 * 1. Always maintain the exact aspect ratio of the target orientation (portrait/landscape)
 * 2. Automatically adjust when viewport changes size (responsive design)
 * 3. Allow user to modify scale and position while maintaining aspect ratio
 * 4. Preserve the selection when viewport size changes
 * 5. Preserve user modifications otherwise
 */

/** Fit the loaded image and restore the crop from original-image coordinates. */
function forceImageFit() {
    const { currentImageEl: image, editorContainerEl: container } = window.ELEMENTS;
    if (!image?.complete || !image.naturalWidth || !container || !window.APP_STATE.currentImage) return;
    const width = container.clientWidth - 40;
    const height = container.clientHeight - 40;
    if (width <= 0 || height <= 0) return;
    const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
    image.style.width = image.naturalWidth * scale + 'px';
    image.style.height = image.naturalHeight * scale + 'px';
    const bounds = image.getBoundingClientRect();
    const parent = container.getBoundingClientRect();
    Object.assign(container.dataset, {
        imgLeft: bounds.left - parent.left, imgTop: bounds.top - parent.top,
        imgWidth: bounds.width, imgHeight: bounds.height
    });
    const stage = window.APP_STATE.currentStage;
    if (stage === 1 || stage === 2) initCropRectangle(getAspectRatio(stage === 1 ? 'portrait' : 'landscape'));
}

/** Restore a saved/draft selection, or center the largest crop with the target ratio. */
function initCropRectangle(aspectRatio) {
    const { currentImageEl: image, editorContainerEl: container, cropRectangleEl: rectangle } = window.ELEMENTS;
    if (!image?.complete || !image.naturalWidth || !rectangle) return;
    const bounds = image.getBoundingClientRect();
    const parent = container.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const left = bounds.left - parent.left, top = bounds.top - parent.top;
    Object.assign(container.dataset, { imgLeft: left, imgTop: top, imgWidth: bounds.width, imgHeight: bounds.height });
    const stage = window.APP_STATE.currentStage;
    if (stage !== 1 && stage !== 2) return;
    const saved = window.APP_STATE[stage === 1 ? 'portraitCrop' : 'landscapeCrop'];
    let width = Math.min(bounds.width, bounds.height * aspectRatio);
    let height = width / aspectRatio;
    let x = (bounds.width - width) / 2, y = (bounds.height - height) / 2;
    if (saved?.width > 0 && saved?.height > 0) {
        const scaleX = bounds.width / image.naturalWidth, scaleY = bounds.height / image.naturalHeight;
        width = Math.min(bounds.width, saved.width * scaleX);
        height = Math.min(bounds.height, saved.height * scaleY);
        x = Math.max(0, Math.min(saved.x * scaleX, bounds.width - width));
        y = Math.max(0, Math.min(saved.y * scaleY, bounds.height - height));
    }
    Object.assign(rectangle.style, {
        position: 'absolute', left: left + x + 'px', top: top + y + 'px',
        width: width + 'px', height: height + 'px', display: 'block'
    });
    window.ELEMENTS.cropOverlayEl.style.display = 'block';
    updateCropValues();
    updateOverlayPosition();
    setupCropHandlers();
    window._cropRectangleInitialized = true;
}

/** Observe editor geometry once; coalesce layout work into one animation frame. */
function setupEditorResize() {
    const container = window.ELEMENTS.editorContainerEl;
    if (!container || container._resizeInstalled) return;
    container._resizeInstalled = true;
    let frame = null;
    const schedule = () => {
        if (frame !== null) return;
        frame = requestAnimationFrame(() => { frame = null; forceImageFit(); });
    };
    if (window.ResizeObserver) {
        container._resizeObserver = new ResizeObserver(schedule);
        container._resizeObserver.observe(container);
    } else {
        window.addEventListener('resize', schedule);
    }
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

    const containerRect = window.ELEMENTS.editorContainerEl.getBoundingClientRect();
    const cropRect = window.ELEMENTS.cropRectangleEl.getBoundingClientRect();

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
}

/**
 * Setup drag and resize handlers for crop rectangle
 */
function setupCropHandlers() {
    const rectangle = window.ELEMENTS.cropRectangleEl;
    if (rectangle._handlersAttached) return;
    rectangle._handlersAttached = true;
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
            startLeft = parseFloat(window.ELEMENTS.cropRectangleEl.style.left) || 0;
            startTop = parseFloat(window.ELEMENTS.cropRectangleEl.style.top) || 0;
            e.preventDefault();
        }
    });

    // Handle touch events for mobile
    window.ELEMENTS.cropRectangleEl.addEventListener('touchstart', function(e) {
        if (e.target === window.ELEMENTS.cropRectangleEl) {
            isDragging = true;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            startLeft = parseFloat(window.ELEMENTS.cropRectangleEl.style.left) || 0;
            startTop = parseFloat(window.ELEMENTS.cropRectangleEl.style.top) || 0;
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
            startLeft = parseFloat(window.ELEMENTS.cropRectangleEl.style.left) || 0;
            startTop = parseFloat(window.ELEMENTS.cropRectangleEl.style.top) || 0;
            startWidth = parseFloat(window.ELEMENTS.cropRectangleEl.style.width) || 0;
            startHeight = parseFloat(window.ELEMENTS.cropRectangleEl.style.height) || 0;
            e.preventDefault();
            e.stopPropagation();
        });

        // Handle touch events for mobile
        handle.addEventListener('touchstart', function(e) {
            isResizing = true;
            currentHandle = this;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            startLeft = parseFloat(window.ELEMENTS.cropRectangleEl.style.left) || 0;
            startTop = parseFloat(window.ELEMENTS.cropRectangleEl.style.top) || 0;
            startWidth = parseFloat(window.ELEMENTS.cropRectangleEl.style.width) || 0;
            startHeight = parseFloat(window.ELEMENTS.cropRectangleEl.style.height) || 0;
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
            newLeft = Math.max(imgBounds.left, Math.min(newLeft, imgBounds.left + imgBounds.width - parseFloat(window.ELEMENTS.cropRectangleEl.style.width)));
            newTop = Math.max(imgBounds.top, Math.min(newTop, imgBounds.top + imgBounds.height - parseFloat(window.ELEMENTS.cropRectangleEl.style.height)));

            // Apply position
            window.ELEMENTS.cropRectangleEl.style.left = newLeft + 'px';
            window.ELEMENTS.cropRectangleEl.style.top = newTop + 'px';

            // Update overlay in real-time during dragging
            updateOverlayPosition();
        } else if (isResizing && currentHandle) {
            const dx = clientX - startX;
            const aspectRatio = getAspectRatio(currentStage === 1 ? 'portrait' : 'landscape');
            const isLeft = currentHandle.classList.contains('top-left') || currentHandle.classList.contains('bottom-left');
            const isTop = currentHandle.classList.contains('top-left') || currentHandle.classList.contains('top-right');

            // The corner opposite the handle stays fixed while the dragged corner moves.
            const anchorX = isLeft ? startLeft + startWidth : startLeft;
            const anchorY = isTop ? startTop + startHeight : startTop;
            const roomX = isLeft ? anchorX - imgBounds.left : imgBounds.left + imgBounds.width - anchorX;
            const roomY = isTop ? anchorY - imgBounds.top : imgBounds.top + imgBounds.height - anchorY;
            const maxWidth = Math.min(roomX, roomY * aspectRatio);
            const desired = startWidth + (isLeft ? -dx : dx);
            const newWidth = Math.min(maxWidth, Math.max(50, desired));
            const newHeight = newWidth / aspectRatio;
            const newLeft = isLeft ? anchorX - newWidth : anchorX;
            const newTop = isTop ? anchorY - newHeight : anchorY;

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
            const cropLeft = parseFloat(window.ELEMENTS.cropRectangleEl.style.left) || 0;
            const cropTop = parseFloat(window.ELEMENTS.cropRectangleEl.style.top) || 0;
            const cropWidth = parseFloat(window.ELEMENTS.cropRectangleEl.style.width) || 0;
            const cropHeight = parseFloat(window.ELEMENTS.cropRectangleEl.style.height) || 0;

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
    const img = window.ELEMENTS.currentImageEl;
    const rectangle = window.ELEMENTS.cropRectangleEl;
    const container = window.ELEMENTS.editorContainerEl;
    if (!img?.naturalWidth || !rectangle || !container) return;
    const bounds = img.getBoundingClientRect();
    const parent = container.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const scaleX = img.naturalWidth / bounds.width;
    const scaleY = img.naturalHeight / bounds.height;
    const x = Math.max(0, Math.min(img.naturalWidth - 1,
        ((parseFloat(rectangle.style.left) || 0) - (bounds.left - parent.left)) * scaleX));
    const y = Math.max(0, Math.min(img.naturalHeight - 1,
        ((parseFloat(rectangle.style.top) || 0) - (bounds.top - parent.top)) * scaleY));
    const crop = {
        x, y,
        width: Math.min((parseFloat(rectangle.style.width) || 0) * scaleX, img.naturalWidth - x),
        height: Math.min((parseFloat(rectangle.style.height) || 0) * scaleY, img.naturalHeight - y)
    };
    const stage = window.APP_STATE.currentStage;
    if (stage === 1) window.APP_STATE.portraitCrop = crop;
    else if (stage === 2) window.APP_STATE.landscapeCrop = crop;
}

/**
 * Perform crop operation on the server
 * @param {string} orientation - Either 'portrait' or 'landscape'
 */
async function performCrop(orientation) {
    const currentImage = window.APP_STATE.currentImage;
    if (!currentImage) throw new Error('No image selected');
    updateCropValues();
    const crop = window.APP_STATE[orientation + 'Crop'];
    if (!crop || crop.width < 1 || crop.height < 1) throw new Error('Crop is not ready');
    const preview = orientation === 'portrait'
        ? window.ELEMENTS.portraitPreviewImgEl : window.ELEMENTS.landscapePreviewImgEl;
    if (preview) preview.style.opacity = '0.5';
    try {
        const data = await postJSON('/crop', { identifier: currentImage.asset_id, orientation, crop });
        if (preview && window.APP_STATE.currentImage?.asset_id === currentImage.asset_id) {
            preview.src = previewURL(currentImage.asset_id, orientation, crop);
        }
        return data;
    } finally {
        if (preview) preview.style.opacity = '1';
    }
}
