'use strict';
/* Interactions for the calm layout: collapse the sidebar, rename a session in place, a preview
 * card when you hover a session, arrow-key movement through the sidebar, and a short fade when
 * the view changes. Everything here is optional polish; the app works without it. */

/* ------------------------------------------------------- collapsible sidebar */
const SideToggle = {
  mount() {
    if ($('sideToggle')) return;
    const brand = $('brandBtn');
    if (!brand) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'sideToggle';
    b.className = 'side-toggle';
    b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9.5 4.5v15"/></svg>';
    b.addEventListener('click', () => this.set(!prefs.railCollapsed));
    brand.after(b);
    this.apply();
  },
  set(on) {
    prefs.railCollapsed = Boolean(on);
    savePrefs();
    this.apply();
    setTimeout(() => typeof fitActive === 'function' && fitActive(), 280);
  },
  apply() {
    const on = Boolean(prefs.railCollapsed);
    document.documentElement.dataset.rail = on ? 'collapsed' : 'open';
    const b = $('sideToggle');
    if (b) {
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? 'Show sidebar (Ctrl+Alt+S)' : 'Hide sidebar (Ctrl+Alt+S)';
      b.setAttribute('aria-label', b.title);
    }
  }
};

/* ------------------------------------------------------------ inline rename */
function renameInSidebar(row) {
  const s = state.sessions.find((x) => x.id === row.dataset.railSession);
  const el = row.querySelector('.rail-session-title');
  if (!s || !el) return;
  const input = document.createElement('input');
  input.className = 'rail-rename';
  input.value = s.title;
  input.setAttribute('aria-label', 'Session name');
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit && input.value.trim()) s.title = input.value.trim().slice(0, 80);
    renderTabs();
    renderHead();
    RailSessions.render();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true), { once: true });
  input.addEventListener('click', (e) => e.stopPropagation());
}

/* ------------------------------------------------------------ hover preview */
const HoverCard = {
  el: null,
  timer: null,
  show(row) {
    const s = state.sessions.find((x) => x.id === row.dataset.railSession);
    if (!s) return;
    const a = agent(s.agentId) || {};
    const lines = (typeof terminalText === 'function' ? terminalText(s) : '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-4);
    const mins = Math.max(0, Math.round((Date.now() - (s.startedAt || Date.now())) / 60000));
    const status = s.status === 'running' ? (s.working ? 'Working' : 'Idle') : s.status === 'parked' ? 'Saved' : 'Stopped';
    this.hide();
    const c = document.createElement('div');
    c.className = 'hover-card';
    c.innerHTML = `<div class="hc-top"><b>${esc(s.title)}</b><span>${esc(status)}</span></div>
      <div class="hc-sub">${esc(a.label || s.agentId)}${s.modelId ? ' · ' + esc(modelLabel(a, s.modelId) || '') : ''} · open ${mins < 1 ? 'just now' : mins + ' min'}</div>
      ${lines.length ? `<pre class="hc-out">${lines.map((l) => esc(l.slice(0, 90))).join('\n')}</pre>` : ''}`;
    document.body.append(c);
    const r = row.getBoundingClientRect();
    c.style.left = `${r.right + 10}px`;
    c.style.top = `${Math.max(8, Math.min(innerHeight - c.offsetHeight - 8, r.top - 6))}px`;
    this.el = c;
  },
  hide() {
    clearTimeout(this.timer);
    if (this.el) this.el.remove();
    this.el = null;
  }
};

/* --------------------------------------------------------------- wiring */
hooks.boot.push(() => {
  SideToggle.mount();
  const box = $('railSessions');
  if (box) {
    box.addEventListener('dblclick', (e) => {
      const row = e.target.closest('[data-rail-session]');
      if (row && e.target.closest('.rail-session-title')) {
        HoverCard.hide();
        renameInSidebar(row);
      }
    });
    box.addEventListener('mouseover', (e) => {
      const row = e.target.closest('[data-rail-session]');
      if (!row || (e.relatedTarget && row.contains(e.relatedTarget))) return;
      HoverCard.hide();
      HoverCard.timer = setTimeout(() => HoverCard.show(row), 520);
    });
    box.addEventListener('mouseout', (e) => {
      const row = e.target.closest('[data-rail-session]');
      if (row && !(e.relatedTarget && row.contains(e.relatedTarget))) HoverCard.hide();
    });
    box.addEventListener('mousedown', () => HoverCard.hide());
    box.addEventListener('scroll', () => HoverCard.hide(), { passive: true });
    // arrow keys move through every row; Enter opens, F2 renames, Delete closes
    box.addEventListener('keydown', (e) => {
      const rows = [...box.querySelectorAll('.rail-session')];
      const i = rows.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!rows.length) return;
        e.preventDefault();
        const next = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        rows[next].focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        if (!rows.length) return;
        e.preventDefault();
        rows[e.key === 'Home' ? 0 : rows.length - 1].focus();
      } else if (i >= 0 && e.target === rows[i]) {
        const row = rows[i];
        if (e.key === 'Enter' && row.dataset.railSaved) Sessions.resumeSaved(row.dataset.railSaved);
        else if (e.key === 'F2' && row.dataset.railSession) renameInSidebar(row);
        else if (e.key === 'Delete' && row.dataset.railSession) closeSession(row.dataset.railSession);
      }
    });
  }
  // Ctrl+Alt+S, caught before the terminal can swallow it
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.code === 'KeyS') {
        e.preventDefault();
        e.stopPropagation();
        SideToggle.set(!prefs.railCollapsed);
      }
    },
    true
  );
});

// a short fade whenever the main view changes, so switching sessions never snaps
hooks.view.push(() => {
  const main = document.querySelector('.main');
  if (!main) return;
  main.classList.remove('view-in');
  void main.offsetWidth;
  main.classList.add('view-in');
  HoverCard.hide();
});

registerCommand({ group: 'App', label: 'Toggle sidebar', keys: 'Ctrl Alt S', run: () => SideToggle.set(!prefs.railCollapsed) });

/* A list that scrolls fades its edge instead of cutting a row in half. */
function markListEdges() {
  const box = $('railSessions');
  if (!box) return;
  const more = box.scrollHeight - box.clientHeight - box.scrollTop > 4;
  box.classList.toggle('fade-b', more);
  box.classList.toggle('fade-t', box.scrollTop > 4);
}
hooks.boot.push(() => {
  const box = $('railSessions');
  if (!box) return;
  box.addEventListener('scroll', markListEdges, { passive: true });
  new MutationObserver(markListEdges).observe(box, { childList: true });
  new ResizeObserver(markListEdges).observe(box);
  markListEdges();
});
