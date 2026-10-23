import { MAX_SIDE, gridDimensions } from './model.js';
import { toOklab } from './palette.js';

const hex = channels => '#' + channels.map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('');
const distance = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

export function approximationDimensions(width, height, value, axis = 'cols') {
    if (![width, height, value].every(Number.isFinite) || width < 1 || height < 1 ||
        !Number.isInteger(value) || value < 1 || value > MAX_SIDE || !['cols', 'rows'].includes(axis)) {
        throw new Error('Choose a whole grid dimension from 1 to 500.');
    }
    const side = axis === 'cols' ? width : height;
    const longest = Math.max(1, Math.min(MAX_SIDE, Math.round(value * Math.max(width, height) / side)));
    return gridDimensions(width, height, longest);
}

function nearest(lab, centers) {
    let best = 0, shortest = Infinity;
    for (let i = 0; i < centers.length; i++) {
        const d = distance(lab, centers[i]);
        if (d < shortest) { shortest = d; best = i; }
    }
    return best;
}

function average(points) {
    const sum = [0, 0, 0];
    let weight = 0;
    for (const point of points) {
        weight += point.count;
        for (let c = 0; c < 3; c++) sum[c] += point.lab[c] * point.count;
    }
    return sum.map(value => value / weight);
}

// Frequency-weighted farthest seeds retain distinct minority hues without
// spending most seeds on large regions or choosing every rare edge artifact.
function seeds(points, limit) {
    const centers = [points.reduce((a, b) => a.count > b.count ? a : b).lab];
    const shortest = new Float64Array(points.length).fill(Infinity);
    while (centers.length < limit) {
        const latest = centers[centers.length - 1];
        let best = 0, next = null;
        for (let i = 0; i < points.length; i++) {
            shortest[i] = Math.min(shortest[i], distance(points[i].lab, latest));
            const score = shortest[i] * Math.sqrt(points[i].count);
            if (score > best) { best = score; next = points[i].lab; }
        }
        if (!next) break;
        centers.push(next);
    }
    return centers;
}

function refine(points, centers) {
    let clusters;
    for (let iteration = 0; iteration < 8; iteration++) {
        clusters = centers.map(() => []);
        for (const point of points) clusters[nearest(point.lab, centers)].push(point);
        clusters = clusters.filter(cluster => cluster.length);
        const next = clusters.map(average);
        const stable = next.length === centers.length && next.every((lab, i) => distance(lab, centers[i]) < 1e-8);
        centers = next;
        if (stable) break;
    }
    return clusters.map(items => ({ lab: average(items), count: items.reduce((sum, p) => sum + p.count, 0), items }));
}

// Merge only genuinely close shades, not all colors of the same hue.
function mergeClusters(clusters, threshold) {
    while (clusters.length > 1 && threshold > 0) {
        let best = threshold ** 2, pair = null;
        for (let a = 0; a < clusters.length; a++) {
            for (let b = a + 1; b < clusters.length; b++) {
                const d = distance(clusters[a].lab, clusters[b].lab);
                if (d < best) { best = d; pair = [a, b]; }
            }
        }
        if (!pair) break;
        const [a, b] = pair, items = [...clusters[a].items, ...clusters[b].items];
        clusters[a] = { lab: average(items), count: clusters[a].count + clusters[b].count, items };
        clusters.splice(b, 1);
    }
    return clusters;
}

// Small clusters along the color segment between established shades are often
// antialiased boundaries, not extra yarns. Keep rare hue extremes (e.g. yellow lettering).
function pruneBlends(clusters) {
    const maximum = Math.max(...clusters.map(cluster => cluster.count));
    while (clusters.length > 2) {
        let remove = -1, best = Infinity;
        for (let c = 0; c < clusters.length; c++) {
            const candidate = clusters[c];
            if (candidate.count > maximum * 0.15) continue;
            for (let a = 0; a < clusters.length; a++) {
                if (a === c) continue;
                for (let b = a + 1; b < clusters.length; b++) {
                    if (b === c || clusters[a].count + clusters[b].count < candidate.count * 4) continue;
                    const start = clusters[a].lab, end = clusters[b].lab;
                    const length = distance(start, end);
                    if (!length) continue;
                    const t = candidate.lab.reduce((sum, value, channel) =>
                        sum + (value - start[channel]) * (end[channel] - start[channel]), 0) / length;
                    if (t <= 0.05 || t >= 0.95) continue;
                    const error = distance(candidate.lab, start.map((value, channel) => value + t * (end[channel] - value)));
                    if (error < 0.06 ** 2 && error < best) { best = error; remove = c; }
                }
            }
        }
        if (remove < 0) break;
        clusters.splice(remove, 1);
    }
    return clusters;
}

