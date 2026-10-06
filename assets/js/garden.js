(() => {
  const canvas = document.getElementById('garden-canvas');
  const resetButton = document.getElementById('garden-reset');
  const status = document.getElementById('garden-status');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    status.textContent = 'This browser cannot render the garden. Please try a browser with canvas support.';
    resetButton.disabled = true;
    return;
  }
  const settledCanvas = document.createElement('canvas');
  const settledCtx = settledCanvas.getContext('2d');
  if (!settledCtx) {
    status.textContent = 'This browser cannot render the garden. Please try a browser with canvas support.';
    resetButton.disabled = true;
    return;
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const MAX_MARKS = 24000;
  const MAX_TIPS = 140;
  const GROWTH_RATE = 1 / 5;
  const STEP_MS = 1000 / (30 * GROWTH_RATE);
  const colors = [95, 125, 155, 35, 275, 15];
  let width = 1;
  let height = 1;
  let tips = [];
  let marks = [];
  let pendingMarks = [];
  let pointer = null;
  let visible = false;
  let frame = null;
  let lastTime = 0;
  let elapsed = 0;
  let burstSteps = 0;

  function paint(mark, context, progress = 1) {
    const ctx = context;
    ctx.strokeStyle = mark.color;
    ctx.fillStyle = mark.color;
    if (mark.kind === 'stem') {
      ctx.lineWidth = mark.size;
      ctx.beginPath();
      ctx.moveTo(mark.x * width, mark.y * height);
      ctx.lineTo((mark.x + (mark.ex - mark.x) * progress) * width,
        (mark.y + (mark.ey - mark.y) * progress) * height);
      ctx.stroke();
    } else {
      ctx.globalAlpha = progress;
      ctx.beginPath();
      ctx.ellipse(mark.x * width, mark.y * height, mark.size,
        mark.kind === 'leaf' ? mark.size * 0.35 : mark.size,
        mark.angle, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function settle() {
    for (const mark of pendingMarks) paint(mark, settledCtx);
    pendingMarks = [];
  }

  function render(progress = 1) {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(settledCanvas, 0, 0, width, height);
    if (progress > 0) {
      for (const mark of pendingMarks) paint(mark, ctx, progress);
    }
  }

  function addMark(mark) {
    if (marks.length >= MAX_MARKS) return;
    marks.push(mark);
    pendingMarks.push(mark);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    settledCanvas.width = canvas.width;
    settledCanvas.height = canvas.height;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    settledCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineCap = 'round';
    settledCtx.lineCap = 'round';
    const settledCount = marks.length - pendingMarks.length;
    for (let i = 0; i < settledCount; i++) paint(marks[i], settledCtx);
    render(elapsed / STEP_MS);
  }

  function grow() {
    if (marks.length >= MAX_MARKS) return;
    const offspring = [];
    for (const tip of tips) {
      const distance = pointer
        ? Math.hypot((pointer.x - tip.x) * width, (pointer.y - tip.y) * height)
        : Infinity;
      const energy = Math.max(0, 1 - distance / 240);
      const length = (2 + Math.random() * 3) * (1 + energy * 2.5) / 3;
      let angle = tip.angle + (Math.random() - 0.5) * (0.45 + energy * 0.35);
      if (energy > 0 && distance > 12) {
        const target = Math.atan2((pointer.y - tip.y) * height, (pointer.x - tip.x) * width);
        angle += Math.atan2(Math.sin(target - angle), Math.cos(target - angle)) * energy * 0.22;
      }
      let ex = tip.x + Math.cos(angle) * length / width;
      let ey = tip.y + Math.sin(angle) * length / height;
      if (ex < 0 || ex > 1) {
        angle = Math.PI - angle;
        ex = Math.max(0, Math.min(1, ex));
      }
      if (ey < 0 || ey > 1) {
        angle = -angle;
        ey = Math.max(0, Math.min(1, ey));
      }
      addMark({
        kind: 'stem', x: tip.x, y: tip.y, ex, ey,
        size: Math.max(0.65, tip.size),
        color: `hsla(${tip.hue}, 48%, ${42 + energy * 18}%, 0.85)`
      });
      tip.x = ex;
      tip.y = ey;
      tip.angle = angle;
      tip.age++;
      tip.size *= 0.996;

      if (tip.age > 8 && Math.random() < 0.16 + energy * 0.18) {
        addMark({
          kind: 'leaf', x: ex, y: ey, size: 3 + Math.random() * 7,
          angle: angle + (Math.random() < 0.5 ? -0.8 : 0.8),
          color: `hsla(${tip.hue}, 55%, 58%, 0.75)`
        });
      }
      if (tip.age > 25 && Math.random() < 0.018 + energy * 0.025) {
        addMark({
          kind: 'bloom', x: ex, y: ey, size: 3 + Math.random() * 5, angle: 0,
          color: `hsla(${colors[Math.floor(Math.random() * colors.length)]}, 75%, 72%, 0.9)`
        });
      }
      if (tips.length + offspring.length < MAX_TIPS && tip.age > 10 &&
          Math.random() < 0.018 + energy * 0.08) {
        offspring.push({
          ...tip, angle: angle + (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.7),
          size: tip.size * 0.75, age: 0
        });
      }
    }
    tips.push(...offspring);
    if (marks.length >= MAX_MARKS) {
      status.textContent = 'Fully overgrown. Reset the garden to plant something new.';
    }
  }

  function animate(time) {
    frame = null;
    elapsed += lastTime ? Math.min(time - lastTime, STEP_MS * 2) : STEP_MS;
    lastTime = time;
    while (elapsed >= STEP_MS) {
      settle();
      grow();
      elapsed -= STEP_MS;
    }
    render(elapsed / STEP_MS);
    start();
  }

  function start() {
    if (frame === null && visible && !document.hidden && !reducedMotion.matches &&
        (marks.length < MAX_MARKS || pendingMarks.length > 0)) {
      frame = requestAnimationFrame(animate);
    }
  }

  function stop() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    settle();
    render();
    lastTime = 0;
    elapsed = 0;
  }

  function reset() {
    stop();
    pointer = null;
    burstSteps = 0;
    marks = [];
    pendingMarks = [];
    tips = [];
    ctx.clearRect(0, 0, width, height);
    settledCtx.clearRect(0, 0, width, height);
    const count = 3 + Math.floor(Math.random() * 5);
    for (let i = 0; i < count; i++) {
      const tip = {
        x: Math.random(),
        y: Math.random(),
        angle: -Math.PI / 2 + (Math.random() - 0.5) * 0.9,
        size: 2 + Math.random() * 2,
        hue: colors[Math.floor(Math.random() * colors.length)], age: 0
      };
      tips.push(tip);
      addMark({
        kind: 'seed', x: tip.x, y: tip.y, size: 3, angle: 0,
        color: `hsl(${tip.hue}, 55%, 65%)`
      });
    }
    settle();
    render();
    status.textContent = reducedMotion.matches
      ? 'Garden planted. Reduced motion is on: move, touch, or use Space to grow in bursts.'
      : 'Garden planted. Move through it to make it grow wild.';
    start();
  }

  function burst(steps) {
    settle();
    burstSteps += steps;
    while (burstSteps >= 1 / GROWTH_RATE) {
      grow();
      burstSteps -= 1 / GROWTH_RATE;
    }
    settle();
    render();
  }

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer = { x: (event.clientX - rect.left) / width, y: (event.clientY - rect.top) / height };
    if (reducedMotion.matches) burst(2);
  });
  canvas.addEventListener('pointerdown', (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer = { x: (event.clientX - rect.left) / width, y: (event.clientY - rect.top) / height };
    burst(8);
  });
  for (const event of ['pointerleave', 'pointercancel', 'blur']) {
    canvas.addEventListener(event, () => { pointer = null; });
  }
  canvas.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'mouse') pointer = null;
  });
  canvas.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) return;
    event.preventDefault();
    if (!pointer) pointer = { x: 0.5, y: 0.65 };
    const dx = event.key === 'ArrowRight' ? 0.06 : event.key === 'ArrowLeft' ? -0.06 : 0;
    const dy = event.key === 'ArrowDown' ? 0.06 : event.key === 'ArrowUp' ? -0.06 : 0;
    pointer.x = Math.max(0, Math.min(1, pointer.x + dx));
    pointer.y = Math.max(0, Math.min(1, pointer.y + dy));
    burst(event.key === ' ' ? 24 : 8);
  });
  resetButton.addEventListener('click', reset);
  reducedMotion.addEventListener('change', () => {
    stop();
    status.textContent = marks.length >= MAX_MARKS
      ? 'Fully overgrown. Reset the garden to plant something new.'
      : reducedMotion.matches
        ? 'Reduced motion is on: move, touch, or use Space to grow in bursts.'
        : 'Move through the garden to make it grow wild.';
    start();
  });
  document.addEventListener('visibilitychange', () => {
    stop();
    start();
  });
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    stop();
    start();
  }).observe(canvas);
  new ResizeObserver(resize).observe(canvas);
  window.addEventListener('resize', resize);
  resize();
  reset();
})();
