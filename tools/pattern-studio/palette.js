// Perceptive color comparison, not simply looking at the closest hex values
// Values determined by "Oklab perceptual color distance"

function toOklab(hex) {
    if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) {
        throw new Error('Colors must be six-digit hex values such as #123456.');
    }
    const [r, g, b] = [1, 3, 5].map(start => {
        const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

export function findClosestColor(inputColor, palette) {
    const input = toOklab(inputColor);
    if (!Array.isArray(palette) || palette.length === 0) {
        throw new Error('Choose a product-line palette with at least one color.');
    }
    let closest, shortest = Infinity;
    for (const candidate of palette) {
        const lab = toOklab(candidate);
        const distance = lab.reduce((sum, channel, index) => sum + (channel - input[index]) ** 2, 0);
        if (distance < shortest) {
            shortest = distance;
            closest = candidate;
        }
    }
    return closest;
}

// Oklab distance at which a match scores 0. Roughly: 0.02 is barely noticeable,
// 0.05 is a close substitute, 0.1 is clearly different, and 0.3 is a different color.
export const ZERO_SCORE_DISTANCE = 0.3;
// A project color counts as "usable" when its own yarn scores at least this much (distance <= 0.09).
export const USABLE_SCORE = 70;
// Project colors closer than this are treated as one yarn instead of competing for two.
export const SHARE_DISTANCE = 0.04;

export function colorDistance(a, b) {
    const [l1, a1, b1] = toOklab(a), [l2, a2, b2] = toOklab(b);
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

export function matchScore(distance) {
    return 100 * Math.max(0, 1 - distance / ZERO_SCORE_DISTANCE);
}

// Validates the catalog once and caches Oklab values so ranking every line stays fast.
export function prepareYarnLines(palettes) {
    if (!palettes || typeof palettes !== 'object' || Array.isArray(palettes)) throw new Error('The yarn catalog is invalid.');
    return Object.entries(palettes).map(([name, colors]) => {
        if (!Array.isArray(colors) || !colors.length) throw new Error(`Yarn line "${name}" has no colors.`);
        const labs = new Float64Array(colors.length * 3);
        colors.forEach((color, index) => labs.set(toOklab(color), index * 3));
        return { name, colors, labs };
    });
}

// Counts how many cells use each color. Palette colors that are not painted yet are included with a count of 0.
export function colorUsage(cells, palette = []) {
    const counts = new Map();
    for (const color of palette) counts.set(color.toLowerCase(), 0);
    for (const color of cells) {
        if (color !== null) counts.set(color.toLowerCase(), (counts.get(color.toLowerCase()) || 0) + 1);
    }
    return [...counts].map(([color, count]) => ({ color, count }));
}

// Groups near-identical project colors so they can share one yarn. Heavier colors seed groups first.
function groupColors(usage) {
    const total = usage.reduce((sum, item) => sum + item.count, 0);
    const colors = usage.map(item => ({
        ...item, lab: toOklab(item.color),
        weight: total ? 0.5 / usage.length + 0.5 * item.count / total : 1 / usage.length,
    })).sort((a, b) => b.weight - a.weight || (a.color < b.color ? -1 : 1));
    const groups = [];
    for (const color of colors) {
        const group = groups.find(g => Math.hypot(g.lab[0] - color.lab[0], g.lab[1] - color.lab[1], g.lab[2] - color.lab[2]) < SHARE_DISTANCE);
        if (group) group.members.push(color);
        else groups.push({ lab: color.lab, members: [color] });
    }
    return groups;
}

function scoreLine(groups, line) {
    const yarns = line.colors.length, count = groups.length, labs = line.labs;
    const distances = new Float64Array(count * yarns);
    for (let g = 0; g < count; g++) {
        const [l, a, b] = groups[g].lab;
        for (let y = 0; y < yarns; y++) {
            const dl = l - labs[y * 3], da = a - labs[y * 3 + 1], db = b - labs[y * 3 + 2];
            distances[g * yarns + y] = Math.sqrt(dl * dl + da * da + db * db);
        }
    }
    // Greedy one-to-one assignment: the closest remaining group/yarn pair is matched first.
    const assigned = new Int32Array(count).fill(-1), taken = new Uint8Array(yarns);
    for (let left = Math.min(count, yarns); left > 0; left--) {
        let best = Infinity, bestG = -1, bestY = -1;
        for (let g = 0; g < count; g++) {
            if (assigned[g] >= 0) continue;
            for (let y = 0, offset = g * yarns; y < yarns; y++) {
                if (!taken[y] && distances[offset + y] < best) { best = distances[offset + y]; bestG = g; bestY = y; }
            }
        }
        assigned[bestG] = bestY;
        taken[bestY] = 1;
    }
    const mapping = new Map();
    let score = 0, usable = 0;
    groups.forEach((group, g) => {
        for (const member of group.members) {
            if (assigned[g] < 0) {
                // More distinct colors than this line offers: fall back to the nearest yarn for display, scored 0.
                mapping.set(member.color, { yarn: findClosestColor(member.color, line.colors), score: 0, shared: true });
                continue;
            }
            const y = assigned[g];
            const distance = Math.hypot(member.lab[0] - line.labs[y * 3], member.lab[1] - line.labs[y * 3 + 1], member.lab[2] - line.labs[y * 3 + 2]);
            const value = matchScore(distance);
            mapping.set(member.color, { yarn: line.colors[y], score: value, shared: false });
            score += member.weight * value;
            if (value >= USABLE_SCORE) usable++;
        }
    });
    return { name: line.name, size: yarns, score, usable, total: mapping.size, needed: groups.length, mapping };
}

// Scores one prepared yarn line against the project's color usage.
export function matchYarnLine(usage, line) {
    if (!usage.length) return { name: line.name, size: line.colors.length, score: 0, usable: 0, total: 0, needed: 0, mapping: new Map() };
    return scoreLine(groupColors(usage), line);
}

// Ranks every yarn line; ties prefer more usable colors, then the larger line, then name order.
export function rankYarnLines(usage, lines, limit = 5) {
    if (!usage.length) return [];
    const groups = groupColors(usage);
    return lines.map(line => scoreLine(groups, line))
        .sort((a, b) => b.score - a.score || b.usable - a.usable || b.size - a.size || a.name.localeCompare(b.name))
        .slice(0, limit);
}

export const CUSTOM_MIX = 'Custom mix';

// The k nearest distinct yarn colors across every line, closest first. Ties keep catalog order.
function nearestYarns(lab, lines, k) {
    const best = [];
    for (const line of lines) {
        const labs = line.labs;
        for (let y = 0; y < line.colors.length; y++) {
            const dl = lab[0] - labs[y * 3], da = lab[1] - labs[y * 3 + 1], db = lab[2] - labs[y * 3 + 2];
            const distance = Math.sqrt(dl * dl + da * da + db * db);
            if (best.length === k && distance >= best[k - 1].distance) continue;
            const yarn = line.colors[y].toLowerCase();
            const same = best.findIndex(entry => entry.yarn === yarn);
            if (same >= 0) continue;
            let at = best.length;
            while (at > 0 && best[at - 1].distance > distance) at--;
            best.splice(at, 0, { yarn, line: line.name, distance });
            if (best.length > k) best.pop();
        }
    }
    return best;
}

// Nearest yarn to one color across all lines, with the line it comes from.
export function closestYarn(color, lines) {
    const [match] = nearestYarns(toOklab(color), lines, 1);
    if (!match) throw new Error('The yarn catalog has no colors.');
    return match;
}

// Builds a cross-brand palette: every project color gets the closest yarn from any line.
// Distinct color groups still get distinct yarns, using each group's nearest few candidates.
export function matchCustomMix(usage, lines, candidates = 8) {
    const mapping = new Map();
    if (!usage.length) return { name: CUSTOM_MIX, custom: true, size: 0, lines: 0, score: 0, usable: 0, total: 0, needed: 0, mapping };
    const groups = groupColors(usage);
    const options = groups.map(group => nearestYarns(group.lab, lines, candidates));
    const pairs = [];
    options.forEach((list, g) => list.forEach(option => pairs.push({ g, option })));
    pairs.sort((a, b) => a.option.distance - b.option.distance || a.g - b.g);
    const assigned = new Array(groups.length).fill(null), taken = new Set();
    for (const { g, option } of pairs) {
        if (assigned[g] || taken.has(option.yarn)) continue;
        assigned[g] = option;
        taken.add(option.yarn);
    }
    let score = 0, usable = 0;
    groups.forEach((group, g) => {
        // Only when every nearby candidate went to a heavier color does a group share its nearest yarn.
        const choice = assigned[g] || options[g][0];
        for (const member of group.members) {
            const [l, a, b] = toOklab(choice.yarn);
            const value = matchScore(Math.hypot(member.lab[0] - l, member.lab[1] - a, member.lab[2] - b));
            mapping.set(member.color, { yarn: choice.yarn, line: choice.line, score: value, shared: !assigned[g] });
            score += member.weight * value;
            if (value >= USABLE_SCORE) usable++;
        }
    });
    const used = [...mapping.values()];
    return {
        name: CUSTOM_MIX, custom: true, size: new Set(used.map(match => match.yarn)).size,
        lines: new Set(used.map(match => match.line)).size, score, usable, total: mapping.size, needed: groups.length, mapping,
    };
}
