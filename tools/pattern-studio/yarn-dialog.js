import { CUSTOM_MIX, matchYarnPalette, rankYarnLines } from './palette.js';

export function createYarnDialog({ loadLines, getUsage, getSelection = () => '', getAdditions = () => [],
    yarnOption, renderColors, confirm, report }) {
    const $ = id => document.getElementById(id);
    const dialog = $('yarn-dialog');
    let lines = [], usage = [], custom = null, selected = '', generation = 0;
    let additions = [];
    function result() {
        return selected === CUSTOM_MIX ? custom : selected ? matchYarnPalette(usage, lines, selected, additions) : null;
    }
    function details(list, match, lineName) {
        list.replaceChildren();
        const yarns = new Map();
        for (const value of match.mapping.values()) yarns.set(`${value.line || lineName}:${value.yarn}`, value);
        for (const value of yarns.values()) {
            const row = document.createElement('li'), chip = document.createElement('span');
            chip.className = 'yarn-chip'; chip.style.background = value.yarn;
            row.append(chip, `${value.line || lineName} \u00b7 ${value.yarn}`);
            list.append(row);
        }
    }
    function choose(name) {
        selected = name;
        $('yarn-line').value = name;
        dialog.querySelectorAll('.yarn-option').forEach(button =>
            button.setAttribute('aria-pressed', String(button.dataset.line === name)));
        $('yarn-original-select').setAttribute('aria-pressed', String(!name));
        const match = result();
        $('yarn-mapping-section').hidden = !match;
        $('yarn-selection').textContent = name === CUSTOM_MIX ? 'Custom Palette' : name || 'Original palette';
        renderColors($('yarn-mapping'), usage, match);
        $('yarn-product-details').replaceChildren();
        if (match && selected !== CUSTOM_MIX) details($('yarn-product-details'), match, selected);
        $('yarn-confirm').disabled = false;
    }
    async function open() {
        const token = ++generation;
        selected = ''; custom = null; lines = [];
        additions = getAdditions();
        usage = getUsage();
        renderColors($('yarn-original'), usage);
        for (const id of ['yarn-custom', 'yarn-custom-details', 'yarn-ranking', 'yarn-product-details', 'yarn-mapping']) $(id).replaceChildren();
        $('yarn-line').replaceChildren();
        $('yarn-line').disabled = true;
        $('yarn-mapping-section').hidden = true;
        $('yarn-original-select').setAttribute('aria-pressed', 'true');
        $('yarn-confirm').disabled = true;
        $('yarn-status').textContent = 'Loading the yarn catalog...';
        $('yarn-retry').hidden = true;
        if (!dialog.open) dialog.showModal();
        try {
            const loaded = await loadLines();
            if (token !== generation || !dialog.open) return;
            lines = loaded;
            custom = matchYarnPalette(usage, lines, CUSTOM_MIX, additions);
            $('yarn-line').append(...lines.map(line => new Option(`${line.name} (${line.colors.length} colors)`, line.name)));
            $('yarn-line').disabled = false;
            $('yarn-custom').append(yarnOption(custom, 'Mix',
                `${custom.usable} of ${custom.total} colors usable; ${custom.size} yarn colors across ${custom.lines} lines`, choose, selected));
            details($('yarn-custom-details'), custom);
            for (const [index, match] of rankYarnLines(usage, lines, 5, additions).entries()) {
                const row = document.createElement('li');
                row.append(yarnOption(match, index ? `#${index + 1}` : 'Best',
                    `${match.usable} of ${match.total} colors usable; ${match.size} colors in this product line`, choose, selected));
                $('yarn-ranking').append(row);
            }
            $('yarn-status').textContent = usage.length
                ? `Best matches from ${lines.length} product lines. Scores are out of 100.`
                : 'Add or paint colors to get yarn recommendations.';
            choose(getSelection());
        } catch (error) {
            if (token !== generation || !dialog.open) return;
            $('yarn-status').textContent = error.message;
            $('yarn-retry').hidden = false;
            report(error);
        }
    }
    $('yarn-toggle').addEventListener('click', open);
    $('yarn-line').addEventListener('change', () => choose($('yarn-line').value));
    $('yarn-original-select').addEventListener('click', () => choose(''));
    $('yarn-retry').addEventListener('click', open);
    $('yarn-cancel').addEventListener('click', () => dialog.close());
    dialog.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        dialog.close();
    });
    $('yarn-confirm').addEventListener('click', () => {
        try {
            confirm(result(), lines);
            dialog.close();
        } catch (error) {
            $('yarn-status').textContent = error.message;
            report(error);
        }
    });
    return { open };
}
