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

// Adds blank (null) cells around the grid; each side is a count of whole columns or rows.
export function extendCells(cells, cols, rows, { left = 0, right = 0, top = 0, bottom = 0 }) {
    const nextCols = cols + left + right, nextRows = rows + top + bottom;
    const next = new Array(nextCols * nextRows).fill(null);
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) next[(y + top) * nextCols + x + left] = cells[y * cols + x];
    }
    return { cells: next, cols: nextCols, rows: nextRows };
}

// 'horizontal' flips left-right across the central vertical axis; 'vertical' flips top-bottom.
// With an odd count, the center column or row maps onto itself.
export function mirrorCells(cells, cols, rows, axis) {
    return cells.map((_, index) => {
        const x = index % cols, y = (index - x) / cols;
        return axis === 'horizontal' ? cells[y * cols + cols - 1 - x] : cells[(rows - 1 - y) * cols + x];
    });
}

// Rotates 90 degrees; the result has the column and row counts swapped.
export function rotateCells(cells, cols, rows, clockwise) {
    const next = new Array(cells.length);
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const nx = clockwise ? rows - 1 - y : y, ny = clockwise ? x : cols - 1 - x;
            next[ny * rows + nx] = cells[y * cols + x];
        }
    }
    return { cells: next, cols: rows, rows: cols };
}

// The board is the grid's extent in reference-pixel units (project.width x project.height).
// Normally the reference fills it; after rows/columns are added, project.referenceRect says
// where the unscaled reference sits, and the rest of the board is blank.
export function referenceRect(project) {
    return project.referenceRect || { x: 0, y: 0, width: project.width, height: project.height };
}

const tidy = value => Math.round(value * 1e6) / 1e6;

// Grows the board by whole cells; the reference keeps its pixels and shifts with the old cells.
export function extendBoard(project, { left = 0, right = 0, top = 0, bottom = 0 }) {
    const cellWidth = project.width / project.cols, cellHeight = project.height / project.rows;
    const rect = referenceRect(project);
    return {
        width: tidy(project.width + cellWidth * (left + right)),
        height: tidy(project.height + cellHeight * (top + bottom)),
        referenceRect: { ...rect, x: tidy(rect.x + cellWidth * left), y: tidy(rect.y + cellHeight * top) },
    };
}

export function mirrorBoard(project, axis) {
    if (!project.referenceRect) return { referenceRect: null };
    const rect = project.referenceRect;
    return {
        referenceRect: axis === 'horizontal'
            ? { ...rect, x: tidy(project.width - rect.x - rect.width) }
            : { ...rect, y: tidy(project.height - rect.y - rect.height) },
    };
}

export function rotateBoard(project, clockwise) {
    const rect = project.referenceRect;
    return {
        width: project.height, height: project.width,
        referenceRect: rect && (clockwise
            ? { x: tidy(project.height - rect.y - rect.height), y: rect.x, width: rect.height, height: rect.width }
            : { x: rect.y, y: tidy(project.width - rect.x - rect.width), width: rect.height, height: rect.width }),
    };
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
    const rect = data?.referenceRect;
    const fits = (value, max) => Number.isFinite(value) && value > 0 && value <= max;
    // A padded board may have fractional edges; the reference itself is always whole pixels.
    const boardValid = rect == null
        ? Number.isInteger(data?.width) && Number.isInteger(data?.height) && fits(data.width, MAX_SIDE) && fits(data.height, MAX_SIDE)
        : fits(data.width, MAX_SIDE * MAX_SIDE) && fits(data.height, MAX_SIDE * MAX_SIDE) &&
          typeof rect === 'object' && Number.isInteger(rect.width) && Number.isInteger(rect.height) &&
          fits(rect.width, MAX_SIDE) && fits(rect.height, MAX_SIDE) && Number.isFinite(rect.x) && Number.isFinite(rect.y) &&
          rect.x >= -0.001 && rect.y >= -0.001 && rect.x + rect.width <= data.width + 0.001 && rect.y + rect.height <= data.height + 0.001;
    if (!data || data.version !== 1 || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80 || !boardValid ||
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
    // Only an unpadded board must match the reference proportions exactly.
    const expected = gridDimensions(data.width, data.height, Math.max(data.cols, data.rows));
    if (rect == null && (expected.cols !== data.cols || expected.rows !== data.rows)) {
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
