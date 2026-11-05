const rectValid = rect => Array.isArray(rect) && rect.length === 4 &&
    rect.every(Number.isFinite) && rect[0] >= 0 && rect[1] >= 0 &&
    rect[2] > 0 && rect[3] > 0 && rect.every(value => value <= 10000000);

export function validateRepeatLayout(layout, viewBox = null) {
    if (!layout || !Number.isFinite(layout.thickness) || layout.thickness < 1 || layout.thickness > 500 ||
        (layout.maxThickness !== undefined && (!Number.isInteger(layout.maxThickness) ||
            layout.maxThickness < 1 || layout.maxThickness > 500)) ||
        !rectValid(layout.corner) ||
        (layout.cornerSize !== undefined && (!Number.isFinite(layout.cornerSize) ||
            layout.cornerSize < layout.thickness || layout.cornerSize > 1000)) ||
        !Array.isArray(layout.edges) || !layout.edges.length || layout.edges.length > 8 ||
        layout.edges.some(edge => !edge || !rectValid(edge.source) || !['repeat', 'stretch'].includes(edge.mode) ||
            !Number.isFinite(edge.offset) || edge.offset < 0 || !Number.isFinite(edge.depth) ||
            edge.depth <= 0 || edge.offset + edge.depth > layout.thickness ||
            (edge.phaseAfterCut !== undefined && (!Number.isFinite(edge.phaseAfterCut) ||
                edge.phaseAfterCut < 0 || edge.phaseAfterCut >= edge.source[2] / edge.source[3] * edge.depth)) ||
            edge.source[2] / edge.source[3] * edge.depth < 1) ||
        (layout.ornament !== undefined && (!layout.ornament || !rectValid(layout.ornament.source) ||
            !Number.isFinite(layout.ornament.offset) || layout.ornament.offset < 0 ||
            !Number.isFinite(layout.ornament.depth) || layout.ornament.depth <= 0 ||
            layout.ornament.offset + layout.ornament.depth > layout.thickness ||
            layout.ornament.source[2] / layout.ornament.source[3] * layout.ornament.depth < 1 ||
            !Number.isFinite(layout.ornament.minGap) || layout.ornament.minGap < 0 ||
            !Number.isFinite(layout.ornament.maxGap) || layout.ornament.maxGap < layout.ornament.minGap ||
            (layout.ornament.dense !== undefined && typeof layout.ornament.dense !== 'boolean') ||
            (layout.ornament.separator !== undefined && (!layout.ornament.separator ||
                !rectValid(layout.ornament.separator.source) ||
                !Number.isFinite(layout.ornament.separator.offset) || layout.ornament.separator.offset < 0 ||
                !Number.isFinite(layout.ornament.separator.depth) || layout.ornament.separator.depth <= 0 ||
                layout.ornament.separator.offset + layout.ornament.separator.depth > layout.thickness ||
                layout.ornament.separator.source[2] / layout.ornament.separator.source[3] * layout.ornament.separator.depth < 1)) ||
            (layout.ornament.edgeCuts !== undefined && (!Array.isArray(layout.ornament.edgeCuts) ||
                layout.ornament.edgeCuts.length > 8 || layout.ornament.edgeCuts.some(cut => !rectValid(cut) ||
                    cut[0] + cut[2] > layout.ornament.source[2] / layout.ornament.source[3] * layout.ornament.depth ||
                    cut[1] + cut[3] > layout.thickness)))))) {
        throw new Error('Invalid repeating border recipe.');
    }
    const cuts = layout.ornament?.edgeCuts ?? [];
    if (layout.nativeRepeat !== undefined && (!rectValid(layout.nativeRepeat) ||
        !layout.ornament?.separator || layout.ornament.minGap !== 0 ||
        Math.abs(layout.nativeRepeat[2] / layout.nativeRepeat[3] * layout.thickness -
            (layout.ornament.source[2] / layout.ornament.source[3] * layout.ornament.depth +
                layout.ornament.separator.source[2] / layout.ornament.separator.source[3] *
                    layout.ornament.separator.depth)) > 1e-8)) {
        throw new Error('Native repeat must contain one complete ornament and separator cycle.');
    }
    if (cuts.some((cut, i) => cuts.slice(i + 1).some(other =>
        cut[0] < other[0] + other[2] && cut[0] + cut[2] > other[0] &&
        cut[1] < other[1] + other[3] && cut[1] + cut[3] > other[1]))) {
        throw new Error('Repeating border edge cutouts must not overlap.');
    }
    if (viewBox) {
        const [x, y, w, h] = viewBox;
        const rectangles = [layout.corner, ...layout.edges.map(edge => edge.source),
            ...(layout.ornament ? [layout.ornament.source] : []),
            ...(layout.ornament?.separator ? [layout.ornament.separator.source] : []),
            ...(layout.nativeRepeat ? [layout.nativeRepeat] : [])];
        if (rectangles.some(rect => rect[0] < x || rect[1] < y ||
            rect[0] + rect[2] > x + w || rect[1] + rect[3] > y + h)) {
            throw new Error('Repeating border sections must fit inside the source viewBox.');
        }
    }
}

