export const MAX_SIDE = 500;

export function parseGridSize(value) {
    const text = String(value).trim();
    if (/[a-z]/i.test(text) || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
        throw new Error('Use a number without letters.');
    }
    // Floor decimal text directly so floating-point rounding cannot promote a long fraction.
    const [whole, fraction = ''] = text.replace(/^[+-]/, '').split('.');
    const magnitude = Number(whole || '0');
    const size = text.startsWith('-') ? -magnitude - (/[1-9]/.test(fraction) ? 1 : 0) : magnitude;
    if (!Number.isFinite(size) || size < 4 || size > MAX_SIDE) {
        throw new Error('Grid size must round down to a value from 4 to 500.');
    }
    return size;
}

export function gridDimensions(width, height, longest) {
    const ratio = longest / Math.max(width, height);
    return { cols: Math.max(1, Math.round(width * ratio)), rows: Math.max(1, Math.round(height * ratio)) };
}

export function resizeCells(cells, cols, rows, nextCols, nextRows) {
    return Array.from({ length: nextCols * nextRows }, (_, index) => {
        const x = Math.min(cols - 1, Math.floor((index % nextCols + 0.5) * cols / nextCols));
        const y = Math.min(rows - 1, Math.floor((Math.floor(index / nextCols) + 0.5) * rows / nextRows));
        return cells[y * cols + x];
    });
}

export function cropCells(project, rect, cols, rows) {
    return Array.from({ length: cols * rows }, (_, index) => {
        const x = rect.x + (index % cols + 0.5) * rect.width / cols;
        const y = rect.y + (Math.floor(index / cols) + 0.5) * rect.height / rows;
        const sourceX = Math.min(project.cols - 1, Math.floor(x / project.width * project.cols));
        const sourceY = Math.min(project.rows - 1, Math.floor(y / project.height * project.rows));
        return project.cells[sourceY * project.cols + sourceX];
    });
}

export function flood(cells, cols, rows, x, y, color) {
    const start = y * cols + x;
    const target = cells[start];
    if (target === color) return false;
    const stack = [start];
    cells[start] = color;
    while (stack.length) {
        const index = stack.pop();
        const neighbors = [];
        if (index % cols > 0) neighbors.push(index - 1);
        if (index % cols < cols - 1) neighbors.push(index + 1);
        if (index >= cols) neighbors.push(index - cols);
        if (index < cols * (rows - 1)) neighbors.push(index + cols);
        for (const next of neighbors) {
            if (cells[next] === target) {
                cells[next] = color;
                stack.push(next);
            }
        }
    }
    return true;
}

export function line(x0, y0, x1, y1, visit) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let error = dx + dy;
    while (true) {
        visit(x0, y0);
        if (x0 === x1 && y0 === y1) break;
        const twice = 2 * error;
        if (twice >= dy) { error += dy; x0 += sx; }
        if (twice <= dx) { error += dx; y0 += sy; }
    }
}

export function validateProject(data) {
    const hex = /^#[0-9a-f]{6}$/i;
    if (!data || data.version !== 1 || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80 ||
        !Number.isInteger(data.width) || !Number.isInteger(data.height) ||
        data.width < 1 || data.height < 1 || Math.max(data.width, data.height) > MAX_SIDE ||
        !Number.isInteger(data.cols) || !Number.isInteger(data.rows) ||
        data.cols < 1 || data.rows < 1 || Math.max(data.cols, data.rows) > MAX_SIDE ||
        !Array.isArray(data.palette) || data.palette.length > 32 ||
        !data.palette.every(c => typeof c === 'string' && hex.test(c)) ||
        !Array.isArray(data.cells) || data.cells.length !== data.cols * data.rows ||
        !data.cells.every(c => c === null || (typeof c === 'string' && hex.test(c))) ||
        typeof data.reference !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.reference) ||
        data.reference.length > 3000000) {
        throw new Error('Invalid project backup. Choose a Pattern Studio project JSON file.');
    }
    const expected = gridDimensions(data.width, data.height, Math.max(data.cols, data.rows));
    if (expected.cols !== data.cols || expected.rows !== data.rows) {
        throw new Error('The project grid does not match its reference proportions.');
    }
    return data;
}

export function openStore(name = 'pattern-studio') {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'id' });
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Close other Pattern Studio tabs to open project storage.'));
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => db.close();
            resolve({
                run(mode, action) {
                    return new Promise((done, fail) => {
                        const transaction = db.transaction('projects', mode);
                        const result = action(transaction.objectStore('projects'));
                        transaction.oncomplete = () => done(result.result);
                        transaction.onerror = () => fail(transaction.error);
                        transaction.onabort = () => fail(transaction.error || new Error('Project storage was interrupted.'));
                    });
                },
                close: () => db.close(),
            });
        };
    });
}
