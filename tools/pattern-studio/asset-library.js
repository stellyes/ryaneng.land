import { assetCatalog, assetList, loadAsset, assetThumbnail, createAsset, rasterAsset, resizeBorder, borderThicknessLimit } from './assets.js';

const $ = id => document.getElementById(id);

export function createAssetLibrary({ add, getColor, canAdd, getProjectSize = () => null, report }) {
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
        $('asset-border-repeat').hidden = entry.type !== 'border';
        $('asset-border-repeat').textContent = `Repeating: ${entry.repeating === true ? 'Yes' : 'No'}`;
        $('asset-border-dimensions').hidden = true;
        $('asset-preview-color').value = getColor() || '#000000';
        $('asset-preview-background').value = '#ffffff';
        $('asset-preview-size').min = entry.repeat_layout ? 1 : 15;
        $('asset-preview-size').max = entry.repeat_layout ? 1000 : 250;
        $('asset-preview-size').title = '';
        $('asset-preview-size-label').textContent = entry.repeat_layout ? 'Border thickness' : 'Size';
        $('asset-preview-size').value = entry.repeat_layout ? entry.repeat_layout.thickness :
            Math.min(250, Math.max(15, Math.max(entry.preview_width, entry.preview_height)));
        $('asset-info-status').textContent = 'Loading asset...';
        $('asset-info-retry').hidden = true;
        $('asset-add').disabled = true;
        $('asset-preview-canvas').width = $('asset-preview-canvas').height = 1;
        if (!info.open) info.showModal();
        try {
            const data = await loadAsset(entry.file);
            if (current !== entry || !info.open) return;
            source = data; resetDimensions(); drawPreview();
        } catch (error) {
            if (current !== entry || !info.open) return;
            $('asset-info-status').textContent = error.message; $('asset-info-retry').hidden = false; report(error);
        }
    }
    function candidate() {
        const asset = createAsset(current, source, Number($('asset-preview-size').value), $('asset-preview-color').value);
        return asset.borderBase || asset.repeatLayout ?
            resizeBorder(asset, Number($('asset-border-width').value), Number($('asset-border-height').value)) : asset;
    }
    function resetDimensions() {
        if (!source || !current) return;
        const asset = createAsset(current, source, Number($('asset-preview-size').value), $('asset-preview-color').value);
        $('asset-border-dimensions').hidden = !asset.borderBase && !asset.repeatLayout;
        const projectSize = asset.repeatLayout ? getProjectSize() : null;
        $('asset-border-width').readOnly = Boolean(projectSize);
        $('asset-border-height').readOnly = Boolean(projectSize);
        $('asset-border-width').value = projectSize?.width ?? asset.width;
        $('asset-border-height').value = projectSize?.height ?? asset.height;
        $('asset-size-help').textContent = asset.repeatLayout
            ? `Border thickness scales corners, ornaments and edge strips together.${asset.repeatLayout.maxThickness ? ` Maximum ${asset.repeatLayout.maxThickness} cells; pixel artwork uses nearest-neighbor scaling.` : ''} Preview dimensions match the open project; the frame initially fits its edges. Extra length changes symmetric gaps and repeat counts, not ornament size. After adding, resize freely or Shift-drag to scale up to the thickness limit. Geometric strips repeat independently.`
            : asset.borderBase
            ? 'Size sets initial dimensions. Decoration always scales to fit the original SVG proportions; extra width or height extends at the breakpoints. Preview size does not limit later detail. Shift-drag a corner to keep proportions. Background is preview-only.'
            : `Size is cells on the longest side. Proportions stay locked. Background is preview-only.${current.type === 'border' ? ' Repeating tile layout is not available yet.' : ''}`;
    }
    function drawPreview() {
        if (!source || !current) return;
        try {
            if (current.repeat_layout) {
                const slider = $('asset-preview-size');
                const maximum = borderThicknessLimit({ repeatLayout: current.repeat_layout,
                    width: Number($('asset-border-width').value), height: Number($('asset-border-height').value),
                    matrix: [1, 0, 0, 1, 0, 0] });
                if (maximum < 1) throw new Error('Enlarge the frame to fit a one-cell border.');
                slider.max = maximum;
                slider.value = Math.min(Number(slider.value), maximum);
                slider.title = `Maximum thickness for this frame: ${maximum} cells`;
            }
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
            $('asset-preview-dimensions').textContent = `${asset.width} \u00d7 ${asset.height} cells${asset.repeatLayout ? `; thickness ${asset.borderThickness} cells` : ''}`;
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
    for (const id of ['asset-preview-color', 'asset-preview-background', 'asset-border-width', 'asset-border-height']) $(id).addEventListener('input', drawPreview);
    $('asset-preview-size').addEventListener('input', () => {
        try {
            if (!current?.repeat_layout) resetDimensions();
            drawPreview();
        }
        catch (error) { $('asset-add').disabled = true; $('asset-info-status').textContent = error.message; report(error); }
    });
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
