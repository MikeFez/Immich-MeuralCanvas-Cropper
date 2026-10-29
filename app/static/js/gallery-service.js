/**
 * gallery-service.js - Gallery: every saved crop of one orientation, framed like
 * the Canvas, with a large view to step through them and jump back to the editor.
 */

const GALLERY_KEY = 'galleryOrientation';
const GALLERY_LOWRES_KEY = 'galleryLowResOnly';
// A crop is "low-res" when it uses noticeably fewer original pixels than the
// crop size, so it is enlarged (or, in native mode, simply shown small) and
// looks soft on the Canvas. Matches the editor's threshold.
const LOWRES_SCALE = 1.05;
const gallery = {
    orientation: 'portrait',
    lowResOnly: false,
    items: [],      // images with a saved crop in the current orientation (after any filter)
    index: -1,      // the one in the large view, or -1 for the grid
};
const galleryElement = id => document.getElementById(id);

try {
    const saved = localStorage.getItem(GALLERY_KEY);
    if (saved === 'portrait' || saved === 'landscape') gallery.orientation = saved;
    gallery.lowResOnly = localStorage.getItem(GALLERY_LOWRES_KEY) === '1';
} catch { /* storage unavailable: start with portrait, all crops */ }

/** How much the crop's original pixels are stretched to fill the crop size (>1 = enlarged). */
function cropScale(image, orientation) {
    const crop = image.crops?.[orientation];
    if (!crop || !window.CONFIG.initialized) return 1;
    return getDimensions(orientation).width / crop.width;
}

function isLowRes(image, orientation) {
    return cropScale(image, orientation) > LOWRES_SCALE;
}

async function showGallery() {
    if (window.APP_STATE.cropBusy) return;
    window.ELEMENTS.galleryModalEl.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    closeGalleryViewer();
    renderGallery();  // the list already loaded, then the server's latest
    try {
        window.APP_STATE.imageList = await (await fetch('/images')).json();
        renderImageList();
        renderGallery();
    } catch (error) {
        showToast('Could not refresh the gallery: ' + error.message, 'error');
    }
}

function hideGallery() {
    window.ELEMENTS.galleryModalEl.style.display = 'none';
    document.body.style.overflow = 'auto';
}

const galleryOpen = () => window.ELEMENTS.galleryModalEl.style.display !== 'none';

function setGalleryOrientation(orientation) {
    gallery.orientation = orientation;
    try { localStorage.setItem(GALLERY_KEY, orientation); } catch { /* not remembered */ }
    galleryElement('gallery-grid').scrollTop = 0;
    renderGallery();
}

function renderGallery() {
    const images = window.APP_STATE.imageList || [];
    const counts = {};
    for (const orientation of ['portrait', 'landscape']) {
        counts[orientation] = images.filter(image => image.crops?.[orientation]).length;
    }
    for (const button of document.querySelectorAll('.gallery-toggle button')) {
        const orientation = button.dataset.orientation;
        button.setAttribute('aria-pressed', String(orientation === gallery.orientation));
        button.querySelector('.gallery-count').textContent = counts[orientation];
    }
    const orientation = gallery.orientation;
    const withCrop = images.filter(image => image.crops?.[orientation]);
    const lowResCount = withCrop.filter(image => isLowRes(image, orientation)).length;
    galleryElement('gallery-lowres-only').checked = gallery.lowResOnly;
    galleryElement('gallery-lowres-count').textContent = lowResCount;
    gallery.items = gallery.lowResOnly ? withCrop.filter(image => isLowRes(image, orientation)) : withCrop;

    const grid = galleryElement('gallery-grid');
    grid.className = `gallery-grid ${orientation}`;
    const empty = galleryElement('gallery-empty');
    empty.hidden = gallery.items.length > 0;
    empty.textContent = gallery.lowResOnly
        ? `No low-res ${orientation} crops — every one fills the crop size.`
        : `No ${orientation} crops yet. Crop an image and it appears here.`;

    // Reuse tiles by asset so re-rendering never reloads thumbnails.
    const existing = new Map(Array.from(grid.children).map(tile => [tile.dataset.identifier, tile]));
    grid.replaceChildren(...gallery.items.map((image, index) => {
        let tile = existing.get(image.asset_id);
        if (!tile) {
            tile = makeElement('button', 'gallery-item');
            tile.type = 'button';
            tile.dataset.identifier = image.asset_id;
            const frame = makeElement('span', 'gallery-frame');
            const mat = makeElement('span', 'gallery-mat');
            const thumbnail = makeElement('img');
            thumbnail.loading = 'lazy';
            mat.append(thumbnail);
            frame.append(mat);
            tile.append(frame, makeElement('span', 'gallery-caption'));
        }
        const name = image.original_filename || image.filename;
        const url = previewURL(image.asset_id, orientation, image.crops[orientation], true);
        const thumbnail = tile.querySelector('img');
        if (thumbnail.getAttribute('src') !== url) thumbnail.src = url;
        thumbnail.alt = name;
        const caption = tile.querySelector('.gallery-caption');
        caption.replaceChildren(makeElement('span', 'gallery-name', name));
        if (isLowRes(image, orientation)) {
            caption.append(makeElement('span', 'gallery-badge low-res', `Low-res ${cropScale(image, orientation).toFixed(1)}×`));
        }
        if (image.needs_upload?.[orientation]) caption.append(makeElement('span', 'gallery-badge', 'Not uploaded'));
        tile.title = name;
        tile.dataset.index = index;
        return tile;
    }));
    if (gallery.index >= gallery.items.length) closeGalleryViewer();
}

