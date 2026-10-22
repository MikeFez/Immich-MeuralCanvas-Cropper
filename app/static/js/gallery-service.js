/**
 * gallery-service.js - Gallery: every saved crop of one orientation, framed like
 * the Canvas, with a large view to step through them and jump back to the editor.
 */

const GALLERY_KEY = 'galleryOrientation';
const gallery = {
    orientation: 'portrait',
    items: [],      // images with a saved crop in the current orientation
    index: -1,      // the one in the large view, or -1 for the grid
};
const galleryElement = id => document.getElementById(id);

try {
    const saved = localStorage.getItem(GALLERY_KEY);
    if (saved === 'portrait' || saved === 'landscape') gallery.orientation = saved;
} catch { /* storage unavailable: start with portrait */ }

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
    gallery.items = images.filter(image => image.crops?.[orientation]);

    const grid = galleryElement('gallery-grid');
    grid.className = `gallery-grid ${orientation}`;
    const empty = galleryElement('gallery-empty');
    empty.hidden = gallery.items.length > 0;
    empty.textContent = `No ${orientation} crops yet. Crop an image and it appears here.`;

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
    galleryElement('gallery-viewer-position').textContent = `${gallery.index + 1} of ${count}` +
        (image.needs_upload?.[orientation] ? ' · Not uploaded' : '');
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
