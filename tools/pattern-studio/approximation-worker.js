import { approximateGrid } from './approximation.js';

self.addEventListener('message', ({ data }) => {
    try {
        self.postMessage({ result: approximateGrid(data) });
    } catch (error) {
        self.postMessage({ error: error.message });
    }
});
