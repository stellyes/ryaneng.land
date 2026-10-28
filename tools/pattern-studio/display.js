export const GRID_MIN_CELL_SIZE = 10;

export function showGrid(cols, rows, cssWidth, cssHeight, bitmapWidth, bitmapHeight) {
    return Math.min(cssWidth / cols, cssHeight / rows, bitmapWidth / cols, bitmapHeight / rows) >= GRID_MIN_CELL_SIZE;
}

export function createTransparencyPattern(context) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 16;
    const drawing = tile.getContext('2d');
    drawing.fillStyle = '#d6d6d6';
    drawing.fillRect(0, 0, 16, 16);
    drawing.fillStyle = '#aaaaaa';
    drawing.fillRect(0, 0, 8, 8);
    drawing.fillRect(8, 8, 8, 8);
    return context.createPattern(tile, 'repeat');
}
