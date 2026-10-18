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
        await page.route('**/sync', route => route.fulfill({ status: 500, contentType: 'application/json',
            body: JSON.stringify({ success: false, error: 'simulated sync failure' }) }));
        await page.locator('#btn-immich-sync').click();
        await page.waitForFunction(() => !window.APP_STATE.syncing);
        assert.ok((await toasts()).some(message => message.includes('simulated sync failure')));
        await page.unroute('**/sync');
        await page.locator('#btn-immich-sync').click();
        await page.waitForFunction(() => !window.APP_STATE.syncing);
        assert.equal(await page.locator('.image-grid-item').count(), 2);
        console.log('PASS: Sync failures are visible and a retry refreshes the image list');
        await page.locator(`[data-identifier="${asset}"]`).click();
        await page.waitForFunction(() => window._cropRectangleInitialized);
        assert.equal(await page.evaluate(() => window.APP_STATE.currentStage), 1);

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

        const original = await savedCrop(page, 'portrait');
        await page.locator('#btn-manage').click();
        assert.equal(await page.locator(`tr[data-identifier="${asset}"] img`).first().getAttribute('alt'), hostileName);
        assert.equal(await page.locator(`tr[data-identifier="${asset}"] [onclick]`).count(), 0);
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
        assert.equal(await page.locator('#landscape-preview .frame-label').innerText(), `Landscape (${width}×${height})`);
        assert.equal((await step('#btn-back')).stage, 2);
        assert.deepEqual(await step('#btn-back'), { stage: 1, back: true, save: 'Upload Crops', meural: false,
            dots: 'active - -', visible: editing });
        console.log('PASS: stage controls match each stage, including review with both orientations skipped');

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
        await page.locator('[name="save"]').click();
        await page.waitForFunction(() => document.getElementById('settings-modal').style.display === 'none');
        assert.ok((await toasts()).includes('Settings saved'));
        const saved = (await (await page.request.get(`${baseURL}/settings`)).json()).settings;
        assert.equal(saved.immich.output_album_id, 'new-output');
        assert.ok(saved.immich.has_api_key);
        assert.deepEqual(saved.meural.devices.map(device => device.name), ['Hall']);
        console.log('PASS: Settings loads albums, keeps the saved key, refuses it for a new URL and saves');

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

        assert.deepEqual(errors, []);
        assert.deepEqual(dialogs, [], 'native alert/confirm dialogs are not used');
        console.log('PASS: no uncaught browser errors or native dialogs');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
