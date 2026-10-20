/**
 * settings-service.js - Settings modal: Immich connection and albums, Meural devices and frame, crop sizes
 *
 * The server never sends the saved API key back. Leaving the key blank keeps it,
 * but only for the saved URL; a new URL needs the key entered again.
 */

let savedSettings = null;
let wasConfigured = false;

const settingsField = name => window.ELEMENTS.settingsFormEl.elements[name];

async function showSettingsModal() {
    if (window.APP_STATE.cropBusy || window.APP_STATE.syncing) return;
    const response = await fetch('/settings');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        showToast(data.error || 'Could not load settings', 'error');
        return;
    }
    savedSettings = data.settings;
    wasConfigured = data.configured;
    fillSettingsForm(data.settings, data.configured);
    window.ELEMENTS.settingsModalEl.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    if (data.configured) loadAlbums();
    else settingsField('url').focus();
}

function hideSettingsModal() {
    window.ELEMENTS.settingsModalEl.style.display = 'none';
    document.body.style.overflow = 'auto';
}

function fillSettingsForm(settings, configured) {
    const { immich, meural, dimensions, sync, display } = settings;
    window.ELEMENTS.settingsWelcomeEl.hidden = configured;
    settingsField('url').value = immich.url;
    settingsField('api_key').value = '';
    updateKeyPlaceholder();
    for (const name of ['input_album_id', 'output_album_id']) setAlbumOptions(settingsField(name), [], immich[name]);
    setAlbumStatus('');
    settingsField('sync_interval').value = sync.interval_minutes;
    settingsField('frame').value = display.frame;
    window.ELEMENTS.settingsDevicesEl.replaceChildren(...meural.devices.map(deviceRow));
    for (const orientation of ['portrait', 'landscape']) {
        const [width, height] = dimensions[`${orientation}_size`];
        settingsField(`${orientation}_width`).value = width;
        settingsField(`${orientation}_height`).value = height;
    }
}

/** The key may stay blank only while the URL is the saved one. */
function keyRequired() {
    return !savedSettings.immich.has_api_key ||
        settingsField('url').value.trim().replace(/\/+$/, '') !== savedSettings.immich.url.replace(/\/+$/, '');
}

function updateKeyPlaceholder() {
    settingsField('api_key').placeholder = !savedSettings.immich.has_api_key ? 'Paste your API key'
        : keyRequired() ? 'Required for a new URL' : 'Saved (leave blank to keep)';
}

function setAlbumStatus(message, type = '') {
    const status = window.ELEMENTS.settingsAlbumStatusEl;
    status.textContent = message;
    status.className = `form-text ${type === 'error' ? 'text-danger' : type === 'success' ? 'text-success' : ''}`;
}

function setAlbumOptions(select, albums, selected) {
    const options = [new Option(albums.length ? 'Choose an album…' : 'Load albums to choose', '')];
    for (const album of albums) {
        const label = `${album.name} (${album.assets} item${album.assets === 1 ? '' : 's'})${album.shared ? ' · shared' : ''}`;
        options.push(new Option(label, album.id));
    }
    // Keep a saved album selectable even before the list loads (or if it was deleted).
    if (selected && !albums.some(album => album.id === selected)) {
        options.push(new Option(albums.length ? `Missing album (${selected})` : `Saved album (${selected})`, selected));
    }
    select.replaceChildren(...options);
    select.value = selected || '';
}

async function loadAlbums() {
    const button = settingsField('load_albums');
    button.disabled = true;
    setAlbumStatus('Connecting…');
    try {
        const data = await postJSON('/settings/albums', {
            url: settingsField('url').value, api_key: settingsField('api_key').value
        });
        for (const name of ['input_album_id', 'output_album_id']) {
            const select = settingsField(name);
            setAlbumOptions(select, data.albums, select.value);
        }
        setAlbumStatus(`Connected: ${data.albums.length} album${data.albums.length === 1 ? '' : 's'}`, 'success');
    } catch (error) {
        setAlbumStatus(error.message, 'error');
    } finally {
        button.disabled = false;
    }
}

