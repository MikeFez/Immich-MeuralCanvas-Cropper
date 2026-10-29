/* Run against tests/serve_fixture.py. Set PLAYWRIGHT_MODULE when using an existing installation. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.CROPPER_TEST_URL || 'http://127.0.0.1:5087';
const asset = '11111111-1111-4111-8111-111111111111';
const savedCrop = async (page, orientation) =>
    (await (await page.request.get(`${baseURL}/images`)).json()).find(image => image.asset_id === asset).crops[orientation];
const second = '22222222-2222-4222-8222-222222222222';

(async () => {
    const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        const dialogs = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
        const toasts = () => page.locator('.app-toast').allInnerTexts();
        const confirm = async () => { await page.locator('.confirm-dialog .confirm-ok').click(); };
        // Keep browser checks independent of external stylesheet availability.
        await page.route('https://**', route => route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
        const hostileName = `"'><img src=x onerror="window.filenameExecuted=true">.jpg`;
        await page.route('**/images', async route => {
            const response = await route.fetch();
            const images = await response.json();
            const first = images.find(image => image.asset_id === asset);
            if (first) first.original_filename = hostileName;
            await route.fulfill({ response, json: images });
        });
        await page.goto(baseURL);
        await page.waitForFunction(() => window.APP_STATE?.initialized);
        const thumbnail = page.locator(`[data-identifier="${asset}"] .thumbnail-image`);
        assert.equal(await thumbnail.getAttribute('alt'), hostileName);
        assert.ok((await thumbnail.getAttribute('src')).startsWith('/thumbnail/'));
        const stableURL = await thumbnail.getAttribute('src');
        await page.evaluate(() => {
            window.originalThumbnail = document.querySelector('.thumbnail-image');
            renderImageList();
            renderImageList();
        });
        assert.equal(await thumbnail.getAttribute('src'), stableURL);
        assert.equal(await page.evaluate(() => window.originalThumbnail === document.querySelector('.thumbnail-image')), true);
        assert.equal(await page.locator('img[src="x"]').count(), 0);
        assert.equal(await page.evaluate(() => !!window.filenameExecuted), false);
        console.log('PASS: filenames render as text and thumbnail URLs/nodes stay stable');
        // The library is a grid: at this width the two images sit side by side.
        const [firstCard, secondCard] = await page.locator('.image-grid-item').evaluateAll(items =>
            items.map(item => item.getBoundingClientRect().toJSON()));
        assert.equal(firstCard.y, secondCard.y);
        assert.ok(secondCard.x > firstCard.x + firstCard.width);
        console.log('PASS: the image library is laid out as a grid');
        await page.route('**/sync', route => route.fulfill({ status: 500, contentType: 'application/json',
            body: JSON.stringify({ success: false, error: 'simulated sync failure' }) }));
        // The library panel holds only the filter, the count and the images; Sync lives in Manage.
        assert.equal(await page.locator('.sidebar button').count(), 0);
        // Only unprocessed images are listed by default; the count shows listed/total.
        assert.equal(await page.locator('#show-unprocessed-only').isChecked(), true);
        assert.equal(await page.locator('.filter-container #image-count').innerText(), '2/2');
        await page.locator('#btn-manage').click();
        await page.locator('#btn-immich-sync').click();
        await page.waitForFunction(() => !window.APP_STATE.syncing);
        assert.ok((await toasts()).some(message => message.includes('simulated sync failure')));
        await page.unroute('**/sync');
        await page.locator('#btn-immich-sync').click();
        await page.waitForFunction(() => !window.APP_STATE.syncing);
        assert.equal(await page.locator('.image-grid-item').count(), 2);
        assert.equal(await page.locator('#btn-manage i').getAttribute('class'), 'fas fa-list');
        await page.keyboard.press('Escape');
        console.log('PASS: Sync (in Manage) reports failures and a retry refreshes the image list');
        // A sync the page didn't start (scheduled or at startup) refreshes the list once it finishes.
        await page.request.post(`${baseURL}/sync`);
        await page.waitForFunction(async () => !(await (await fetch('/jobs')).json()).running);
        const refreshed = page.waitForRequest(request => new URL(request.url()).pathname === '/images');
        await page.evaluate(() => watchBackgroundJobs());
        await refreshed;
        console.log('PASS: a background sync refreshes the open page');
        await page.locator(`[data-identifier="${asset}"]`).click();
        await page.waitForFunction(() => window._cropRectangleInitialized);
        assert.equal(await page.evaluate(() => window.APP_STATE.currentStage), 1);
        // The 160x90 fixture can't fill a 90x160 portrait frame, so the crop is enlarged.
        assert.ok(await page.locator('#crop-resolution').isVisible());
        assert.match(await page.locator('#crop-resolution').innerText(), /^Low resolution: \d+×\d+ px of the original will be enlarged [\d.]+× to 90×160/);
        console.log('PASS: the crop step warns when the output enlarges the crop');

        let release;
        const gate = new Promise(resolve => { release = resolve; });
        let started;
        const pending = new Promise(resolve => { started = resolve; });
        await page.route('**/crop', async route => { started(); await gate; await route.continue(); });
        await page.locator('#btn-crop').click();
        await pending;
        assert.equal(await page.evaluate(() => window.APP_STATE.currentStage), 1);
        assert.equal(await page.locator('#btn-crop').isDisabled(), true);
        assert.equal(await page.locator('#btn-skip').isDisabled(), true);
        await page.evaluate(second => selectImage(second), second);
        assert.equal(await page.evaluate(() => window.APP_STATE.currentImage.asset_id), asset);
        release();
        await page.waitForFunction(() => window.APP_STATE.currentStage === 2 && !window.APP_STATE.cropBusy);
        await page.unroute('**/crop');
        console.log('PASS: crop navigation waits for save and blocks image switching');

        await page.locator('#btn-skip').click();
        await page.waitForFunction(() => window.APP_STATE.currentStage === 3 && !window.APP_STATE.cropBusy);
        assert.equal(await page.locator('#crop-resolution').isVisible(), false);
        await page.route('**/complete', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'simulated upload failure' }) }));
        await page.locator('#btn-save').click();
        await page.waitForFunction(() => !window.APP_STATE.cropBusy);
        assert.equal(await page.evaluate(() => window.APP_STATE.currentStage), 3);
        assert.ok((await toasts()).includes('simulated upload failure'));
        await page.unroute('**/complete');
        await page.locator('#btn-save').click();
        await page.waitForFunction(second => window.APP_STATE.currentImage?.asset_id === second, second);
        await page.waitForFunction(() => window._cropRectangleInitialized);
        console.log('PASS: upload failure stays on review; successful upload advances');

        await page.reload();
        await page.waitForFunction(() => window.APP_STATE?.initialized);
        const completed = page.locator(`[data-identifier="${asset}"]`);
        assert.equal(await completed.getAttribute('data-status'), 'completed');
        assert.equal(await completed.locator('.fa-mobile-alt').getAttribute('class'), 'fas fa-mobile-alt text-success');
        assert.equal(await completed.locator('.fa-desktop').getAttribute('class'), 'fas fa-desktop text-secondary');
        console.log('PASS: uploaded portrait-only image has correct icons after reload');

        // The filter hides it, says so when nothing is left, and remembers being turned off.
        assert.ok(await completed.evaluate(item => item.classList.contains('filtered')));
        assert.equal(await completed.isVisible(), false);
        assert.equal(await page.locator('#image-count').innerText(), '1/2');
        await page.evaluate(() => {
            document.querySelectorAll('.image-grid-item').forEach(item => { item.dataset.status = 'completed'; });
            applyUnprocessedFilter();
        });
        assert.ok(await page.locator('.filter-empty').isVisible());
        await page.evaluate(() => renderImageList());
        assert.equal(await page.locator('.filter-empty').count(), 0);
        await page.locator('#show-unprocessed-only').uncheck();
        await page.reload();
        await page.waitForFunction(() => window.APP_STATE?.initialized);
        assert.equal(await page.locator('#show-unprocessed-only').isChecked(), false);
        assert.equal(await page.locator('#image-count').innerText(), '2');
        console.log('PASS: the unprocessed filter is on by default and remembers being turned off');

        const original = await savedCrop(page, 'portrait');
        await page.locator('#btn-manage').click();
        assert.equal(await page.locator(`tr[data-identifier="${asset}"] img`).first().getAttribute('alt'), hostileName);
        assert.equal(await page.locator(`tr[data-identifier="${asset}"] [onclick]`).count(), 0);
        // Removing from the input album says plainly that nothing is deleted.
        await page.locator(`tr[data-identifier="${asset}"] .remove-from-album`).click();
        assert.match(await page.locator('.confirm-dialog').innerText(), /Nothing is deleted/);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#manage-modal .job-history').count(), 0);
        assert.equal(await page.evaluate(() => !!window.filenameExecuted), false);
        // Escape cancels a confirmation without closing the Manage modal behind it.
        await page.locator(`tr[data-identifier="${asset}"] .reupload`).click();
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.confirm-dialog').count(), 0);
        assert.ok(await page.locator('#manage-modal').isVisible());
        await page.locator(`tr[data-identifier="${asset}"] .reupload`).click();
        await confirm();
        await page.waitForFunction(() => document.querySelector('.reupload')?.disabled === false);
        assert.equal(await page.locator('.reupload').innerText(), 'Re-upload');
        assert.ok((await toasts()).some(message => /uploaded successfully/.test(message)));
        console.log('PASS: Manage re-upload restores its button without window.event');
        await page.locator(`tr[data-identifier="${asset}"] .recrop`).click();
        await page.waitForFunction(() => window._cropRectangleInitialized);
        const beforeResize = await page.evaluate(() => ({ ...window.APP_STATE.portraitCrop }));
        for (const size of [{ width: 1000, height: 750 }, { width: 1440, height: 1000 }]) {
            await page.setViewportSize(size);
            await page.waitForFunction(() => {
                const image = window.ELEMENTS.currentImageEl;
                const container = window.ELEMENTS.editorContainerEl;
                const scale = Math.min((container.clientWidth - 40) / image.naturalWidth,
                    (container.clientHeight - 40) / image.naturalHeight);
                return Math.abs(image.getBoundingClientRect().width - image.naturalWidth * scale) < 1;
            });
            const resized = await page.evaluate(() => window.APP_STATE.portraitCrop);
            for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(beforeResize[key] - resized[key]) < 1, `Resize changed ${key}`);
        }
        console.log('PASS: resizing the editor preserves original-image crop coordinates');
        await page.locator('#btn-crop').click();
        await page.waitForFunction(() => window.APP_STATE.currentStage === 2 && !window.APP_STATE.cropBusy);
        const roundtrip = await savedCrop(page, 'portrait');
        for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(original[key] - roundtrip[key]) < 2, `${key} changed: ${original[key]} -> ${roundtrip[key]}`);
        console.log('PASS: saved crop roundtrip preserves original-image coordinates');

        // Resizing into an image edge must keep the opposite corner fixed instead of sliding the box.
        const box = () => page.locator('#crop-rectangle').boundingBox();
        const imageBox = await page.locator('#current-image').boundingBox();
        for (const [corner, dx, dy] of [['top-left', -400, -400], ['bottom-right', 400, 400], ['top-left', 60, 60]]) {
            const before = await box();
            const handle = await page.locator(`.crop-handle.${corner}`).boundingBox();
            await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
            await page.mouse.down();
            await page.mouse.move(handle.x + handle.width / 2 + dx, handle.y + handle.height / 2 + dy, { steps: 8 });
            await page.mouse.up();
            const after = await box();
            const anchor = corner === 'top-left'
                ? [[before.x + before.width, after.x + after.width], [before.y + before.height, after.y + after.height]]
                : [[before.x, after.x], [before.y, after.y]];
            for (const [was, now] of anchor) assert.ok(Math.abs(was - now) < 0.5, `${corner} drag moved its anchor ${was} -> ${now}`);
            assert.ok(after.x >= imageBox.x - 0.5 && after.y >= imageBox.y - 0.5 &&
                after.x + after.width <= imageBox.x + imageBox.width + 0.5 &&
                after.y + after.height <= imageBox.y + imageBox.height + 0.5, `${corner} drag left the image`);
        }
        console.log('PASS: corner resizing keeps the opposite corner fixed and stays inside the image');

        await page.locator('#btn-manage').click();
        await page.locator(`tr[data-identifier="${asset}"] .delete`).click();
        await confirm();
        await page.waitForFunction(() => document.querySelectorAll('#manage-table-body tr .delete').length === 0);
        const state = (await (await page.request.get(`${baseURL}/images`)).json()).find(image => image.asset_id === asset);
        assert.equal(state.status, 'unprocessed');
        assert.equal(state.crops.portrait, null);
        console.log('PASS: Manage deletion clears saved crop and status');

        // Each stage shows only its own tools; review adapts to which orientations were skipped.
        await page.keyboard.press('Escape');
        await page.locator(`[data-identifier="${second}"]`).click();
        await page.waitForFunction(second => window.APP_STATE.currentImage?.asset_id === second && window._cropRectangleInitialized, second);
        const ids = ['btn-crop', 'btn-skip', 'btn-save', 'preview-view', 'crop-overlay', 'crop-rectangle',
            'portrait-preview', 'landscape-preview'];
        const view = () => page.evaluate(ids => ({
            stage: window.APP_STATE.currentStage,
            back: window.ELEMENTS.btnBackEl.disabled,
            save: window.ELEMENTS.btnSaveEl.innerText.trim(),
            meural: window.ELEMENTS.btnMeuralPreviewEl.disabled,
            dots: [1, 2, 3].map(n => document.getElementById(`stage-${n}`).className.replace('stage-dot', '').trim() || '-').join(' '),
            visible: ids.filter(id => document.getElementById(id).checkVisibility()).join(' ')
        }), ids);
        const step = async button => {
            await page.locator(button).click();
            await page.waitForFunction(() => !window.APP_STATE.cropBusy);
            await page.evaluate(() => new Promise(requestAnimationFrame));
            return view();
        };
        const editing = 'btn-crop btn-skip crop-overlay crop-rectangle';
        await page.evaluate(() => new Promise(requestAnimationFrame));
        assert.deepEqual(await view(), { stage: 1, back: true, save: 'Upload Crops', meural: false, dots: 'active - -', visible: editing });
        assert.equal((await page.locator('#btn-skip').innerText()).trim(), 'Skip Portrait');
        assert.equal((await step('#btn-skip')).dots, 'completed active -');
        assert.equal((await page.locator('#btn-skip').innerText()).trim(), 'Skip Landscape');
        assert.deepEqual(await step('#btn-skip'), { stage: 3, back: false, save: 'Skip Image', meural: true,
            dots: 'completed completed active', visible: 'btn-save preview-view' });
        assert.deepEqual((await step('#btn-back')).visible, editing);
        assert.deepEqual(await step('#btn-crop'), { stage: 3, back: false, save: 'Upload Crops', meural: false,
            dots: 'completed completed active', visible: 'btn-save preview-view landscape-preview' });
        const { width, height } = await page.evaluate(() => getDimensions('landscape'));
        assert.equal(await page.locator('#landscape-preview .frame-label').textContent(), `Landscape (${width}×${height})`);
        assert.equal((await step('#btn-back')).stage, 2);
        assert.deepEqual(await step('#btn-back'), { stage: 1, back: true, save: 'Upload Crops', meural: false,
            dots: 'active - -', visible: editing });
        console.log('PASS: stage controls match each stage, including review with both orientations skipped');

        // A new crop is centered on the faces Immich found, or on the photo without any.
        const placement = await page.evaluate(() => {
            const place = faces => {
                window.APP_STATE.portraitCrop = { x: 0, y: 0, width: 0, height: 0 };
                window.APP_STATE.currentImage.faces = faces;
                initCropRectangle(getAspectRatio('portrait'));
                return { ...window.APP_STATE.portraitCrop };
            };
            const right = place([[0.8, 0.2, 0.9, 0.4]]);
            const left = place([[0.05, 0.1, 0.1, 0.2], [0.2, 0.1, 0.3, 0.2]]);
            return { right, left, middle: place([]), width: sourceImageSize().width };
        });
        assert.ok(Math.abs(placement.right.x + placement.right.width - placement.width) < 3, 'faces at the right edge');
        assert.ok(Math.abs(placement.left.x) < 3, 'faces near the left edge');
        assert.ok(Math.abs(placement.middle.x - (placement.width - placement.middle.width) / 2) < 3, 'no faces: centered');
        console.log('PASS: new crops are placed on detected faces');

        // Skipping a crop that is already in Immich asks first, since its copy is trashed.
        await page.evaluate(() => { window.APP_STATE.currentImage.uploaded = { portrait: true, landscape: false }; });
        await page.locator('#btn-skip').click();
        assert.match(await page.locator('.confirm-dialog').innerText(), /moves that copy to the Immich trash/);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !window.APP_STATE.cropBusy);
        assert.equal(await page.evaluate(() => window.APP_STATE.currentStage), 1);
        await page.evaluate(() => { window.APP_STATE.currentImage.uploaded = { portrait: false, landscape: false }; });
        console.log('PASS: skipping an uploaded crop asks before trashing it');

        // On Review, clicking a framed crop goes back to that crop's step.
        await step('#btn-skip');
        assert.equal((await step('#btn-crop')).stage, 3);
        assert.equal(await page.locator('#landscape-preview .photo-frame').evaluate(frame =>
            getComputedStyle(frame).backgroundColor), 'rgb(176, 137, 104)');
        await page.locator('#landscape-preview .photo-frame').click();
        await page.waitForFunction(() => window.APP_STATE.currentStage === 2);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        assert.equal((await view()).visible, editing);
        assert.equal((await step('#btn-back')).stage, 1);
        console.log('PASS: clicking a framed crop on Review returns to adjust it, framed in light wood by default');

        // Leaving Review for a photo of another shape must size the crop box for the new photo.
        await step('#btn-crop');
        assert.equal((await step('#btn-crop')).stage, 3);
        await page.locator(`[data-identifier="${asset}"]`).click();
        await page.waitForFunction(asset => window.APP_STATE.currentImage?.asset_id === asset && window._cropRectangleInitialized, asset);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const switched = await page.evaluate(() => { updateCropValues(); return window.APP_STATE.portraitCrop; });
        assert.ok(Math.abs(switched.width / switched.height - 90 / 160) < 0.01, `portrait crop ratio ${switched.width / switched.height}`);
        console.log('PASS: a crop box opened from Review fits the new photo');
        await step('#btn-skip');
        assert.equal((await step('#btn-crop')).stage, 3);  // both images now have a landscape crop

        // Gallery: one orientation's crops in frames, a large view to step through, and back to the editor.
        await page.locator('#btn-gallery').click();
        await page.waitForFunction(() => document.querySelectorAll('#gallery-grid .gallery-item').length > 0);
        const counts = await page.locator('.gallery-toggle .gallery-count').allTextContents();
        const listed = await page.evaluate(() => ['portrait', 'landscape'].map(o =>
            String(window.APP_STATE.imageList.filter(image => image.crops[o]).length)));
        assert.deepEqual(counts, listed);
        await page.locator('.gallery-toggle [data-orientation="landscape"]').click();
        assert.equal(await page.locator('.gallery-toggle [data-orientation="landscape"]').getAttribute('aria-pressed'), 'true');
        const tiles = page.locator('#gallery-grid .gallery-item');
        assert.equal(listed[1], '2');
        assert.equal(await tiles.count(), 2);
        assert.match(await tiles.first().locator('img').getAttribute('src'), /^\/output\/landscape\/.+&size=thumb$/);
        await tiles.first().click();
        assert.ok(await page.locator('#gallery-viewer').isVisible());
        assert.match(await page.locator('#gallery-viewer-position').textContent(), /^1 of /);
        assert.doesNotMatch(await page.locator('#gallery-viewer-img').getAttribute('src'), /size=thumb/);
        await page.keyboard.press('ArrowRight');
        assert.match(await page.locator('#gallery-viewer-position').textContent(), /^2 of /);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#gallery-viewer').isVisible(), false);
        assert.ok(await page.locator('#gallery-modal').isVisible());
        await tiles.first().click();
        const target = await page.evaluate(() => gallery.items[gallery.index].asset_id);
        await page.locator('#gallery-viewer-adjust').click();
        await page.waitForFunction(target => window.APP_STATE.currentImage?.asset_id === target &&
            window.APP_STATE.currentStage === 2 && window._cropRectangleInitialized, target);
        assert.equal(await page.locator('#gallery-modal').isVisible(), false);
        await page.locator('#btn-gallery').click();
        assert.equal(await page.locator('.gallery-toggle [data-orientation="landscape"]').getAttribute('aria-pressed'), 'true');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#gallery-modal').isVisible(), false);
        await page.evaluate(() => setGalleryOrientation('portrait'));
        console.log('PASS: Gallery lists crops per orientation, steps through them and opens one in the editor');

        // Settings: albums come from Immich (faked here); the saved key is never sent to the browser.
        await page.route('**/settings/albums', route => route.fulfill({ json: { success: true, albums: [
            { id: 'source-album', name: 'Queue', assets: 2, shared: false },
            { id: 'output-album', name: 'Crops', assets: 0, shared: false },
            { id: 'new-output', name: 'Shared crops', assets: 1, shared: true }] } }));
        assert.ok(!JSON.stringify(await (await page.request.get(`${baseURL}/settings`)).json()).includes('test-only'));
        const field = name => page.locator(`#settings-form [name="${name}"]`).first();
        await page.locator('#btn-settings').click();
        await page.waitForFunction(() => /Connected: 3 albums/.test(document.getElementById('settings-album-status').textContent));
        assert.equal(await field('api_key').inputValue(), '');
        assert.match(await field('api_key').getAttribute('placeholder'), /leave blank to keep/);
        assert.equal(await field('input_album_id').inputValue(), 'source-album');
        assert.ok(await page.locator('#settings-welcome').isHidden());
        await field('url').fill('http://elsewhere:2283');
        assert.equal(await field('api_key').getAttribute('placeholder'), 'Required for a new URL');
        await page.unroute('**/settings/albums');
        await page.locator('[name="load_albums"]').click();
        await page.waitForFunction(() => /Re-enter the API key/.test(document.getElementById('settings-album-status').textContent));
        await field('url').fill('http://127.0.0.1:1');
        await field('portrait_width').fill('0');
        await page.locator('[name="save"]').click();
        // A size change warns first, since saved crops exist.
        assert.match(await page.locator('.confirm-dialog').innerText(), /padded with black bars/);
        await confirm();
        await page.waitForFunction(() => [...document.querySelectorAll('.app-toast.error')].some(t => /Portrait size/.test(t.textContent)));
        assert.ok(await page.locator('#settings-modal').isVisible());
        await field('portrait_width').fill('90');
        await field('output_album_id').selectOption('new-output');
        await page.locator('[name="add_device"]').click();
        await page.locator('.settings-device [name="name"]').last().fill('Hall');
        await page.locator('.settings-device [name="ip"]').last().fill('10.0.0.9');
        assert.equal(await field('frame').inputValue(), 'light-wood');
        await field('frame').selectOption('black');
        await page.locator('[name="save"]').click();
        await page.waitForFunction(() => document.getElementById('settings-modal').style.display === 'none');
        assert.ok((await toasts()).includes('Settings saved'));
        const saved = (await (await page.request.get(`${baseURL}/settings`)).json()).settings;
        assert.equal(saved.immich.output_album_id, 'new-output');
        assert.ok(saved.immich.has_api_key);
        assert.deepEqual(saved.meural.devices.map(device => device.name), ['Hall']);
        assert.equal(saved.display.frame, 'black');
        assert.equal(await page.evaluate(() => document.documentElement.dataset.frame), 'black');
        console.log('PASS: Settings loads albums, keeps the saved key, refuses it for a new URL and saves');

        // Reopening settings reloads albums from the (faked) server for the tests below.
        await page.route('**/settings/albums', route => route.fulfill({ json: { success: true, albums: [
            { id: 'source-album', name: 'Queue', assets: 2, shared: false },
            { id: 'output-album', name: 'Crops', assets: 0, shared: false },
            { id: 'new-output', name: 'Shared crops', assets: 1, shared: true }] } }));

        // Splitting output by orientation reveals two album selects and saves both.
        await page.locator('#btn-settings').click();
        await page.waitForFunction(() => /Connected: 3 albums/.test(document.getElementById('settings-album-status').textContent));
        assert.equal(await field('split_output_albums').isChecked(), false);
        assert.ok(await page.locator('[data-output-split]').first().isHidden());
        await field('split_output_albums').check();
        assert.ok(await page.locator('[data-output-shared]').first().isHidden());
        await field('output_album_portrait_id').selectOption('output-album');
        await field('output_album_landscape_id').selectOption('new-output');
        await page.locator('[name="save"]').click();
        await page.waitForFunction(() => document.getElementById('settings-modal').style.display === 'none');
        const split = (await (await page.request.get(`${baseURL}/settings`)).json()).settings.immich;
        assert.equal(split.output_album_portrait_id, 'output-album');
        assert.equal(split.output_album_landscape_id, 'new-output');
        assert.equal(split.output_album_id, '');
        // Reopening shows the toggle on, with the saved albums selected.
        await page.locator('#btn-settings').click();
        await page.waitForFunction(() => document.getElementById('settings-split-output').checked);
        assert.ok(await page.locator('[data-output-shared]').first().isHidden());
        assert.equal(await field('output_album_portrait_id').inputValue(), 'output-album');
        assert.equal(await field('output_album_landscape_id').inputValue(), 'new-output');
        await field('close').click();
        console.log('PASS: Settings can split output into per-orientation albums');

        // The native-resolution toggle persists, reports through /dimensions and reloads checked.
        await page.locator('#btn-settings').click();
        await page.waitForFunction(() => document.getElementById('settings-modal').style.display === 'flex');
        assert.equal(await field('native_resolution').isChecked(), false);
        await field('native_resolution').check();
        await page.locator('[name="save"]').click();
        // Saved crops exist, so toggling resolution asks to confirm the re-upload.
        assert.match(await page.locator('.confirm-dialog').innerText(), /uploading again at the new resolution/);
        await confirm();
        await page.waitForFunction(() => document.getElementById('settings-modal').style.display === 'none');
        assert.equal((await (await page.request.get(`${baseURL}/settings`)).json()).settings.dimensions.native_resolution, true);
        assert.equal((await (await page.request.get(`${baseURL}/dimensions`)).json()).native_resolution, true);
        await page.locator('#btn-settings').click();
        await page.waitForFunction(() => document.getElementById('settings-native-resolution').checked);
        await field('close').click();
        console.log('PASS: Settings toggles native-resolution uploads');

        // Phones show the library, then the editor in its place, with a Library button back.
        const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        const phone = await phoneContext.newPage();
        phone.on('pageerror', error => errors.push(error.message));
        await phone.route('https://**', route => route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
        await phone.goto(baseURL);
        await phone.waitForFunction(() => window.APP_STATE?.initialized);
        await phone.locator('#show-unprocessed-only').uncheck();
        assert.ok(await phone.locator('.sidebar').isVisible());
        assert.equal(await phone.locator('#editor-view').isVisible(), false);
        assert.equal(await phone.locator('#no-image-view').isVisible(), false);
        assert.equal(await phone.locator('#btn-library').isVisible(), false);
        await phone.locator(`[data-identifier="${second}"]`).tap();
        await phone.waitForFunction(() => window._cropRectangleInitialized);
        assert.equal(await phone.locator('.sidebar').isVisible(), false);
        assert.ok(await phone.locator('#btn-library').isVisible());
        // The crop box and the main button both fit on screen without scrolling.
        for (const selector of ['#crop-rectangle', '#btn-crop', '#btn-remove-from-album']) {
            const box = await phone.locator(selector).boundingBox();
            assert.ok(box.width > 0 && box.y >= 0 && box.y + box.height <= 844, selector);
        }
        assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 390);
        await phone.locator('#btn-remove-from-album').tap();
        assert.match(await phone.locator('.confirm-dialog').innerText(), /Nothing is deleted/);
        await phone.locator('.confirm-dialog').getByRole('button', { name: 'Cancel', exact: true }).tap();
        await phone.waitForFunction(() => !window.APP_STATE.cropBusy);
        assert.equal(await phone.evaluate(() => window.APP_STATE.currentImage.asset_id), second);
        await phone.locator('#btn-library').tap();
        assert.ok(await phone.locator('.sidebar').isVisible());
        assert.equal(await phone.locator('#editor-view').isVisible(), false);
        assert.equal(await phone.evaluate(() => window.APP_STATE.currentImage), null);
        // A library longer than the screen scrolls; its cards keep their size rather than squashing.
        const card = await phone.evaluate(() => {
            const grid = window.ELEMENTS.imageGridEl;
            const first = grid.querySelector('.image-grid-item');
            for (let i = 0; i < 150; i++) grid.append(first.cloneNode(true));
            const { width, height } = first.getBoundingClientRect();
            return { width, height, scrolls: grid.scrollHeight > grid.clientHeight };
        });
        assert.ok(card.scrolls && card.height > card.width, JSON.stringify(card));
        await phoneContext.close();
        console.log('PASS: phones switch between the library and a full-screen editor');

        // First run: without a configuration, Settings opens with the welcome text.
        const fresh = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        fresh.on('pageerror', error => errors.push(error.message));
        await fresh.route('https://**', route => route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
        await fresh.route('**/settings', async route => {
            if (route.request().method() !== 'GET') return route.continue();
            const response = await route.fetch();
            await route.fulfill({ response, json: { ...(await response.json()), configured: false } });
        });
        await fresh.goto(baseURL);
        await fresh.waitForFunction(() => document.getElementById('settings-modal').style.display === 'flex');
        assert.ok(await fresh.locator('#settings-welcome').isVisible());
        await fresh.close();
        console.log('PASS: first run opens Settings');

        const scaled = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        scaled.on('pageerror', error => errors.push(error.message));
        const originalRequests = [];
        scaled.on('request', request => {
            if (new URL(request.url()).pathname.startsWith('/image/')) originalRequests.push(request.url());
        });
        await scaled.route('https://**', route => route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
        await scaled.goto(baseURL);
        await scaled.waitForFunction(() => window.APP_STATE?.initialized);
        await scaled.locator('#show-unprocessed-only').uncheck();
        await scaled.locator(`[data-identifier="${second}"]`).click();
        await scaled.waitForFunction(() => window._cropRectangleInitialized);
        const mapping = await scaled.evaluate(() => ({
            natural: window.ELEMENTS.currentImageEl.naturalWidth,
            original: sourceImageSize(), crop: { ...window.APP_STATE.portraitCrop },
            url: window.ELEMENTS.currentImageEl.src
        }));
        assert.equal(mapping.natural, 2048);
        assert.deepEqual(mapping.original, { width: 4097, height: 3073 });
        assert.ok(mapping.url.includes('/editor-image/'));
        assert.ok(Math.abs(mapping.crop.height - 3073) < 1);
        await scaled.evaluate(() => performCrop('portrait'));
        const persisted = (await (await scaled.request.get(`${baseURL}/images`)).json())
            .find(image => image.asset_id === second).crops.portrait;
        for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(mapping.crop[key] - persisted[key]) < 1);
        await scaled.setViewportSize({ width: 900, height: 700 });
        await scaled.waitForFunction(() => {
            const bounds = window.ELEMENTS.currentImageEl.getBoundingClientRect();
            return bounds.width < 900 && bounds.height < 700;
        });
        const resized = await scaled.evaluate(() => ({ ...window.APP_STATE.portraitCrop }));
        for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(persisted[key] - resized[key]) < 1);
        await scaled.reload();
        await scaled.waitForFunction(() => window.APP_STATE?.initialized);
        await scaled.locator(`[data-identifier="${second}"]`).click();
        await scaled.waitForFunction(() => window._cropRectangleInitialized);
        const restored = await scaled.evaluate(() => window.APP_STATE.portraitCrop);
        for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(persisted[key] - restored[key]) < 1);
        assert.deepEqual(originalRequests, []);

        let removalRequests = 0;
        scaled.on('request', request => {
            if (new URL(request.url()).pathname === '/delete-original') removalRequests++;
        });
        const remove = scaled.locator('#btn-remove-from-album');
        await remove.click();
        assert.match(await scaled.locator('.confirm-dialog').innerText(), /Nothing is deleted.*Immich library/);
        await scaled.keyboard.press('Escape');
        await scaled.waitForFunction(() => !window.APP_STATE.cropBusy);
        assert.equal(removalRequests, 0);
        assert.equal(await scaled.evaluate(() => window.APP_STATE.currentImage.asset_id), second);
        await scaled.route('**/delete-original', route => route.fulfill({ status: 500,
            json: { success: false, error: 'simulated removal failure' } }));
        await remove.click();
        await scaled.locator('.confirm-ok').click();
        await scaled.waitForFunction(() => !window.APP_STATE.cropBusy);
        assert.equal(await scaled.evaluate(() => window.APP_STATE.currentImage.asset_id), second);
        assert.ok(await remove.isEnabled());
        assert.ok((await scaled.locator('.app-toast.error').allInnerTexts()).some(text => text.includes('simulated removal failure')));
        await scaled.unroute('**/delete-original');
        let releaseRemoval;
        const removalGate = new Promise(resolve => { releaseRemoval = resolve; });
        let removalStarted;
        const removing = new Promise(resolve => { removalStarted = resolve; });
        await scaled.route('**/delete-original', async route => {
            removalStarted(); await removalGate; await route.continue();
        });
        await remove.click();
        await scaled.locator('.confirm-ok').click();
        await removing;
        try {
            assert.ok(await remove.isDisabled());
            assert.ok(await scaled.locator('#btn-crop').isDisabled());
            await scaled.evaluate(id => selectImage(id), asset);
            assert.equal(await scaled.evaluate(() => window.APP_STATE.currentImage.asset_id), second);
        } finally { releaseRemoval(); }
        await scaled.waitForFunction(() => !window.APP_STATE.cropBusy && !window.APP_STATE.currentImage);
        assert.equal(removalRequests, 2);
        assert.equal(await scaled.locator(`[data-identifier="${second}"]`).count(), 0);
        assert.ok(await scaled.locator('#no-image-view').isVisible());
        assert.equal(await scaled.locator(`[data-identifier="${asset}"]`).count(), 1);
        const remaining = await (await scaled.request.get(`${baseURL}/images`)).json();
        assert.ok(!remaining.some(image => image.asset_id === second));
        console.log('PASS: editor album removal confirms, cancels, recovers from failure and clears the removed image');
        await scaled.close();
        console.log('PASS: smaller editor previews save, resize and restore crops in original pixels');


        assert.deepEqual(errors, []);
        assert.deepEqual(dialogs, [], 'native alert/confirm dialogs are not used');
        console.log('PASS: no uncaught browser errors or native dialogs');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
