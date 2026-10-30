export const GRID_MIN_CELL_SIZE = 6;
export const MIN_ZOOM = 0.35, MAX_ZOOM = 8;

export function stepZoom(zoom, direction) {
    const step = direction > 0 ? Math.floor(zoom * 4 + 1e-8) + 1 : Math.ceil(zoom * 4 - 1e-8) - 1;
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, step / 4));
}

export function canvasLayout(project, viewportWidth, viewportHeight, padding, zoom, overscroll = true) {
    const fit = Math.min((viewportWidth - padding.x * 2) / project.width, (viewportHeight - padding.y * 2) / project.height);
    if (fit <= 0) return null;
    const width = Math.max(1, Math.floor(project.width * fit * zoom));
    const height = Math.max(1, Math.floor(project.height * fit * zoom));
    const padX = overscroll ? Math.max(padding.x, (viewportWidth - width / project.cols) / 2) : padding.x;
    const padY = overscroll ? Math.max(padding.y, (viewportHeight - height / project.rows) / 2) : padding.y;
    return { width, height, padX, padY,
        wrapWidth: Math.max(viewportWidth, width + padX * 2),
        wrapHeight: Math.max(viewportHeight, height + padY * 2) };
}

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
