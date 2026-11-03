export function transformMatrix(source, matrix) {
    const [a, b, c, d, e, f] = matrix, [g, h, i, j, k, l] = source;
    return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j,
        a * k + c * l + e, b * k + d * l + f];
}

export function vectorBounds(vector) {
    const [a, b, c, d, e, f] = vector.matrix;
    const corners = [[0, 0], [vector.width, 0], [vector.width, vector.height], [0, vector.height]]
        .map(([x, y]) => ({ x: a * x + c * y + e, y: b * x + d * y + f }));
    const x = Math.floor(Math.min(...corners.map(p => p.x)) + 1e-8), y = Math.floor(Math.min(...corners.map(p => p.y)) + 1e-8);
    return { x, y, width: Math.max(1, Math.ceil(Math.max(...corners.map(p => p.x)) - 1e-8) - x),
        height: Math.max(1, Math.ceil(Math.max(...corners.map(p => p.y)) - 1e-8) - y) };
}

export function placementMatrix(original, object) {
    const angle = object.angle * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    const a = cos * object.width / original.width, b = sin * object.width / original.width;
    const c = -sin * object.height / original.height, d = cos * object.height / original.height;
    const cx = original.x + original.width / 2, cy = original.y + original.height / 2;
    return [a, b, c, d, object.cx - a * cx - c * cy, object.cy - b * cx - d * cy];
}
