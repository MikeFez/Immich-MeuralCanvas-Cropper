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

const FILTER_KEY = 'showUnprocessedOnly';

/**
 * Apply unprocessed images filter
 */
function applyUnprocessedFilter() {
    const showOnlyUnprocessed = window.ELEMENTS.unprocessedFilterEl.checked;
    const items = document.querySelectorAll('.image-grid-item');
    items.forEach(item => item.classList.toggle('filtered',
        showOnlyUnprocessed && item.dataset.status === 'completed'));

    const visibleCount = document.querySelectorAll('.image-grid-item:not(.filtered)').length;
    window.ELEMENTS.imageCountEl.textContent = showOnlyUnprocessed ? `${visibleCount}/${items.length}` : items.length;

    // Say why the grid is empty instead of showing nothing.
    const grid = window.ELEMENTS.imageGridEl;
    grid.querySelector('.filter-empty')?.remove();
    if (items.length && !visibleCount) {
        grid.append(makeElement('div', 'filter-empty alert alert-success m-2',
            'Every image is processed. Turn off the filter to see them.'));
    }
}

/**
 * Set up unprocessed filter handling. It's on by default; the choice is remembered per browser.
 */
function setupUnprocessedFilter() {
    const filterSwitch = window.ELEMENTS.unprocessedFilterEl;
    if (!filterSwitch._filterHandler) {
        try {
            const saved = localStorage.getItem(FILTER_KEY);
            if (saved !== null) filterSwitch.checked = saved === 'true';
        } catch { /* storage unavailable: keep the default */ }
        filterSwitch.addEventListener('change', () => {
            try { localStorage.setItem(FILTER_KEY, filterSwitch.checked); } catch { /* not remembered */ }
            applyUnprocessedFilter();
        });
        filterSwitch._filterHandler = true;
    }

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

/** Leave the editor for the library (phones show one at a time), keeping the last image in view. */
function showLibrary() {
    if (window.APP_STATE.cropBusy || isSelectingImage) return;
    const active = window.ELEMENTS.imageGridEl.querySelector('.image-grid-item.active');
    window.APP_STATE.currentImage = null;
    showView('no-image-view');
    active?.classList.remove('active');
    active?.scrollIntoView({ block: 'nearest' });
}

window.ELEMENTS.btnLibraryEl.addEventListener('click', showLibrary);

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

/**
 * Rendered-crop URL at frame size, or at most 720 px for grids (thumb). The crop
 * in the query string changes the URL whenever the crop does.
 */
function previewURL(assetId, orientation, crop, thumb = false) {
    return `/output/${orientation}/${encodeURIComponent(assetId)}?v=${encodeURIComponent(JSON.stringify(crop))}` +
        (thumb ? '&size=thumb' : '');
}

// Load the source image, then lay out the editor once it has dimensions
function loadImageAndInitCrop(selected) {
    const image = window.ELEMENTS.currentImageEl;
    image.onload = () => {
        image.style.display = 'block';
        showView('editor-view');
        // Leave Review first: it hides the editor, and fitting a hidden editor
        // would keep the previous photo's size.
        updateStage();
        forceImageFit();
        isSelectingImage = false;
    };
    image.onerror = () => {
        window.APP_STATE.currentImage = null;
        showView('no-image-view');
        isSelectingImage = false;
    };
    image.style.display = 'none';
    image.src = `/editor-image/${encodeURIComponent(selected.asset_id)}?v=${encodeURIComponent(selected.source_version || '')}`;
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