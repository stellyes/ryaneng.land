export function createYarnColorDialog({ loadLines, getLine, add, report }) {
    const $ = id => document.getElementById(id);
    const dialog = $('yarn-color-dialog'), select = $('yarn-color-line');
    let lines = [], generation = 0;
    function render() {
        const line = lines.find(line => line.name === select.value);
        $('yarn-color-options').replaceChildren();
        if (!line) return;
        $('yarn-color-status').textContent = `${line.colors.length} yarn colors. Choose a shade to add it.`;
        for (const color of line.colors) {
            const button = document.createElement('button'), chip = document.createElement('span');
            button.type = 'button';
            button.setAttribute('aria-label', `Add ${line.name} ${color}`);
            chip.className = 'yarn-chip'; chip.style.background = color;
            button.append(chip, color);
            button.addEventListener('click', () => {
                try { add(color, line.name); dialog.close(); }
                catch (error) { $('yarn-color-status').textContent = error.message; report(error); }
            });
            $('yarn-color-options').append(button);
        }
    }
    async function open() {
        const token = ++generation;
        select.replaceChildren(); select.disabled = true;
        $('yarn-color-options').replaceChildren();
        $('yarn-color-status').textContent = 'Loading yarn colors...';
        $('yarn-color-retry').hidden = true;
        if (!dialog.open) dialog.showModal();
        try {
            const loaded = await loadLines();
            if (token !== generation || !dialog.open) return;
            lines = loaded;
            select.append(...lines.map(line => new Option(line.name, line.name)));
            if (lines.some(line => line.name === getLine())) select.value = getLine();
            select.disabled = false;
            render();
        } catch (error) {
            if (token !== generation || !dialog.open) return;
            $('yarn-color-status').textContent = error.message;
            $('yarn-color-retry').hidden = false;
            report(error);
        }
    }
    select.addEventListener('change', render);
    $('yarn-color-cancel').addEventListener('click', () => dialog.close());
    $('yarn-color-retry').addEventListener('click', open);
    dialog.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation(); dialog.close();
    });
    return { open };
}
