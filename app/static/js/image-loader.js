/**
 * image-loader.js - Image loading and selection functionality
 */

/**
 * Render image list in grid view
 */
function makeElement(tag, className = '', text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function thumbnailURL(image) {
    return `/thumbnail/${encodeURIComponent(image.asset_id)}?v=${encodeURIComponent(image.source_version || '')}`;
}

function renderImageList() {
    if (window.APP_STATE.syncing) return;
    const grid = window.ELEMENTS.imageGridEl;
    const images = window.APP_STATE.imageList || [];
    if (!grid) return;
    if (!images.length) {
        grid.replaceChildren(makeElement('div', 'alert alert-info m-3', 'No images found'));
        if (window.ELEMENTS.imageCountEl) window.ELEMENTS.imageCountEl.textContent = '0';
        return;
    }
    const existing = new Map(Array.from(grid.querySelectorAll('.image-grid-item')).map(item => [item.dataset.identifier, item]));
    const cards = images.map(image => {
        const identifier = image.asset_id;
        const name = image.original_filename || image.filename;
        let card = existing.get(identifier);
        if (!card) {
            card = makeElement('div', 'image-grid-item');
            const container = makeElement('div', 'thumbnail-container');
            const thumbnail = makeElement('img', 'thumbnail-image');
            thumbnail.loading = 'lazy';
            container.append(thumbnail, makeElement('div', 'image-status'));
            card.append(container, makeElement('div', 'image-name'));
        }
        Object.assign(card.dataset, { identifier, status: image.status || 'unprocessed' });
        card.classList.toggle('completed', image.status === 'completed');
        card.classList.toggle('active', window.APP_STATE.currentImage?.asset_id === identifier);
        const thumbnail = card.querySelector('.thumbnail-image');
        const url = thumbnailURL(image);
        if (thumbnail.getAttribute('src') !== url) thumbnail.src = url;
        thumbnail.alt = name;
        card.querySelector('.image-name').textContent = truncateFilename(name, 20);
        const portrait = !!image.crops?.portrait;
        const landscape = !!image.crops?.landscape;
        const icons = portrait || landscape
            ? `<div class="status-icon-circle"><i class="fas fa-mobile-alt ${portrait ? 'text-success' : 'text-secondary'}" title="Portrait"></i></div>
            <div class="status-icon-circle"><i class="fas fa-desktop ${landscape ? 'text-success' : 'text-secondary'}" title="Landscape"></i></div>`
            : '<div class="status-icon-circle"><i class="fas fa-circle text-secondary"></i></div>';
        const status = card.querySelector('.image-status');
        if (status.innerHTML !== icons) status.innerHTML = icons; // Static markup; filenames never enter HTML.
        return card;
    });
    grid.replaceChildren(...cards);
    addImageClickHandlers();
    setupUnprocessedFilter();
}

/**
 * Apply unprocessed images filter
 */
function applyUnprocessedFilter() {
    const filterSwitch = window.ELEMENTS.unprocessedFilterEl;
    const showOnlyUnprocessed = filterSwitch && filterSwitch.checked;

    // Apply filter to all image grid items
    document.querySelectorAll('.image-grid-item').forEach(item => {
        const status = item.getAttribute('data-status');

        if (showOnlyUnprocessed) {
            // Only show unprocessed images
            if (status !== 'completed') {
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
    const filterSwitch = window.ELEMENTS.unprocessedFilterEl;
    if (!filterSwitch) return;

    if (!filterSwitch._filterHandler) {
        filterSwitch.addEventListener('change', applyUnprocessedFilter);
        filterSwitch._filterHandler = true;
    }

    // Initial filter application
    applyUnprocessedFilter();
}

/**
 * Select images on click with one delegated listener; selectImage owns the highlight.
 */
function addImageClickHandlers() {
    const grid = window.ELEMENTS.imageGridEl;
    if (!grid || grid._clickHandler) return;
    grid._clickHandler = event => {
        const item = event.target.closest('.image-grid-item');
        if (item) selectImage(item.dataset.identifier);
    };
    grid.addEventListener('click', grid._clickHandler);
}

/**
 * Select image for processing
 */
let isSelectingImage = false;

function selectImage(assetId, stage = 1) {
    if (window.APP_STATE.syncing || window.APP_STATE.cropBusy || isSelectingImage) {
        console.log("Skipping image selection - operation in progress");
        return;
    }
    const image = window.APP_STATE.imageList.find(img => img.asset_id === assetId);
    if (!image) {
        console.error('Image not found:', assetId);
        return;
    }
    isSelectingImage = true;
    window._cropRectangleInitialized = false;
    window.APP_STATE.currentImage = image;
    window.APP_STATE.currentStage = stage;

    // Explicitly reset the view when switching images
    for (const key of ['previewViewEl', 'cropOverlayEl', 'cropRectangleEl']) {
        if (window.ELEMENTS[key]) window.ELEMENTS[key].style.display = 'none';
    }
    document.querySelectorAll('.image-grid-item').forEach(item => {
        item.classList.toggle('active', item.dataset.identifier === assetId);
    });
    restoreSavedCrops(image);
    loadImageAndInitCrop(image);
}

/** Restore saved selections and previews from the image record. */
function restoreSavedCrops(image) {
    for (const orientation of ['portrait', 'landscape']) {
        const crop = image.crops?.[orientation];
        window.APP_STATE[orientation + 'Crop'] = crop ? { ...crop } : { x: 0, y: 0, width: 0, height: 0 };
        if (crop) {
            window.ELEMENTS[orientation + 'PreviewImgEl'].src = previewURL(image.asset_id, orientation, crop);
        } else {
            clearPreviewImage(orientation);
        }
    }
}

/** Rendered-crop URL; the crop in the query string changes it whenever the crop does. */
function previewURL(assetId, orientation, crop) {
    return `/output/${orientation}/${encodeURIComponent(assetId)}?v=${encodeURIComponent(JSON.stringify(crop))}`;
}

// Load the source image, then lay out the editor once it has dimensions
function loadImageAndInitCrop(selected) {
    const image = window.ELEMENTS.currentImageEl;
    image.onload = () => {
        image.style.display = 'block';
        showView('editor-view');
        forceImageFit();
        updateStage();
        isSelectingImage = false;
    };
    image.onerror = () => {
        window.APP_STATE.currentImage = null;
        showView('no-image-view');
        isSelectingImage = false;
    };
    image.style.display = 'none';
    image.src = `/image/${encodeURIComponent(selected.asset_id)}?v=${encodeURIComponent(selected.source_version || '')}`;
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