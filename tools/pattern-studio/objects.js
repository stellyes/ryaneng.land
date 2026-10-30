import { line } from './model.js';

export function boxFromCells(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const width = Math.abs(a.x - b.x) + 1, height = Math.abs(a.y - b.y) + 1;
    return { cx: x + width / 2, cy: y + height / 2, width, height, angle: 0 };
}

export function rotatePoint(x, y, angle) {
    const radians = angle * Math.PI / 180;
    return { x: x * Math.cos(radians) - y * Math.sin(radians), y: x * Math.sin(radians) + y * Math.cos(radians) };
}

export function objectCorners(object) {
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
        const point = rotatePoint(x * object.width / 2, y * object.height / 2, object.angle);
        return { x: object.cx + point.x, y: object.cy + point.y };
    });
}

export function snapTranslation(object, dx, dy, targets, cols, rows) {
    const corners = objectCorners(object);
    const left = Math.min(...corners.map(p => p.x)), right = Math.max(...corners.map(p => p.x));
    const top = Math.min(...corners.map(p => p.y)), bottom = Math.max(...corners.map(p => p.y));
    const result = { dx: Math.round(dx), dy: Math.round(dy), guides: [] };
    for (const [axis, raw, size, source] of [
        ['x', dx, cols, [left, (left + right) / 2, right]],
        ['y', dy, rows, [top, (top + bottom) / 2, bottom]],
    ]) {
        let best = null;
        for (const target of targets) {
            const start = target[axis], length = target[axis === 'x' ? 'width' : 'height'];
            for (const value of [start, start + length / 2, start + length]) for (const edge of source) {
                const delta = value - edge, distance = Math.abs(delta - raw);
                // Keep pixels on whole cells; unequal-parity centers cannot align exactly.
                if (Math.abs(delta - Math.round(delta)) > 1e-8 || distance > size * 0.03) continue;
                if (!best || distance < best.distance) best = { delta: Math.round(delta), value, distance };
            }
        }
        if (best) {
            result[axis === 'x' ? 'dx' : 'dy'] = best.delta;
            result.guides.push({ axis, value: best.value });
        }
    }
    return result;
}

export function resizeObject(object, corner, point) {
    const signs = { nw: [-1, -1], ne: [1, -1], se: [1, 1], sw: [-1, 1] };
    const [sx, sy] = signs[corner];
    const local = rotatePoint(point.x - object.cx, point.y - object.cy, -object.angle);
    const opposite = { x: -sx * object.width / 2, y: -sy * object.height / 2 };
    const width = Math.max(1, Math.min(500, Math.round(sx * (local.x - opposite.x))));
    const height = Math.max(1, Math.min(500, Math.round(sy * (local.y - opposite.y))));
    const center = rotatePoint(opposite.x + sx * width / 2, opposite.y + sy * height / 2, object.angle);
    return { ...object, cx: object.cx + center.x, cy: object.cy + center.y, width, height };
}

