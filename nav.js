document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('nav-toggle');
  const list = document.getElementById('side-nav-list');

  if (!toggle || !list) return;

  toggle.addEventListener('click', () => {
    const isOpen = list.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });

  list.addEventListener('click', (event) => {
    if (event.target.tagName === 'A') {
      list.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
});