function deviceRow(device = { name: '', ip: '', preview_duration: 30 }) {
    const row = makeElement('div', 'settings-device row g-2 align-items-end');
    const column = (className, label, input) => {
        const cell = makeElement('div', className);
        const caption = makeElement('label', 'form-label small', label);
        caption.append(input);
        cell.append(caption);
        return cell;
    };
    const input = (name, type, value, placeholder) => {
        const element = makeElement('input', 'form-control form-control-sm');
        Object.assign(element, { name, type, value, placeholder });
        return element;
    };
    const remove = makeElement('button', 'btn btn-sm btn-outline-danger');
    remove.type = 'button';
    remove.title = 'Remove device';
    remove.setAttribute('aria-label', 'Remove device');
    remove.innerHTML = '<i class="fas fa-trash"></i>';
    remove.addEventListener('click', () => row.remove());
    const duration = input('preview_duration', 'number', device.preview_duration, '30');
    duration.min = 1;
    const actions = makeElement('div', 'col-1 text-end');
    actions.append(remove);
    row.append(
        column('col-5', 'Name', input('name', 'text', device.name, 'Living Room')),
        column('col-4', 'IP address', input('ip', 'text', device.ip, '192.168.1.50')),
        column('col-2', 'Preview (s)', duration),
        actions
    );
    return row;
}

function readSettingsForm() {
    const number = name => Number(settingsField(name).value);
    const devices = [...window.ELEMENTS.settingsDevicesEl.querySelectorAll('.settings-device')].map(row => ({
        name: row.querySelector('[name="name"]').value,
        ip: row.querySelector('[name="ip"]').value,
        preview_duration: Number(row.querySelector('[name="preview_duration"]').value)
    }));
    return {
        immich: {
            url: settingsField('url').value,
            api_key: settingsField('api_key').value,
            input_album_id: settingsField('input_album_id').value,
            output_album_id: settingsField('output_album_id').value
        },
        meural: { devices },
        sync: { interval_minutes: number('sync_interval') },
        display: { frame: settingsField('frame').value },
        dimensions: {
            portrait_size: [number('portrait_width'), number('portrait_height')],
            landscape_size: [number('landscape_width'), number('landscape_height')]
        }
    };
}

async function saveSettings(event) {
    event.preventDefault();
    const payload = readSettingsForm();
    const previous = savedSettings;
    const sizesChanged = ['portrait_size', 'landscape_size'].some(key =>
        payload.dimensions[key].join() !== previous.dimensions[key].join());
    if (sizesChanged && window.APP_STATE.imageList.some(image => image.crops.portrait || image.crops.landscape) &&
        !await confirmDialog('Saved crops keep their current proportions and will be padded with black bars ' +
            'until you re-crop them, and every crop will need uploading again. Change the crop sizes?', 'Change sizes')) {
        return;
    }
    const save = settingsField('save');
    save.disabled = true;
    let data;
    try {
        data = await postJSON('/settings', payload, 'PUT');
    } catch (error) {
        showToast(error.message, 'error');
        return;
    } finally {
        save.disabled = false;
    }
    savedSettings = data.settings;
    document.documentElement.dataset.frame = data.settings.display.frame;
    hideSettingsModal();
    showToast('Settings saved', 'success');

    if (sizesChanged) {
        await initializeConfig();
        if (window.APP_STATE.currentImage) updateStage();
        await refreshImages(); // Every crop now needs uploading at the new size.
    }
    // A different album or server means a different set of source images.
    const before = previous.immich, after = data.settings.immich;
    if (!wasConfigured || before.url !== after.url ||
        before.input_album_id !== after.input_album_id) {
        syncWithImmich().catch(() => {}); // syncWithImmich reports its own errors.
    }
}

function setupSettingsModal() {
    const form = window.ELEMENTS.settingsFormEl;
    const modal = window.ELEMENTS.settingsModalEl;
    window.ELEMENTS.btnSettingsEl.addEventListener('click', showSettingsModal);
    form.addEventListener('submit', saveSettings);
    settingsField('close').addEventListener('click', hideSettingsModal);
    settingsField('cancel').addEventListener('click', hideSettingsModal);
    settingsField('load_albums').addEventListener('click', loadAlbums);
    settingsField('add_device').addEventListener('click', () => {
        const row = deviceRow();
        window.ELEMENTS.settingsDevicesEl.append(row);
        row.querySelector('input').focus();
    });
    settingsField('url').addEventListener('input', () => {
        updateKeyPlaceholder();
        setAlbumStatus('');
    });
    modal.addEventListener('click', event => { if (event.target === modal) hideSettingsModal(); });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && modal.style.display !== 'none') hideSettingsModal();
    });
}

setupSettingsModal();