function polygonContains(vertices, x, y) {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
        const a = vertices[i], b = vertices[j];
        if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

export const MAX_STROKE = 20;

export function strokeWidth(value) {
    const width = Number(value);
    return Number.isInteger(width) && width >= 1 && width <= MAX_STROKE ? width : 1;
}

// Square brush centered on (x, y); even widths extend one extra cell right/down.
export function brushBounds(x, y, size) {
    const width = strokeWidth(size), offset = Math.floor((width - 1) / 2);
    return { x: x - offset, y: y - offset, width, height: width };
}

export function brush(x, y, size, visit) {
    const bounds = brushBounds(x, y, size);
    for (let dy = 0; dy < bounds.height; dy++) for (let dx = 0; dx < bounds.width; dx++) visit(bounds.x + dx, bounds.y + dy);
}

export function shapeMask(shape, width, height, filled, stroke = 1) {
    const mask = Array(width * height).fill(false);
    let vertices;
    if (shape === 'triangle') vertices = [{ x: width / 2, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
    else if (shape === 'star') {
        vertices = Array.from({ length: 10 }, (_, i) => {
            const angle = -Math.PI / 2 + i * Math.PI / 5, radius = i % 2 ? 0.42 : 1;
            return { x: width / 2 + Math.cos(angle) * width / 2 * radius, y: height / 2 + Math.sin(angle) * height / 2 * radius };
        });
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        mask[y * width + x] = shape === 'rectangle' || (shape === 'ellipse'
            ? ((x + 0.5) * 2 / width - 1) ** 2 + ((y + 0.5) * 2 / height - 1) ** 2 <= 1
            : polygonContains(vertices, x + 0.5, y + 0.5));
    }
    // Pixel-connected polygon edges also keep very small/thin shapes visible.
    if (vertices) vertices.forEach((a, i) => {
        const b = vertices[(i + 1) % vertices.length];
        const pixel = (v, max) => Math.max(0, Math.min(max - 1, Math.floor(v)));
        line(pixel(a.x, width), pixel(a.y, height), pixel(b.x, width), pixel(b.y, height), (x, y) => { mask[y * width + x] = true; });
    });
    if (filled) return mask;
    // Keep shape cells within `stroke` steps of the outside (or the bounds) to form the outline.
    const limit = strokeWidth(stroke), depth = new Int32Array(width * height), queue = [];
    for (let i = 0; i < mask.length; i++) {
        const x = i % width;
        if (mask[i] && (x === 0 || x === width - 1 || i < width || i >= width * (height - 1) ||
            !mask[i - 1] || !mask[i + 1] || !mask[i - width] || !mask[i + width])) {
            depth[i] = 1;
            queue.push(i);
        }
    }
    for (let q = 0; q < queue.length; q++) {
        const i = queue[q], x = i % width;
        if (depth[i] >= limit) continue;
        const neighbours = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width];
        for (const n of neighbours) {
            if (n < 0 || n >= mask.length || !mask[n] || depth[n]) continue;
            depth[n] = depth[i] + 1;
            queue.push(n);
        }
    }
    return mask.map((value, i) => value && depth[i] > 0);
}

export function rasterObject(object, cols, rows, color) {
    const pixels = new Map();
    const set = (x, y, value) => {
        if (value && x >= 0 && y >= 0 && x < cols && y < rows) pixels.set(y * cols + x, value);
    };
    if (object.kind === 'selection') return pixels;
    if (object.kind === 'line') {
        line(object.a.x, object.a.y, object.b.x, object.b.y, (x, y) => brush(x, y, object.stroke, (bx, by) => set(bx, by, color)));
        return pixels;
    }
    const source = object.kind === 'paste' ? object.source : {
        width: object.width, height: object.height,
        cells: shapeMask(object.shape, object.width, object.height, object.filled, object.stroke).map(value => value ? color : null),
    };
    const corners = objectCorners(object);
    const left = Math.max(0, Math.floor(Math.min(...corners.map(p => p.x))));
    const right = Math.min(cols, Math.ceil(Math.max(...corners.map(p => p.x))));
    const top = Math.max(0, Math.floor(Math.min(...corners.map(p => p.y))));
    const bottom = Math.min(rows, Math.ceil(Math.max(...corners.map(p => p.y))));
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const local = rotatePoint(x + 0.5 - object.cx, y + 0.5 - object.cy, -object.angle);
        const u = (local.x / object.width + 0.5), v = (local.y / object.height + 0.5);
        if (u < -1e-9 || v < -1e-9 || u >= 1 - 1e-9 || v >= 1 - 1e-9) continue;
        const sx = Math.max(0, Math.floor(u * source.width + 1e-9));
        const sy = Math.max(0, Math.floor(v * source.height + 1e-9));
        set(x, y, source.cells[sy * source.width + sx]);
    }
    return pixels;
}

export function copyCells(project, box) {
    const x = Math.round(box.cx - box.width / 2), y = Math.round(box.cy - box.height / 2);
    const cells = [];
    for (let row = 0; row < box.height; row++) for (let col = 0; col < box.width; col++) {
        const sx = x + col, sy = y + row;
        cells.push(sx >= 0 && sy >= 0 && sx < project.cols && sy < project.rows ? project.cells[sy * project.cols + sx] : null);
    }

    return { width: box.width, height: box.height, cells };
}

export function rasterLayerObject(object) {
    const corners = objectCorners(object);
    const x = Math.floor(Math.min(...corners.map(point => point.x))), y = Math.floor(Math.min(...corners.map(point => point.y)));
    const cols = Math.ceil(Math.max(...corners.map(point => point.x))) - x;
    const rows = Math.ceil(Math.max(...corners.map(point => point.y))) - y;
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || cols * rows > 4000000) {
        throw new Error('This layer transform exceeds the 4 million-cell working area. Reduce the layer dimensions.');
    }
    return [...rasterObject({ ...object, kind: 'paste', cx: object.cx - x, cy: object.cy - y }, cols, rows)]
        .map(([index, color]) => [x + index % cols, y + Math.floor(index / cols), color]);
}
