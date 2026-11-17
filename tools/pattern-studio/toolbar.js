export function createToolToolbar(toolbar) {
    const tooltip = document.createElement('div');
    tooltip.id = 'toolbar-tooltip';
    tooltip.className = 'toolbar-tooltip';
    tooltip.popover = 'manual';
    tooltip.setAttribute('role', 'tooltip');
    toolbar.append(tooltip);

    function position(element, anchor) {
        const rect = anchor.getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        element.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - bounds.width - 8))}px`;
        element.style.top = `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - bounds.height - 8))}px`;
    }

    function hideTooltip() {
        tooltip.hidePopover();
    }

    function describe(anchor, text) {
        tooltip.textContent = text;
        tooltip.showPopover();
        position(tooltip, anchor);
    }

    const groups = [...toolbar.querySelectorAll('.tool-group')].map((group, index) => {
        const name = group.getAttribute('aria-label');
        const panel = document.createElement('div');
        panel.id = `toolbar-group-${index}`;
        panel.className = 'tool-dropdown';
        panel.popover = 'auto';
        panel.setAttribute('role', 'group');
        panel.setAttribute('aria-label', name);
        const buttons = [...group.querySelectorAll('button')];
        const descriptions = buttons.map(button => {
            const label = button.getAttribute('aria-label');
            const description = button.nextElementSibling.textContent;
            button.nextElementSibling.remove();
            button.removeAttribute('title');
            const text = document.createElement('span');
            const title = document.createElement('strong');
            title.textContent = label;
            const detail = document.createElement('small');
            detail.id = `toolbar-tool-${index}-${button.id || button.dataset.tool}`;
            detail.textContent = description;
            text.append(title, detail);
            button.append(text);
            button.setAttribute('aria-describedby', detail.id);
            button.addEventListener('mouseenter', () => describe(button, `${label}: ${description}`));
            button.addEventListener('focus', () => describe(button, `${label}: ${description}`));
            button.addEventListener('mouseleave', hideTooltip);
            button.addEventListener('blur', hideTooltip);
            return `${label}: ${description}`;
        });
        panel.append(...group.childNodes);
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'icon-button tool-group-trigger';
        trigger.setAttribute('aria-label', name);
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-controls', panel.id);
        trigger.setAttribute('popovertarget', panel.id);
        trigger.setAttribute('aria-describedby', tooltip.id);
        if (group.dataset.icon === 'svg') {
            const icon = document.createElement('span');
            icon.className = 'svg-tool-icon';
            icon.textContent = 'SVG';
            icon.setAttribute('aria-hidden', 'true');
            trigger.append(icon);
        } else trigger.append(buttons[0].querySelector('svg').cloneNode(true));
        group.append(trigger, panel);

        function close(restoreFocus = false) {
            panel.hidePopover();
            hideTooltip();
            if (restoreFocus) trigger.focus({ preventScroll: true });
        }

        trigger.addEventListener('click', hideTooltip);
        trigger.addEventListener('mouseenter', () => {
            if (!panel.matches(':popover-open')) describe(trigger, `${name}\n${descriptions.join('\n')}`);
        });
        trigger.addEventListener('focus', () => {
            if (!panel.matches(':popover-open')) describe(trigger, `${name}\n${descriptions.join('\n')}`);
        });
        trigger.addEventListener('mouseleave', hideTooltip);
        trigger.addEventListener('blur', hideTooltip);
        trigger.addEventListener('keydown', event => {
            if (event.key === 'Escape' && panel.matches(':popover-open')) {
                event.preventDefault();
                event.stopPropagation();
                close(true);
                return;
            }
            if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
            event.preventDefault();
            hideTooltip();
            if (!panel.matches(':popover-open')) trigger.click();
            position(panel, trigger);
            const enabled = buttons.filter(button => !button.disabled);
            (event.key === 'ArrowUp' ? enabled.at(-1) : enabled[0])?.focus();
        });
        panel.addEventListener('toggle', () => {
            const open = panel.matches(':popover-open');
            trigger.setAttribute('aria-expanded', String(open));
            if (open) position(panel, trigger);
            else hideTooltip();
        });
        panel.addEventListener('click', event => {
            const button = event.target.closest('button');
            if (button && !button.disabled) close(document.activeElement === button);
        });
        panel.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close(true);
                return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const enabled = buttons.filter(button => !button.disabled);
            const current = enabled.indexOf(document.activeElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 :
                (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
            enabled[next]?.focus();
        });
        panel.addEventListener('focusout', event => {
            if (!group.contains(event.relatedTarget)) close();
        });
        return { trigger, panel, buttons, close };
    });

    const closeAll = () => {
        for (const group of groups) group.close();
        hideTooltip();
    };
    toolbar.addEventListener('scroll', closeAll);
    window.addEventListener('resize', closeAll);

    return {
        update() {
            for (const { trigger, buttons, close } of groups) {
                trigger.disabled = buttons.every(button => button.disabled);
                const active = buttons.find(button => button.getAttribute('aria-pressed') === 'true');
                trigger.classList.toggle('active', Boolean(active));
                if (active && !trigger.querySelector('.svg-tool-icon')) {
                    trigger.replaceChildren(active.querySelector('svg').cloneNode(true));
                }
                if (trigger.disabled) close();
            }
        },
        destroy() {
            closeAll();
            toolbar.removeEventListener('scroll', closeAll);
            window.removeEventListener('resize', closeAll);
            tooltip.remove();
        }
    };
}
