'use strict';
/* Drag the project buttons in the left rail to reorder them. Built on pointer
 * events: Tauri keeps native drag-and-drop for file drops, so the browser's
 * own drag API does not fire in this window. A press that moves less than a
 * few pixels is still an ordinary click. */

hooks.boot.push(() => {
  const rail = $('spaces');
  if (!rail) return;
  const THRESHOLD = 6;
  let drag = null;
  let suppressClick = false;

  const buttons = () => [...rail.querySelectorAll('.space')];

  function indexAt(y) {
    const list = buttons().filter((b) => b !== drag.el);
    let i = 0;
    for (const b of list) {
      const r = b.getBoundingClientRect();
      if (y > r.top + r.height / 2) i++;
    }
    return i;
  }

  function finish(commit) {
    if (!drag) return;
    const { el, id, started, to } = drag;
    el.classList.remove('dragging');
    el.style.transform = '';
    rail.classList.remove('reordering');
    buttons().forEach((b) => b.classList.remove('shift-up', 'shift-down'));
    drag = null;
    if (!started) return;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    if (!commit) return;
    const from = prefs.spaces.findIndex((s) => s.id === id);
    if (from === -1 || to === from) return;
    const [moved] = prefs.spaces.splice(from, 1);
    prefs.spaces.splice(to, 0, moved);
    savePrefs();
    renderSpaces();
  }

  rail.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.space');
    if (!el || e.button !== 0) return;
    drag = { el, id: el.dataset.space, startY: e.clientY, started: false, to: prefs.spaces.findIndex((s) => s.id === el.dataset.space) };
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (!drag.started) {
      if (Math.abs(dy) < THRESHOLD) return;
      drag.started = true;
      drag.el.classList.add('dragging');
      rail.classList.add('reordering');
    }
    drag.el.style.transform = `translateY(${dy}px)`;
    drag.to = indexAt(drag.el.getBoundingClientRect().top + drag.el.getBoundingClientRect().height / 2);
    const from = prefs.spaces.findIndex((s) => s.id === drag.id);
    buttons().forEach((b, i) => {
      b.classList.toggle('shift-up', b !== drag.el && i > from && i <= drag.to);
      b.classList.toggle('shift-down', b !== drag.el && i < from && i >= drag.to);
    });
  });

  window.addEventListener('pointerup', () => finish(true));
  window.addEventListener('pointercancel', () => finish(false));
  window.addEventListener('keydown', (e) => e.key === 'Escape' && drag && finish(false));

  // The click that ends a drag must not also switch project.
  rail.addEventListener(
    'click',
    (e) => {
      if (suppressClick) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true
  );
});
