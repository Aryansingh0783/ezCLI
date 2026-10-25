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

/* ------------------------------------------------ search the sidebar */
const RailSearch = {
  row: null,
  input: null,
  mount() {
    const anchor = $('railNew');
    if (!anchor || this.row) return;
    const row = document.createElement('div');
    row.className = 'rail-search';
    row.innerHTML = `<button type="button" class="rail-search-btn" aria-label="Search sessions in this project">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.6-3.6"/></svg><span>Search</span></button>
      <input type="search" class="rail-search-in" placeholder="Search this project" aria-label="Search sessions in this project" autocomplete="off" spellcheck="false" hidden />`;
    anchor.after(row);
    this.row = row;
    this.input = row.querySelector('input');
    row.querySelector('button').addEventListener('click', () => this.open());
    this.input.addEventListener('input', () => {
      RailSessions.query = this.input.value;
      RailSessions.render();
    });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const first = $('railSessions').querySelector('.rail-session');
      if (e.key === 'Escape') this.close(true);
      else if (e.key === 'Enter' && first) first.click();
      else if (e.key === 'ArrowDown' && first) {
        e.preventDefault();
        first.focus();
      }
    });
    this.input.addEventListener('blur', () => {
      if (!this.input.value) this.close(false);
    });
  },
  open() {
    if (!this.row) return;
    if (document.documentElement.dataset.rail === 'collapsed') SideToggle.set(false);
    this.row.classList.add('open');
    this.input.hidden = false;
    this.input.focus();
  },
  close(clear) {
    if (!this.row) return;
    if (clear) {
      this.input.value = '';
      RailSessions.query = '';
      RailSessions.render();
    }
    this.row.classList.remove('open');
    this.input.hidden = true;
  }
};
hooks.boot.push(() => RailSearch.mount());

/* ------------------------------------------------ sessions that need you */
function jumpToUnread() {
  const list = spaceSessions().filter((s) => s.unseen && s.id !== state.activeId);
  if (!list.length) return toast('Nothing new in this project.');
  selectSession(list[0].id);
}
window.addEventListener(
  'keydown',
  (e) => {
    if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) return;
    if (e.code === 'KeyJ') {
      e.preventDefault();
      e.stopPropagation();
      jumpToUnread();
    } else if (e.code === 'KeyO' && document.documentElement.dataset.layout === 'calm') {
      e.preventDefault();
      e.stopPropagation();
      RailSearch.open();
    }
  },
  true
);
registerCommand({ group: 'Session', label: 'Jump to the next session with new output', keys: 'Ctrl Alt J', run: jumpToUnread });
registerCommand({ group: 'Session', label: 'Search sessions in this project', keys: 'Ctrl Alt O', run: () => RailSearch.open() });

/* ------------------------------------------------ the session title is a menu */
const HeadTitle = {
  mount() {
    const t = $('headTitle');
    if (!t || t.dataset.menu) return;
    t.dataset.menu = '1';
    t.tabIndex = 0;
    t.setAttribute('role', 'button');
    t.setAttribute('aria-haspopup', 'menu');
    t.title = 'Rename, duplicate or close this session';
    t.addEventListener('click', (e) => {
      if (e.target.closest('input')) return;
      this.open();
    });
    t.addEventListener('keydown', (e) => {
      if (e.target.closest('input')) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.open();
      } else if (e.key === 'F2') this.rename();
    });
  },
  open() {
    const s = active();
    const t = $('headTitle');
    if (!s || !t) return;
    const others = spaceSessions().filter((o) => o.id !== s.id);
    openMenu(t, {
      items: [
        { label: 'Rename', hint: 'F2', run: () => this.rename() },
        { label: 'Duplicate', run: () => createSession(s.agentId, { modelId: s.modelId, modeId: s.modeId, effortId: s.effortId, cwd: s.cwd }) },
        { label: 'Restart', run: () => restartSession(s) },
        { label: 'Copy folder path', run: () => copy(s.cwd) },
        ...tabMenuExtras(s),
        { sep: true },
        { label: 'Close', hint: 'Ctrl+Alt+W', run: () => closeSession(s.id) },
        {
          label: 'Close the others',
          disabled: !others.length,
          run: () => {
            others.forEach((o) => closeSession(o.id, { quiet: true }));
            toast(`Closed ${others.length} session${others.length === 1 ? '' : 's'}. Reopen them from the Closed tabs menu.`);
          }
        }
      ]
    });
  },
  rename() {
    const s = active();
    const t = $('headTitle');
    if (!s || !t) return;
    const input = document.createElement('input');
    input.className = 'head-rename';
    input.value = s.title;
    input.setAttribute('aria-label', 'Session name');
    t.textContent = '';
    t.append(input);
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
  }
};
hooks.boot.push(() => HeadTitle.mount());