export function repeatSpacing(length, unit, minGap, maxGap) {
    if (![length, unit, minGap, maxGap].every(Number.isFinite) || length < 0 || unit <= 0 ||
        minGap < 0 || maxGap < minGap) throw new Error('Invalid border repeat spacing.');
    if (length < unit) return { count: 0, gap: length / 2, starts: [] };
    let count = Math.max(1, Math.ceil((length - maxGap) / (unit + maxGap)));
    const maximum = Math.max(1, Math.floor((length - minGap) / (unit + minGap)));
    count = Math.min(count, maximum);
    if (count > 8192) throw new Error('Border has too many ornamental repeats. Increase thickness or simplify the recipe.');
    const gap = Math.max(0, (length - count * unit) / (count + 1));
    return { count, gap, starts: Array.from({ length: count }, (_, i) => gap + i * (unit + gap)) };
}

export function sequenceSpacing(length, unit, separator, minGap, maxGap, dense = false) {
    if (![length, unit, separator, minGap, maxGap].every(Number.isFinite) || length < 0 ||
        unit <= 0 || separator <= 0 || minGap < 0 || maxGap < minGap) {
        throw new Error('Invalid border sequence spacing.');
    }
    if (length < separator) return { count: 0, gap: length / 2, starts: [], separators: [] };
    const minimum = Math.max(0, Math.ceil((length - separator - 2 * maxGap) / (unit + separator + 2 * maxGap)));
    const maximum = Math.max(0, Math.floor((length - separator - 2 * minGap) / (unit + separator + 2 * minGap)));
    let count = dense ? maximum : Math.min(minimum, maximum);
    if (count > 8192) throw new Error('Border has too many ornamental repeats. Increase thickness or simplify the recipe.');
    if (dense) {
        const flowers = Math.max(0, Math.floor((length + separator) / (unit + separator + 2 * minGap)));
        const packed = count * unit + (count + 1) * separator;
        const flowerPacked = flowers * unit + Math.max(0, flowers - 1) * separator;
        if (flowers > 0 && flowerPacked > packed) {
            if (flowers > 8192) throw new Error('Border has too many ornamental repeats. Increase thickness or simplify the recipe.');
            const gap = Math.max(0, (length - flowerPacked) / (flowers * 2));
            const step = unit + separator + gap * 2;
            return { count: flowers, gap,
                starts: Array.from({ length: flowers }, (_, i) => gap + i * step),
                separators: Array.from({ length: flowers - 1 }, (_, i) => unit + gap * 2 + i * step) };
        }
        if (!count) {
            const scrolls = Math.max(1, Math.floor((length - minGap) / (separator + minGap)));
            if (scrolls > 8192) throw new Error('Border has too many ornamental repeats. Increase thickness or simplify the recipe.');
            const gap = Math.max(0, (length - scrolls * separator) / (scrolls + 1));
            return { count: 0, gap, starts: [],
                separators: Array.from({ length: scrolls }, (_, i) => gap + i * (separator + gap)) };
        }
    }
    const gap = Math.max(0, (length - count * unit - (count + 1) * separator) / (count * 2 + 2));
    const step = unit + separator + gap * 2;
    return { count, gap,
        starts: Array.from({ length: count }, (_, i) => separator + gap * 2 + i * step),
        separators: Array.from({ length: count + 1 }, (_, i) => gap + i * step) };
}

export function repeatingBorderPlan(layout, width, height, thickness) {
    validateRepeatLayout(layout);
    const scale = thickness / layout.thickness;
    const cornerSize = (layout.cornerSize ?? layout.thickness) * scale;
    if (![width, height, thickness].every(Number.isFinite) || width < 1 || height < 1 ||
        thickness <= 0 || thickness > 10000000 || width < cornerSize * 2 || height < cornerSize * 2) {
        throw new Error('Border frame must fit two complete corners in both directions. Reduce thickness or enlarge the frame.');
    }
    const corners = [
        { matrix: [1, 0, 0, 1, 0, 0] }, { matrix: [0, 1, -1, 0, width, 0] },
        { matrix: [-1, 0, 0, -1, width, height] }, { matrix: [0, -1, 1, 0, 0, height] },
    ];
    const sides = [
        { length: width - cornerSize * 2, matrix: [1, 0, 0, 1, cornerSize, 0] },
        { length: height - cornerSize * 2, matrix: [0, 1, -1, 0, width, cornerSize] },
        { length: width - cornerSize * 2, matrix: [-1, 0, 0, -1, width - cornerSize, height] },
        { length: height - cornerSize * 2, matrix: [0, -1, 1, 0, 0, height - cornerSize] },
    ];
    for (const side of sides) {
        const ornament = layout.ornament;
        const unit = ornament ? ornament.source[2] / ornament.source[3] * ornament.depth * scale : 0;
        const separator = ornament?.separator;
        side.separatorUnit = separator ? separator.source[2] / separator.source[3] * separator.depth * scale : 0;
        side.ornaments = separator ? sequenceSpacing(side.length, unit, side.separatorUnit,
            ornament.minGap * scale, ornament.maxGap * scale, ornament.dense) : ornament ?
            repeatSpacing(side.length, unit, ornament.minGap * scale, ornament.maxGap * scale) :
            { count: 0, gap: 0, starts: [] };
        side.unit = unit;
    }
    return { scale, thickness, cornerSize, corners, sides };
}
