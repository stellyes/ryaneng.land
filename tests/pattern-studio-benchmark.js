// Brush-stroke latency benchmark for Pattern Studio. Load the editor page, then inject this script
// (for example with Playwright's page.addScriptTag) and call `await patternStudioBenchmark.run()`.
(() => {
    const $ = id => document.getElementById(id);
    const COLS = 339, ROWS = 500;
    const PALETTE = ['#1f2a44', '#3b5ba5', '#7aa6d8', '#c9dcef', '#f4efe6', '#e8b4b8', '#c0605e', '#7d2e2e',
        '#d9a441', '#8a6d3b', '#4f7a4a', '#a3c585', '#2d2d2d', '#6e6e6e', '#b8b8b8', '#ffffff'];
    // MessageChannel yields are not throttled in background tabs, unlike setTimeout.
    const tick = () => new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
    });
    const wait = async ms => {
        const end = performance.now() + ms;
        do await tick(); while (performance.now() < end);
    };
    const until = async (test, timeout = 15000) => {
        const end = performance.now() + timeout;
        while (!test()) {
            if (performance.now() > end) throw new Error('Benchmark setup timed out.');
            await wait(20);
        }
    };

    function referenceDataUrl() {
        const canvas = document.createElement('canvas');
        canvas.width = COLS;
        canvas.height = ROWS;
        const context = canvas.getContext('2d');
        const sky = context.createLinearGradient(0, 0, COLS, ROWS);
        sky.addColorStop(0, '#9fc2f0');
        sky.addColorStop(0.5, '#f6eef2');
        sky.addColorStop(1, '#c98b5a');
        context.fillStyle = sky;
        context.fillRect(0, 0, COLS, ROWS);
        for (let i = 0; i < 40; i++) {
            context.fillStyle = PALETTE[i % PALETTE.length] + '88';
            context.beginPath();
            context.arc((i * 97) % COLS, (i * 61) % ROWS, 20 + (i * 13) % 50, 0, Math.PI * 2);
            context.fill();
        }
        return canvas.toDataURL('image/png');
    }

    // "painted" approximates a finished pattern: contiguous colour regions covering every cell.
    function cells(painted) {
        if (!painted) return Array(COLS * ROWS).fill(null);
        return Array.from({ length: COLS * ROWS }, (_, i) => {
            const x = i % COLS, y = Math.floor(i / COLS);
            return PALETTE[(Math.floor(x / 23) + Math.floor(y / 17) * 3 + Math.floor(Math.sin(x / 9 + y / 15) * 2)) & 15];
        });
    }

    async function load({ painted }) {
        localStorage.setItem('pattern-studio-stroke-widths', JSON.stringify({ paint: 1, line: 1, shape: 1 }));
        // Synthetic pointer events have no active pointer to capture; ignore that so strokes still run.
        const capture = Element.prototype.setPointerCapture;
        Element.prototype.setPointerCapture = function (id) { try { capture.call(this, id); } catch { /* synthetic */ } };
        // Hidden/background tabs can stall HTMLImageElement.decode(); resolve on load instead (benchmark only).
        HTMLImageElement.prototype.decode = function () {
            return this.complete ? Promise.resolve() : new Promise((resolve, reject) => {
                this.addEventListener('load', () => resolve(), { once: true });
                this.addEventListener('error', reject, { once: true });
            });
        };
        const project = {
            version: 1, id: crypto.randomUUID(), name: `Benchmark ${painted ? 'painted' : 'empty'}`, updatedAt: Date.now(),
            width: COLS, height: ROWS, cols: COLS, rows: ROWS, palette: PALETTE.slice(0, 1),
            cells: cells(painted), reference: referenceDataUrl(),
        };
        const input = $('project-file');
        const transfer = new DataTransfer();
        transfer.items.add(new File([JSON.stringify(project)], 'benchmark.json', { type: 'application/json' }));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));
        await until(() => $('dimensions').textContent.startsWith(`${COLS} x ${ROWS}`));
        await wait(50);
    }

    async function zoomTo(level) {
        while ($('zoom-out').disabled === false) $('zoom-out').click(), await wait(0);
        for (let i = 0; i < (level - 1) * 4 && !$('zoom-in').disabled; i++) { $('zoom-in').click(); await wait(10); }
        await wait(250);
        const workspace = $('workspace');
        workspace.scrollLeft = (workspace.scrollWidth - workspace.clientWidth) / 2;
        workspace.scrollTop = (workspace.scrollHeight - workspace.clientHeight) / 2;
        await wait(50);
    }

    function stats(samples) {
        const sorted = [...samples].sort((a, b) => a - b);
        const pick = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
        const round = value => Math.round(value * 100) / 100;
        return {
            samples: samples.length, mean: round(samples.reduce((a, b) => a + b, 0) / samples.length),
            median: round(pick(0.5)), p95: round(pick(0.95)), max: round(sorted[sorted.length - 1]),
            total: round(samples.reduce((a, b) => a + b, 0)), raw: samples.map(round),
        };
    }

    // Draws a wavy stroke across the visible part of the zoomed canvas, one pointermove per sample.
    async function stroke({ moves = 150, flush = false } = {}) {
        document.querySelector('[data-tool="paint"]').click();
        await wait(20);
        if ($('stroke-width')) {
            $('stroke-width').value = '1';
            $('stroke-width').dispatchEvent(new Event('change'));
        }
        const canvas = $('canvas');
        const view = $('workspace').getBoundingClientRect(), rect = canvas.getBoundingClientRect();
        const left = Math.max(view.left, rect.left) + 40, right = Math.min(view.right, rect.right) - 60;
        const top = Math.max(view.top, rect.top) + 40, bottom = Math.min(view.bottom, rect.bottom) - 60;
        const point = t => ({ clientX: left + (right - left) * t, clientY: (top + bottom) / 2 + Math.sin(t * Math.PI * 4) * (bottom - top) / 3 });
        const send = (type, t) => canvas.dispatchEvent(new PointerEvent(type, {
            ...point(t), pointerId: 7, pointerType: 'mouse', isPrimary: true, button: type === 'pointermove' ? -1 : 0,
            buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
        }));
        const readback = flush ? canvas.getContext('2d') : null;
        const samples = [];
        send('pointerdown', 0);
        for (let i = 1; i <= moves; i++) {
            const start = performance.now();
            send('pointermove', i / moves);
            // Reading one pixel forces all queued drawing to finish, so this includes raster work.
            if (readback) readback.getImageData(0, 0, 1, 1);
            samples.push(performance.now() - start);
            await wait(0);
        }
        send('pointerup', 1);
        const cellSize = rect.width / COLS;
        return { ...stats(samples), cellPx: Math.round(cellSize * 100) / 100, bitmap: `${canvas.width}x${canvas.height}` };
    }

    async function run({ painted = false, zoom = 8, moves = 150, flush = false } = {}) {
        await load({ painted });
        await zoomTo(zoom);
        await stroke({ moves: 10 }); // Warm-up so JIT and canvas allocation are excluded from samples.
        $('undo').click();
        await wait(50);
        return { painted, zoom, flush, dpr: devicePixelRatio, ...(await stroke({ moves, flush })) };
    }

    // Times pointerdown, each pointermove, and pointerup for a drag with the given tool.
    // line/shape/select drag out a placement; move pans the workspace.
    async function drag(toolName, { moves = 60, flush = false } = {}) {
        document.querySelector(`[data-tool="${toolName}"]`).click();
        await wait(20);
        const canvas = $('canvas');
        const view = $('workspace').getBoundingClientRect(), rect = canvas.getBoundingClientRect();
        const left = Math.max(view.left, rect.left) + 40, right = Math.min(view.right, rect.right) - 80;
        const top = Math.max(view.top, rect.top) + 40, bottom = Math.min(view.bottom, rect.bottom) - 80;
        const point = t => ({ clientX: left + (right - left) * t, clientY: top + (bottom - top) * t });
        const readback = flush ? canvas.getContext('2d') : null;
        const timed = (type, t) => {
            const start = performance.now();
            canvas.dispatchEvent(new PointerEvent(type, {
                ...point(t), pointerId: 11, pointerType: 'mouse', isPrimary: true, button: type === 'pointermove' ? -1 : 0,
                buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
            }));
            if (readback) readback.getImageData(0, 0, 1, 1);
            return performance.now() - start;
        };
        const down = timed('pointerdown', 0);
        await wait(0);
        const samples = [];
        for (let i = 1; i <= moves; i++) {
            samples.push(timed('pointermove', 0.25 + 0.6 * i / moves));
            await wait(0);
        }
        const up = timed('pointerup', 0.85);
        await wait(0);
        // Clicking away finalizes a line/shape (commits pixels); for a selection it starts a new one.
        const commit = toolName === 'move' ? 0 : timed('pointerdown', 0.05);
        if (toolName !== 'move') timed('pointerup', 0.05);
        if (toolName !== 'move') document.getElementById('placement-cancel')?.click();
        const round = value => Math.round(value * 100) / 100;
        return { tool: toolName, down: round(down), up: round(up), commit: round(commit), ...stats(samples) };
    }

    // Ctrl+wheel zoom steps alternating out/in near the maximum zoom; times each wheel event.
    async function wheelZoom({ steps = 16, flush = false } = {}) {
        const workspace = $('workspace'), canvas = $('canvas');
        const view = workspace.getBoundingClientRect();
        const readback = flush ? canvas.getContext('2d') : null;
        const samples = [];
        for (let i = 0; i < steps; i++) {
            const start = performance.now();
            workspace.dispatchEvent(new WheelEvent('wheel', {
                deltaY: i % 2 ? -100 : 100, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true,
                clientX: view.left + view.width / 2, clientY: view.top + view.height / 2,
            }));
            if (readback) readback.getImageData(0, 0, 1, 1);
            samples.push(performance.now() - start);
            await wait(0);
        }
        // Zoom re-rasterizes once it pauses; report the longest main-thread stall while that happens.
        let settle = 0, last = performance.now();
        const end = last + 500;
        while (last < end) {
            await tick();
            const now = performance.now();
            settle = Math.max(settle, now - last);
            last = now;
        }
        return { tool: 'zoom', ...stats(samples), settle: Math.round(settle * 100) / 100, bitmap: `${canvas.width}x${canvas.height}` };
    }

    // Sweeps ctrl+wheel zoom across the whole range, one wheel step per animation frame like a
    // trackpad, and records frame intervals during the sweep and while the view settles afterwards.
    // Frame times include GPU raster work that per-event timings miss. Needs a visible tab.
    async function zoomSweep({ direction = 'in', settleMs = 500 } = {}) {
        const workspace = $('workspace');
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        while (!$(direction === 'in' ? 'zoom-out' : 'zoom-in').disabled) {
            $(direction === 'in' ? 'zoom-out' : 'zoom-in').click();
            await wait(0);
        }
        await wait(300);
        const view = workspace.getBoundingClientRect();
        const done = () => $(direction === 'in' ? 'zoom-in' : 'zoom-out').disabled;
        const frames = [];
        let last = await frame();
        while (!done()) {
            workspace.dispatchEvent(new WheelEvent('wheel', {
                deltaY: direction === 'in' ? -100 : 100, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true,
                clientX: view.left + view.width / 2, clientY: view.top + view.height / 2,
            }));
            const now = await frame();
            frames.push(now - last);
            last = now;
        }
        const settle = [];
        const end = last + settleMs;
        while (last < end) {
            const now = await frame();
            settle.push(now - last);
            last = now;
        }
        const round = value => Math.round(value * 100) / 100;
        return { tool: `zoom-sweep-${direction}`, ...stats(frames), settleMax: round(Math.max(...settle)) };
    }

    async function scenarios({ painted = true, zoom = 8, moves = 60, flush = true } = {}) {
        await load({ painted });
        await zoomTo(zoom);
        await drag('line', { moves: 5 }); // Warm-up.
        const results = {};
        for (const name of ['line', 'shape', 'select', 'move']) {
            await zoomTo(zoom);
            results[name] = await drag(name, { moves, flush });
            await wait(30);
        }
        await zoomTo(zoom);
        results.zoom = await wheelZoom({ flush });
        return { painted, zoom, flush, dpr: devicePixelRatio, results };
    }

    window.patternStudioBenchmark = { run, load, zoomTo, stroke, drag, wheelZoom, zoomSweep, scenarios };
})();