// Remove small four-connected islands using their most common boundary color. No dithering.
function cleanBlocks(labels, cols, rows, minimum) {
    if (minimum <= 1) return labels;
    const result = labels.slice(), seen = new Uint8Array(labels.length), stack = [];
    for (let start = 0; start < labels.length; start++) {
        if (seen[start] || labels[start] < 0) continue;
        const color = labels[start], component = [], boundary = new Map();
        stack.push(start);
        seen[start] = 1;
        while (stack.length) {
            const i = stack.pop(), x = i % cols, y = Math.floor(i / cols);
            component.push(i);
            const neighbors = [];
            if (x > 0) neighbors.push(i - 1);
            if (x + 1 < cols) neighbors.push(i + 1);
            if (y > 0) neighbors.push(i - cols);
            if (y + 1 < rows) neighbors.push(i + cols);
            for (const n of neighbors) {
                if (labels[n] === color) {
                    if (!seen[n]) { seen[n] = 1; stack.push(n); }
                } else if (labels[n] >= 0) {
                    boundary.set(labels[n], (boundary.get(labels[n]) || 0) + 1);
                }
            }
        }
        if (component.length >= minimum || !boundary.size) continue;
        const replacement = [...boundary].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
        for (const index of component) result[index] = replacement;
    }
    return result;
}

function histogram(rgba, brightness, contrast) {
    const buckets = new Map(), keys = new Int32Array(rgba.length / 4).fill(-1);
    const factor = (100 + contrast) / (100 - contrast);
    for (let i = 0; i < keys.length; i++) {
        const at = i * 4, alpha = rgba[at + 3] / 255;
        if (!alpha) continue;
        const rgb = [0, 1, 2].map(c => {
            const value = rgba[at + c] * alpha + 255 * (1 - alpha);
            return Math.max(0, Math.min(255, (value - 128) * factor + 128 + brightness * 2.55));
        });
        const key = (Math.floor(rgb[0] / 8) << 10) | (Math.floor(rgb[1] / 8) << 5) | Math.floor(rgb[2] / 8);
        keys[i] = key;
        let bucket = buckets.get(key);
        if (!bucket) { bucket = { count: 0, rgb: [0, 0, 0] }; buckets.set(key, bucket); }
        bucket.count++;
        for (let c = 0; c < 3; c++) bucket.rgb[c] += rgb[c];
    }
    for (const point of buckets.values()) {
        point.rgb = point.rgb.map(value => value / point.count);
        point.lab = toOklab(hex(point.rgb));
    }
    return { buckets, keys };
}

export function approximateGrid({ rgba, analysisRgba = null, cols, rows, colors = 16, merge = 4, minimum = 1, blocks = 2, brightness = 0, contrast = 0, simplify = true }) {
    const whole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
    if (!whole(cols, 1, MAX_SIDE) || !whole(rows, 1, MAX_SIDE) ||
        !(rgba instanceof Uint8ClampedArray) || rgba.length !== cols * rows * 4 ||
        (analysisRgba !== null && (!(analysisRgba instanceof Uint8ClampedArray) ||
            analysisRgba.length < 4 || analysisRgba.length > 40000 || analysisRgba.length % 4 !== 0)) ||
        !whole(colors, 1, 32) || !whole(merge, 0, 10) || !whole(minimum, 1, 1000) ||
        !whole(blocks, 0, 20) || !whole(brightness, -50, 50) || !whole(contrast, -50, 50) || typeof simplify !== 'boolean') {
        throw new Error('Invalid approximation settings or image pixels.');
    }
    // A 5-bit RGB histogram bounds clustering to 32,768 bins, regardless of grid size.
    const { buckets, keys } = histogram(rgba, brightness, contrast);
    if (!buckets.size) throw new Error('This image is fully transparent. Choose an image with visible colors.');
    const points = [...buckets.values()];
    const training = analysisRgba ? [...histogram(analysisRgba, brightness, contrast).buckets.values()] : points;
    if (!training.length) throw new Error('No visible colors were found during palette analysis.');
    let clusters = mergeClusters(refine(training, seeds(training, colors)), merge / 100);
    if (simplify) clusters = pruneBlends(clusters);
    // Minimum usage is in output stitches, not pixels of the smaller analysis image.
    const counts = new Array(clusters.length).fill(0);
    const candidateLabs = clusters.map(cluster => cluster.lab);
    for (const point of points) counts[nearest(point.lab, candidateLabs)] += point.count;
    const common = clusters.filter((cluster, index) => counts[index] >= minimum);
    clusters = common.length ? common : [clusters[counts.indexOf(Math.max(...counts))]];
    const centers = clusters.map(cluster => cluster.lab);
    const palette = clusters.map(cluster => {
        const rgb = [0, 0, 0];
        for (const point of cluster.items) {
            for (let c = 0; c < 3; c++) rgb[c] += point.rgb[c] * point.count;
        }
        return hex(rgb.map(value => value / cluster.count));
    });
    for (const point of points) {
        point.index = nearest(point.lab, centers);
    }
    const labels = cleanBlocks(Int16Array.from(keys, key => key < 0 ? -1 : buckets.get(key).index), cols, rows, blocks);
    const cells = Array.from(labels, index => index < 0 ? null : palette[index]);
    const usageCounts = new Map();
    for (const color of cells) if (color !== null) usageCounts.set(color, (usageCounts.get(color) || 0) + 1);
    const usage = [...usageCounts].map(([color, count]) => ({ color, count })).sort((a, b) => b.count - a.count || a.color.localeCompare(b.color));
    return { cols, rows, cells, palette: usage.map(item => item.color), usage };
}
