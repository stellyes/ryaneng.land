import { approximationDimensions } from './approximation.js';
import { CUSTOM_MIX, matchCustomMix, matchYarnLine, rankYarnLines } from './palette.js';

const $ = id => document.getElementById(id);

export function createImportPreview({ loadLines, yarnOption, renderYarnColors, confirm }) {
    let source = null, name = '', result = null, worker = null, timer = 0, generation = 0;
    let lines = null, ranking = [], custom = null, match = null, selectedLine = '', busy = false;
    const dialog = $('new-dialog'), area = $('import-preview'), status = $('import-status');
    const select = $('import-yarn'), confirmButton = $('import-confirm');

    function message(text) {
        dialog.querySelector('.dialog-message').textContent = text;
    }

    function updateDialogWidth() {
        dialog.classList.toggle('has-approximation', Boolean(source) && !$('image-panel').hidden);
    }

    function stopWorker() {
        clearTimeout(timer);
        worker?.terminate();
        worker = null;
    }

    function reset() {
        generation++;
        stopWorker();
        source = result = match = custom = null;
        ranking = [];
        selectedLine = '';
        area.hidden = true;
        confirmButton.disabled = true;
        select.replaceChildren(new Option('Estimated image colors', ''));
        for (const id of ['import-custom', 'import-ranking', 'import-mapping']) $(id).replaceChildren();
        for (const id of ['import-source', 'import-art']) { $(id).width = 0; $(id).height = 0; }
        updateDialogWidth();
    }

    function drawPreview() {
        if (!result) return;
        const canvas = $('import-art');
        canvas.width = result.cols;
        canvas.height = result.rows;
        const context = canvas.getContext('2d'), pixels = context.createImageData(result.cols, result.rows);
        result.cells.forEach((color, index) => {
            const value = color === null ? '#ffffff' : match?.mapping.get(color)?.yarn || color, at = index * 4;
            for (let c = 0; c < 3; c++) pixels.data[at + c] = parseInt(value.slice(1 + c * 2, 3 + c * 2), 16);
            pixels.data[at + 3] = 255;
        });
        context.putImageData(pixels, 0, 0);
    }

    function renderYarns() {
        if (!result) return;
        match = !selectedLine || !lines ? null : selectedLine === CUSTOM_MIX ? custom
            : matchYarnLine(result.usage, lines.find(line => line.name === selectedLine));
        const choose = value => {
            selectedLine = selectedLine === value ? '' : value;
            select.value = selectedLine;
            renderYarns();
        };
        $('import-custom').replaceChildren();
        $('import-ranking').replaceChildren();
        if (custom) {
            const heading = document.createElement('strong');
            heading.className = 'yarn-heading';
            heading.textContent = 'Custom mix';
            $('import-custom').append(heading, yarnOption(custom, 'Mix',
                `${custom.usable} of ${custom.total} colors usable \u00b7 ${custom.size} yarns from ${custom.lines} lines`, choose, selectedLine));
        }
        ranking.forEach((entry, index) => {
            const item = document.createElement('li');
            item.append(yarnOption(entry, index ? `#${index + 1}` : 'Best',
                `${entry.usable} of ${entry.total} colors usable \u00b7 ${entry.size} yarns in line`, choose, selectedLine));
            $('import-ranking').append(item);
        });
        renderYarnColors($('import-mapping'), result.usage, match, true);
        drawPreview();
        confirmButton.disabled = busy || Boolean(selectedLine && !match);
    }

    function scoreYarns() {
        if (!result) return;
        if (lines) {
            ranking = rankYarnLines(result.usage, lines, 5);
            custom = matchCustomMix(result.usage, lines);
            const recommended = document.createElement('optgroup');
            recommended.label = 'Recommended';
            recommended.append(new Option(`${CUSTOM_MIX} - ${Math.round(custom.score)}`, CUSTOM_MIX),
                ...ranking.map((entry, i) => new Option(`${i + 1}. ${entry.name} - ${Math.round(entry.score)}`, entry.name)));
            const all = document.createElement('optgroup');
            all.label = `All yarn lines (${lines.length})`;
            all.append(...lines.map(line => new Option(line.name, line.name)));
            select.replaceChildren(new Option('Estimated image colors', ''), recommended, all);
            select.value = selectedLine;
            $('import-yarn-status').textContent = `Same perceptual scoring as the editor: best of ${lines.length} lines for ${result.palette.length} color${result.palette.length === 1 ? '' : 's'}. Scores are out of 100.`;
        }
        renderYarns();
    }

    async function catalog() {
        const image = source;
        $('import-yarn-status').textContent = 'Loading the yarn catalog...';
        $('import-yarn-retry').hidden = true;
        try {
            const loaded = await loadLines();
            if (image !== source || !source) return;
            lines = loaded;
            scoreYarns();
        } catch (error) {
            if (image !== source || !source) return;
            $('import-yarn-status').textContent = `${error.message} You can still create a pattern using estimated image colors.`;
            $('import-yarn-retry').hidden = false;
        }
    }

    function dimensions(cols, rows) {
        for (const [axis, value] of [['cols', cols], ['rows', rows]]) {
            $(`import-${axis}`).value = $(`import-${axis}-range`).value = value;
        }
        $('import-stitches').textContent = `${(cols * rows).toLocaleString()} stitches (${cols} x ${rows})`;
    }

    function settings() {
        const value = id => {
            const input = $(`import-${id}`), number = Number(input.value);
            if (!input.value.trim() || !Number.isInteger(number) || number < Number(input.min) || number > Number(input.max)) {
                throw new Error(`${input.labels[0].textContent.trim()}: enter a whole number from ${input.min} to ${input.max}.`);
            }
            return number;
        };
        return {
            ...Object.fromEntries(['cols', 'rows', 'colors', 'merge', 'minimum', 'blocks', 'brightness', 'contrast'].map(id => [id, value(id)])),
            simplify: $('import-simplify').checked,
        };
    }

    function generate() {
        if (!source) return;
        const token = generation;
        try {
            const options = settings(), sampled = document.createElement('canvas');
            sampled.width = options.cols;
            sampled.height = options.rows;
            const ctx = sampled.getContext('2d', { willReadFrequently: true });
            ctx.imageSmoothingEnabled = $('import-smoothing').checked;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(source, 0, 0, sampled.width, sampled.height);
            const rgba = ctx.getImageData(0, 0, sampled.width, sampled.height).data;
            // Learn colors from broad regions, independently of stitch resolution.
            // A finer grid should add shape detail, not yarns for chart lines and antialiasing.
            let analysisRgba = null;
            if (options.simplify) {
                const analysis = document.createElement('canvas');
                const scale = Math.min(1, 100 / Math.max(source.width, source.height));
                analysis.width = Math.max(1, Math.round(source.width * scale));
                analysis.height = Math.max(1, Math.round(source.height * scale));
                const analysisContext = analysis.getContext('2d', { willReadFrequently: true });
                analysisContext.imageSmoothingEnabled = $('import-smoothing').checked;
                analysisContext.imageSmoothingQuality = 'high';
                analysisContext.drawImage(source, 0, 0, analysis.width, analysis.height);
                analysisRgba = analysisContext.getImageData(0, 0, analysis.width, analysis.height).data;
            }
            worker = new Worker(new URL('./approximation-worker.js', import.meta.url), { type: 'module' });
            const fail = text => {
                if (token !== generation) return;
                stopWorker();
                status.textContent = 'Preview could not be generated. Adjust the settings or upload another image.';
                message(text);
            };
            worker.addEventListener('error', event => {
                event.preventDefault();
                fail(`Image approximation failed: ${event.message || 'the worker could not start.'}`);
            });
            worker.addEventListener('message', ({ data }) => {
                if (token !== generation) return;
                if (data.error) { fail(data.error); return; }
                stopWorker();
                result = data.result;
                status.textContent = `${result.cols} x ${result.rows} cells \u00b7 ${result.palette.length} colors (limit ${options.colors}). Preview only \u2014 confirm below to create the project.`;
                scoreYarns();
            });
            const transfer = [rgba.buffer];
            if (analysisRgba) transfer.push(analysisRgba.buffer);
            worker.postMessage({ ...options, rgba, analysisRgba }, transfer);
        } catch (error) {
            status.textContent = 'Check the approximation settings.';
            message(error.message);
        }
    }

    function schedule() {
        if (!source) return;
        generation++;
        stopWorker();
        result = match = null;
        confirmButton.disabled = true;
        status.textContent = 'Generating preview...';
        message('');
        timer = setTimeout(generate, 160);
    }

    function start(canvas, imageName) {
        reset();
        source = canvas;
        name = imageName;
        area.hidden = false;
        updateDialogWidth();
        const original = $('import-source');
        original.width = canvas.width;
        original.height = canvas.height;
        const originalContext = original.getContext('2d');
        originalContext.fillStyle = '#ffffff';
        originalContext.fillRect(0, 0, original.width, original.height);
        originalContext.drawImage(canvas, 0, 0);
        // Shorter-side controls cannot stretch the image or exceed 500 on the longest side.
        for (const [axis, size] of [['cols', canvas.width], ['rows', canvas.height]]) {
            const max = Math.max(1, Math.round(500 * size / Math.max(canvas.width, canvas.height)));
            $(`import-${axis}`).max = $(`import-${axis}-range`).max = max;
        }
        const initial = approximationDimensions(canvas.width, canvas.height, 100, canvas.width >= canvas.height ? 'cols' : 'rows');
        dimensions(initial.cols, initial.rows);
        schedule();
        catalog();
    }

    for (const axis of ['cols', 'rows']) {
        for (const suffix of ['', '-range']) {
            $(`import-${axis}${suffix}`).addEventListener('input', event => {
                try {
                    if (!source) return;
                    const value = Number(event.target.value);
                    if (!event.target.value || !event.target.checkValidity()) throw new Error('Enter a valid whole grid dimension.');
                    const size = approximationDimensions(source.width, source.height, value, axis);
                    dimensions(size.cols, size.rows);
                    schedule();
                } catch (error) {
                    generation++;
                    stopWorker();
                    result = null;
                    confirmButton.disabled = true;
                    message(error.message);
                }
            });
        }
    }
    for (const suffix of ['', '-range']) {
        $(`import-colors${suffix}`).addEventListener('input', event => {
            const other = $(`import-colors${suffix ? '' : '-range'}`);
            if (event.target.checkValidity()) other.value = event.target.value;
            schedule();
        });
    }
    for (const id of ['merge', 'minimum', 'blocks', 'brightness', 'contrast', 'smoothing', 'simplify']) {
        $(`import-${id}`).addEventListener('input', () => {
            const output = $(`import-${id}-value`);
            if (output) output.textContent = $(`import-${id}`).value;
            schedule();
        });
    }
    select.addEventListener('change', () => {
        selectedLine = select.value;
        renderYarns();
    });
    $('import-yarn-retry').addEventListener('click', catalog);
    $('estimate-image').addEventListener('change', () => { if (!$('estimate-image').checked) reset(); });
    dialog.addEventListener('close', reset);
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    confirmButton.addEventListener('click', async () => {
        if (!source || !result || busy || confirmButton.disabled) return;
        busy = true;
        confirmButton.disabled = true;
        $('import-controls').disabled = select.disabled = $('new-image').disabled = true;
        $('estimate-image').disabled = true;
        dialog.querySelectorAll('[role="tab"]').forEach(tab => { tab.disabled = true; });
        dialog.querySelector('[data-close]').disabled = true;
        const token = generation;
        try {
            if (await confirm({ source, name, result, yarn: selectedLine })) dialog.close();
        } catch (error) {
            if (token === generation) message(error.message);
        } finally {
            busy = false;
            $('import-controls').disabled = select.disabled = $('new-image').disabled = false;
            $('estimate-image').disabled = false;
            dialog.querySelectorAll('[role="tab"]').forEach(tab => { tab.disabled = false; });
            dialog.querySelector('[data-close]').disabled = false;
            confirmButton.disabled = !result;
        }
    });
    return { start, reset, updateDialogWidth };
}
