import { assetCatalog, assetList, loadAsset, assetThumbnail, createAsset, rasterAsset } from './assets.js';

const $ = id => document.getElementById(id);

export function createAssetLibrary({ add, getColor, canAdd, report }) {
    let entries = [], type = 'ornament', collection = null, current = null, source = null, generation = 0;
    const dialog = $('asset-library-dialog'), info = $('asset-info-dialog'), list = $('asset-list');
    function button(label, action) {
        const node = document.createElement('button');
        node.type = 'button'; node.textContent = label; node.addEventListener('click', action);
        return node;
    }
    function renderList() {
        generation++;
        const revision = generation;
        list.replaceChildren();
        const query = $('asset-search').value;
        if (collection !== null && !query.trim()) {
            const row = document.createElement('li');
            const back = button('Back to all assets', () => { collection = null; renderList(); });
            back.className = 'asset-back'; row.append(back); list.append(row);
        }
        for (const item of assetList(entries, type, query, collection)) {
            const row = document.createElement('li');
            row.className = 'asset-row';
            if (item.collection !== undefined) {
                const folder = button(item.collection, () => { collection = item.collection; renderList(); });
                folder.className = 'asset-collection';
                const icon = document.createElement('span'); icon.textContent = '\u25b8'; icon.setAttribute('aria-hidden', 'true');
                folder.prepend(icon); row.append(folder);
            } else {
                const entry = item.asset;
                const name = document.createElement('span'); name.className = 'asset-name'; name.textContent = entry.name;
                const details = button('Info', () => openInfo(entry));
                details.setAttribute('aria-label', `Info about ${entry.name}`);
                const preview = document.createElement('span'); preview.className = 'asset-thumbnail';
                preview.style.width = `${entry.preview_width}px`; preview.style.height = `${entry.preview_height}px`;
                row.append(name, details, preview);
                loadAsset(entry.file).then(data => {
                    if (generation === revision) preview.replaceChildren(assetThumbnail(data));
                }).catch(error => {
                    if (generation !== revision) return;
                    preview.textContent = '!';
                    preview.title = error.message;
                    report(error);
                });
            }
            list.append(row);
        }
        $('asset-list-status').textContent = list.children.length ? '' : 'No matching assets.';
        $('asset-collection-name').textContent = !query.trim() && collection !== null ? collection : '';
    }
    async function refreshCatalog() {
        $('asset-list-status').textContent = 'Loading assets...';
        $('asset-library-retry').hidden = true;
        try { entries = await assetCatalog(); renderList(); }
        catch (error) { $('asset-library-retry').hidden = false; $('asset-list-status').textContent = error.message; report(error); }
    }
    async function openInfo(entry) {
        current = entry; source = null;
        $('asset-info-title').textContent = entry.name;
        $('asset-preview-color').value = getColor() || '#000000';
        $('asset-preview-background').value = '#ffffff';
        $('asset-preview-size').value = Math.min(250, Math.max(15, Math.max(entry.preview_width, entry.preview_height)));
        $('asset-info-status').textContent = 'Loading asset...';
        $('asset-info-retry').hidden = true;
        $('asset-add').disabled = true;
        $('asset-preview-canvas').width = $('asset-preview-canvas').height = 1;
        if (!info.open) info.showModal();
        try {
            const data = await loadAsset(entry.file);
            if (current !== entry || !info.open) return;
            source = data; drawPreview();
        } catch (error) {
            if (current !== entry || !info.open) return;
            $('asset-info-status').textContent = error.message; $('asset-info-retry').hidden = false; report(error);
        }
    }
    function candidate() {
        return createAsset(current, source, Number($('asset-preview-size').value), $('asset-preview-color').value);
    }
    function drawPreview() {
        if (!source || !current) return;
        try {
            const asset = candidate(), canvas = $('asset-preview-canvas');
            const scale = Math.min(600 / asset.width, 360 / asset.height, 10);
            canvas.width = Math.max(1, Math.round(asset.width * scale));
            canvas.height = Math.max(1, Math.round(asset.height * scale));
            const ctx = canvas.getContext('2d'), sx = canvas.width / asset.width, sy = canvas.height / asset.height;
            ctx.fillStyle = $('asset-preview-background').value; ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = asset.color;
            for (const [x, y] of rasterAsset(asset)) {
                ctx.fillRect(Math.round(x * sx), Math.round(y * sy), Math.round((x + 1) * sx) - Math.round(x * sx), Math.round((y + 1) * sy) - Math.round(y * sy));
            }
            ctx.strokeStyle = '#8888'; ctx.lineWidth = 1; ctx.beginPath();
            for (let x = 0; x <= asset.width; x++) { const at = Math.min(canvas.width - 0.5, Math.floor(x * sx) + 0.5); ctx.moveTo(at, 0); ctx.lineTo(at, canvas.height); }
            for (let y = 0; y <= asset.height; y++) { const at = Math.min(canvas.height - 0.5, Math.floor(y * sy) + 0.5); ctx.moveTo(0, at); ctx.lineTo(canvas.width, at); }
            ctx.stroke();
            $('asset-preview-dimensions').textContent = `${asset.width} \u00d7 ${asset.height} cells`;
            $('asset-info-status').textContent = '';
            $('asset-add').disabled = !canAdd();
        } catch (error) { $('asset-add').disabled = true; $('asset-info-status').textContent = error.message; report(error); }
    }
    for (const tab of document.querySelectorAll('[data-asset-type]')) {
        tab.addEventListener('click', () => {
            type = tab.dataset.assetType; collection = null;
            $('asset-list-panel').setAttribute('aria-labelledby', tab.id);
            for (const other of document.querySelectorAll('[data-asset-type]')) {
                other.setAttribute('aria-selected', String(other === tab)); other.tabIndex = other === tab ? 0 : -1;
            }
            renderList();
        });
        tab.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const tabs = [...document.querySelectorAll('[data-asset-type]')];
            const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - tabs.indexOf(tab)];
            next.click(); next.focus();
        });
    }
    $('asset-search').addEventListener('input', renderList);
    $('asset-library-retry').addEventListener('click', refreshCatalog);
    $('asset-info-retry').addEventListener('click', () => openInfo(current));
    for (const id of ['asset-preview-color', 'asset-preview-background', 'asset-preview-size']) $(id).addEventListener('input', drawPreview);
    $('asset-add').addEventListener('click', () => {
        try {
            if (!source || !canAdd()) throw new Error('Open a project and finish cropping before adding an asset.');
            if (add(candidate()) === false) return;
            info.close(); dialog.close();
        } catch (error) { report(error); }
    });
    info.addEventListener('close', () => { current = null; source = null; });
    return {
        open() {
            collection = null; $('asset-search').value = '';
            dialog.showModal(); refreshCatalog();
        },
    };
}