/** Show one crop large; index wraps around at either end. */
function openGalleryViewer(index) {
    const count = gallery.items.length;
    if (!count) return;
    gallery.index = (index + count) % count;
    const image = gallery.items[gallery.index];
    const orientation = gallery.orientation;
    const name = image.original_filename || image.filename;
    const viewer = galleryElement('gallery-viewer');
    viewer.hidden = false;
    viewer.className = `gallery-viewer ${orientation}`;
    const large = galleryElement('gallery-viewer-img');
    large.src = previewURL(image.asset_id, orientation, image.crops[orientation]);
    large.alt = `${name}, ${orientation} crop`;
    galleryElement('gallery-viewer-name').textContent = name;
    const crop = image.crops[orientation];
    const lowRes = isLowRes(image, orientation)
        ? ` · Low-res: uses ${Math.round(crop.width)}×${Math.round(crop.height)}px of the original` : '';
    galleryElement('gallery-viewer-position').textContent = `${gallery.index + 1} of ${count}` +
        (image.needs_upload?.[orientation] ? ' · Not uploaded' : '') + lowRes;
    for (const button of viewer.querySelectorAll('.gallery-nav')) button.disabled = count < 2;
    // Load the neighbours ahead of time so stepping through feels instant.
    for (const step of [-1, 1]) {
        const next = gallery.items[(gallery.index + step + count) % count];
        new Image().src = previewURL(next.asset_id, orientation, next.crops[orientation]);
    }
}

function closeGalleryViewer() {
    const viewer = galleryElement('gallery-viewer');
    if (viewer.hidden) return;
    viewer.hidden = true;
    const tile = galleryElement('gallery-grid').children[gallery.index];
    gallery.index = -1;
    tile?.focus({ preventScroll: true });
    tile?.scrollIntoView({ block: 'nearest' });
}

function adjustGalleryCrop() {
    const image = gallery.items[gallery.index];
    if (!image || window.APP_STATE.cropBusy || window.APP_STATE.syncing) return;
    hideGallery();
    selectImage(image.asset_id, gallery.orientation === 'portrait' ? 1 : 2);
}

function setupGallery() {
    window.ELEMENTS.btnGalleryEl.addEventListener('click', showGallery);
    galleryElement('gallery-close').addEventListener('click', hideGallery);
    window.ELEMENTS.galleryModalEl.addEventListener('click', event => {
        if (event.target === window.ELEMENTS.galleryModalEl) hideGallery();
    });
    for (const button of document.querySelectorAll('.gallery-toggle button')) {
        button.addEventListener('click', () => setGalleryOrientation(button.dataset.orientation));
    }
    galleryElement('gallery-lowres-only').addEventListener('change', event => {
        gallery.lowResOnly = event.target.checked;
        try { localStorage.setItem(GALLERY_LOWRES_KEY, gallery.lowResOnly ? '1' : '0'); } catch { /* not remembered */ }
        galleryElement('gallery-grid').scrollTop = 0;
        closeGalleryViewer();
        renderGallery();
    });
    galleryElement('gallery-grid').addEventListener('click', event => {
        const tile = event.target.closest('.gallery-item');
        if (tile) openGalleryViewer(Number(tile.dataset.index));
    });
    const viewer = galleryElement('gallery-viewer');
    for (const button of viewer.querySelectorAll('.gallery-nav')) {
        button.addEventListener('click', () => openGalleryViewer(gallery.index + Number(button.dataset.step)));
    }
    galleryElement('gallery-viewer-back').addEventListener('click', closeGalleryViewer);
    galleryElement('gallery-viewer-adjust').addEventListener('click', adjustGalleryCrop);

    // Swipe left or right on touch screens.
    let start = null;
    viewer.addEventListener('pointerdown', event => { start = { x: event.clientX, y: event.clientY }; });
    viewer.addEventListener('pointerup', event => {
        if (!start) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        start = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) openGalleryViewer(gallery.index + (dx < 0 ? 1 : -1));
    });

    document.addEventListener('keydown', event => {
        if (!galleryOpen() || document.querySelector('.confirm-dialog')) return;
        const viewing = !viewer.hidden;
        if (event.key === 'Escape') {
            viewing ? closeGalleryViewer() : hideGallery();
        } else if (viewing && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            openGalleryViewer(gallery.index + (event.key === 'ArrowRight' ? 1 : -1));
        } else {
            return;
        }
        event.preventDefault();
    });
}

setupGallery();
