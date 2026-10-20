export const CROP_RATIOS = { square: [1, 1], photo: [3, 2], standard: [4, 3], wide: [16, 9] };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function fitCrop(width, height, ratio, scale = 1) {
    let cropWidth = width, cropHeight = height;
    if (ratio) {
        const units = Math.floor(Math.min(width / ratio[0], height / ratio[1]));
        if (units < 1) throw new Error('This reference is too small for that exact crop ratio.');
        const size = clamp(Math.floor(units * scale), 1, units);
        cropWidth = size * ratio[0];
        cropHeight = size * ratio[1];
    } else {
        cropWidth = Math.max(1, Math.floor(width * scale));
        cropHeight = Math.max(1, Math.floor(height * scale));
    }
    return { x: Math.floor((width - cropWidth) / 2), y: Math.floor((height - cropHeight) / 2), width: cropWidth, height: cropHeight };
}

export function moveCrop(rect, dx, dy, width, height) {
    return { ...rect, x: clamp(Math.round(rect.x + dx), 0, width - rect.width), y: clamp(Math.round(rect.y + dy), 0, height - rect.height) };
}

export function resizeCrop(rect, corner, dx, dy, width, height, ratio) {
    const west = corner.includes('w'), north = corner.includes('n');
    const anchorX = west ? rect.x + rect.width : rect.x;
    const anchorY = north ? rect.y + rect.height : rect.y;
    const maxWidth = west ? anchorX : width - anchorX;
    const maxHeight = north ? anchorY : height - anchorY;
    let nextWidth = clamp(Math.round(rect.width + (west ? -dx : dx)), 1, maxWidth);
    let nextHeight = clamp(Math.round(rect.height + (north ? -dy : dy)), 1, maxHeight);
    if (ratio) {
        const widthUnits = (rect.width + (west ? -dx : dx)) / ratio[0];
        const heightUnits = (rect.height + (north ? -dy : dy)) / ratio[1];
        const desired = Math.abs(dx) >= Math.abs(dy) ? widthUnits : heightUnits;
        const units = clamp(Math.round(desired), 1, Math.floor(Math.min(maxWidth / ratio[0], maxHeight / ratio[1])));
        nextWidth = units * ratio[0];
        nextHeight = units * ratio[1];
    }
    return { x: west ? anchorX - nextWidth : anchorX, y: north ? anchorY - nextHeight : anchorY, width: nextWidth, height: nextHeight };
}
