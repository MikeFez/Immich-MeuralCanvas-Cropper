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
        assert.ok(dialogs.some(message => message.includes('simulated sync failure')));
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
        assert.ok(dialogs.includes('simulated upload failure'));
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
        await page.locator(`tr[data-identifier="${asset}"] .reupload`).click();
        await page.waitForFunction(() => document.querySelector('.reupload')?.disabled === false);
        assert.equal(await page.locator('.reupload').innerText(), 'Re-upload');
        assert.match(await page.locator('#manage-notification').innerText(), /uploaded successfully/);
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
        await page.waitForFunction(() => document.querySelectorAll('#manage-table-body tr .delete').length === 0);
        const state = (await (await page.request.get(`${baseURL}/images`)).json()).find(image => image.asset_id === asset);
        assert.equal(state.status, 'unprocessed');
        assert.equal(state.crops.portrait, null);
        console.log('PASS: Manage deletion clears saved crop and status');
        assert.deepEqual(errors, []);
        console.log('PASS: no uncaught browser errors');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
