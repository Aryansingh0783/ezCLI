'use strict';
/* Calm layout: the sidebar lists the active project's sessions, the way the
 * Claude desktop app lists recent chats. Only shown in the wide, calm sidebar. */

const dotsHtml = '<span class="cdots" aria-hidden="true"><i></i><i></i><i></i></span>';

const RailSessions = {
  box: null,

  mount() {
    const spaces = $('spaces');
    if (!spaces || this.box) return;
    this.box = document.createElement('div');
    this.box.id = 'railSessions';
    this.box.className = 'rail-sessions';
    this.box.setAttribute('aria-label', 'Sessions in this project');
    spaces.after(this.box);
    this.box.addEventListener('click', (e) => {
      const star = e.target.closest('[data-rail-star]');
      if (star) {
        e.stopPropagation();
        Sessions.togglePin(star.dataset.railStar);
        return this.render();
      }
      const saved = e.target.closest('[data-rail-saved]');
      if (saved) return Sessions.resumeSaved(saved.dataset.railSaved);
      const x = e.target.closest('[data-rail-close]');
      if (x) return closeSession(x.dataset.railClose);
      const row = e.target.closest('[data-rail-session]');
      if (row) selectSession(row.dataset.railSession);
    });
  },

  render() {
    if (!this.box) return;
    const list = spaceSessions().slice().reverse().slice(0, 12);
    const earlier = this.earlier(list);
    this.box.hidden = list.length === 0 && earlier.length === 0;
    this.box.textContent = '';
    if (this.box.hidden) return;
    if (list.length) {
      const head = document.createElement('div');
      head.className = 'rail-sessions-head';
      head.textContent = 'Sessions';
      this.box.append(head);
    }
    for (const s of list) {
      const row = document.createElement('div');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.className = 'rail-session' + (s.id === state.activeId ? ' active' : '');
      row.dataset.railSession = s.id;
      const dot = sessionDot(s);
      const d = document.createElement('span');
      if (dot === 'working') {
        d.innerHTML = dotsHtml;
        d.className = 'rail-working';
      } else {
        d.className = 'status-dot' + (dot ? ' ' + dot : '');
      }
      const t = document.createElement('span');
      t.className = 'rail-session-title';
      t.textContent = s.title || 'Untitled';
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'rail-session-x';
      x.dataset.railClose = s.id;
      x.setAttribute('aria-label', 'Close session');
      x.textContent = '×';
      row.append(d, t, x);
      this.box.append(row);
    }
    if (earlier.length) {
      const head = document.createElement('div');
      head.className = 'rail-sessions-head';
      head.textContent = 'Earlier';
      this.box.append(head);
      const pinned = new Set(prefs.pinnedSessions || []);
      for (const m of earlier) {
        const row = document.createElement('div');
        row.className = 'rail-session rail-saved';
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.dataset.railSaved = m.id;
        row.title = `${m.agentLabel || m.agentId || ''} · resume`;
        const star = document.createElement('button');
        star.type = 'button';
        star.className = 'rail-star' + (pinned.has(m.id) ? ' on' : '');
        star.dataset.railStar = m.id;
        star.setAttribute('aria-pressed', String(pinned.has(m.id)));
        star.setAttribute('aria-label', pinned.has(m.id) ? 'Unstar' : 'Star');
        star.textContent = pinned.has(m.id) ? '★' : '☆';
        const t = document.createElement('span');
        t.className = 'rail-session-title';
        t.textContent = m.title;
        row.append(star, t);
        this.box.append(row);
      }
    }
  },

  /** Saved sessions from this project that are not already open, starred ones first. */
  earlier(live) {
    if (typeof Sessions === 'undefined' || !Sessions.recentSaved) return [];
    const sp = space();
    if (!sp) return [];
    const root = sp.path.toLowerCase().replace(/[\/]+$/, '');
    const open = new Set(live.map((s) => (s.title || '').toLowerCase()));
    const pinned = new Set(prefs.pinnedSessions || []);
    const here = Sessions.recentSaved().filter((m) => m.title && m.cwd && m.cwd.toLowerCase().replace(/[\/]+$/, '').startsWith(root) && !open.has(m.title.toLowerCase()));
    const seen = new Set();
    const uniq = here.filter((m) => (seen.has(m.title) ? false : seen.add(m.title)));
    return [...uniq.filter((m) => pinned.has(m.id)), ...uniq.filter((m) => !pinned.has(m.id))].slice(0, 6);
  }
};

/* "New session": the sidebar's first row, like "New chat" in the Claude desktop app. */
function mountNewSessionRow() {
  const rail = document.querySelector('.rail');
  if (!rail || $('railNew')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.id = 'railNew';
  b.className = 'rail-new';
  b.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg><span>New session</span>';
  b.addEventListener('click', () => newSession());
  rail.prepend(b);
}

hooks.boot.push(() => {
  mountNewSessionRow();
  RailSessions.mount();
  RailSessions.box.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('[data-rail-session]');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      selectSession(row.dataset.railSession);
    }
  });
  RailSessions.render();
});
hooks.tabs.push(() => RailSessions.render());
hooks.view.push(() => RailSessions.render());

/* Right-click a sidebar session for the same menu the tabs have (rename, duplicate, close...). */
hooks.boot.push(() => {
  RailSessions.box.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[data-rail-session]');
    const s = row && state.sessions.find((x) => x.id === row.dataset.railSession);
    if (!s) return;
    e.preventDefault();
    tabMenu(row, s, e.clientX, e.clientY);
  });
});

/* Project instructions: the CLAUDE.md / AGENTS.md / GEMINI.md the agent reads from the
 * project folder, editable in one place like a Claude project's custom instructions. */
const ProjectInstructions = {
  dlg: null,
  file: 'CLAUDE.md',

  fileFor() {
    const a = agent(state.activeId ? (active() || {}).agentId : prefs.agentId);
    const id = String((a && (a.mcp && a.mcp !== 'none' ? a.mcp : a.command)) || a?.id || '').toLowerCase();
    if (id.includes('claude')) return 'CLAUDE.md';
    if (id.includes('gemini') || id.includes('antigravity')) return 'GEMINI.md';
    return 'AGENTS.md';
  },

  build() {
    if (this.dlg) return;
    const d = document.createElement('dialog');
    d.className = 'sheet instructions-sheet';
    d.innerHTML = `<h2>Project instructions</h2>
      <p class="muted" id="piHint"></p>
      <textarea id="piText" rows="14" spellcheck="false" aria-label="Project instructions"></textarea>
      <div class="sheet-actions"><span class="grow"></span>
        <button class="btn quiet" id="piCancel">Cancel</button>
        <button class="btn primary" id="piSave">Save</button></div>`;
    document.body.append(d);
    d.querySelector('#piCancel').addEventListener('click', () => d.close());
    d.querySelector('#piSave').addEventListener('click', () => this.save());
    this.dlg = d;
  },

  async open() {
    const sp = space();
    if (!sp) return toast('Open a folder first.', 'error');
    this.build();
    this.file = this.fileFor();
    const path = `${sp.path.replace(/[\/]+$/, '')}/${this.file}`;
    this.path = path;
    let text = '';
    try {
      text = (await invoke('read_file', { path })).text || '';
    } catch {
      /* no file yet: saving creates it */
    }
    this.dlg.querySelector('#piHint').textContent = `Saved to ${this.file} in ${sp.name}. ${agent(prefs.agentId)?.label || 'The agent'} reads it at the start of every session.`;
    this.dlg.querySelector('#piText').value = text;
    this.dlg.showModal();
    this.dlg.querySelector('#piText').focus();
  },

  async save() {
    try {
      await invoke('write_text_file', { path: this.path, contents: this.dlg.querySelector('#piText').value });
      this.dlg.close();
      toast(`Saved ${this.file}`);
    } catch (err) {
      toast(`Couldn’t save: ${err}`, 'error');
    }
  }
};

registerCommand({ group: 'Workspace', label: 'Project instructions…', hint: 'edit CLAUDE.md / AGENTS.md', run: () => ProjectInstructions.open() });

hooks.boot.push(() => {
  const brain = $('brainBtn');
  if (!brain) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'rail-btn rail-instr';
  b.title = 'Edit the project instructions the agent reads';
  b.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 3h9l4 4v14H6z" /><path d="M9 12h7M9 16h7M9 8h3" /></svg><span class="rail-label">Instructions</span>';
  b.addEventListener('click', () => ProjectInstructions.open());
  brain.before(b);
});

/* ---------------------------------------------------------------- 4.0 */

/* Session composer footer, laid out like the Claude desktop composer: the mode on the left,
 * the model and effort on the right (then the usage ring and send). Works for every agent: a
 * model left at its default shows the agent's name, and the effort is left out when the agent
 * has none. Click the mode to restart in another mode, or the model to pick a different one. */
const ComposerMeta = {
  el: null,
  mode: null,
  mount() {
    const row = document.querySelector('#ptyComposer .composer-row');
    if (!row || this.el) return;
    const m = document.createElement('button');
    m.type = 'button';
    m.id = 'ptyMode';
    m.className = 'composer-mode';
    m.hidden = true;
    m.addEventListener('click', () => this.modeMenu(m));
    const plus = row.querySelector('.plus-btn');
    if (plus) plus.after(m);
    else row.prepend(m);
    this.mode = m;
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'ptyMeta';
    b.className = 'composer-meta';
    b.addEventListener('click', () => {
      const h = $('headModel');
      if (h && !h.hidden) h.click();
    });
    const send = row.querySelector('.send-btn') || row.lastElementChild;
    row.insertBefore(b, send);
    this.el = b;
  },
  modeMenu(anchor) {
    const s = active();
    const a = s && agent(s.agentId);
    if (!a || (a.modes || []).length < 2) return;
    openMenu(anchor, {
      title: `${a.label} · Mode`,
      items: a.modes.map((md) => ({
        label: md.label,
        hint: md.id === s.modeId ? '' : 'restarts this session',
        on: md.id === s.modeId,
        run: () => {
          if (md.id === s.modeId) return;
          s.modeId = md.id;
          restartSession(s);
        }
      }))
    });
  },
  render() {
    if (!this.el) return;
    const s = active();
    const a = s && agent(s.agentId);
    if (!a) {
      this.el.hidden = true;
      this.mode.hidden = true;
      return;
    }
    // "Default" says nothing the agent's name does not; show only real choices.
    const real = (v) => (v && !/(^|\s)default$/i.test(String(v).trim()) ? v : '');
    const model = real(modelLabel(a, s.modelId)) || a.label;
    const effort = (a.efforts || []).length > 1 ? real(effortLabel(a, s.effortId)) : '';
    this.el.hidden = false;
    this.el.innerHTML = `<span class="meta-model">${esc(model)}</span>${effort ? `<span class="meta-effort">${esc(effort)}</span>` : ''}`;
    const canPick = Boolean($('headModel') && !$('headModel').hidden);
    this.el.disabled = !canPick;
    this.el.title = canPick ? 'Change the model (starts a fresh session)' : `${a.label}${model !== a.label ? ' · ' + model : ''}`;
    const modes = a.modes || [];
    if (modes.length) {
      const modeName = label(modes, s.modeId);
      this.mode.hidden = false;
      this.mode.textContent = modeName;
      this.mode.disabled = modes.length < 2;
      this.mode.title = modes.length < 2 ? `${a.label} has one mode` : 'Change the mode (restarts this session)';
    } else {
      this.mode.hidden = true;
    }
  }
};
hooks.boot.push(() => {
  ComposerMeta.mount();
  ComposerMeta.render();
});
hooks.view.push(() => ComposerMeta.render());
hooks.tabs.push(() => ComposerMeta.render());

/* Settings: a section list on the left, like a desktop app's preferences window. */
const SettingsNav = {
  build() {
    const sheet = $('settingsSheet');
    if (!sheet) return;
    let layout = sheet.querySelector('.settings-layout');
    if (!layout) {
      layout = document.createElement('div');
      layout.className = 'settings-layout';
      const nav = document.createElement('nav');
      nav.className = 'settings-nav';
      nav.setAttribute('aria-label', 'Settings sections');
      const body = document.createElement('div');
      body.className = 'settings-body';
      layout.append(nav, body);
      const form = sheet.querySelector(':scope > form');
      sheet.insertBefore(layout, form || null);
      nav.addEventListener('click', (e) => {
        const b = e.target.closest('[data-sec]');
        if (!b) return;
        const sec = body.querySelectorAll('.settings-section')[Number(b.dataset.sec)];
        if (sec) body.scrollTo({ top: sec.offsetTop - body.offsetTop - 4, behavior: 'smooth' });
      });
      body.addEventListener('scroll', () => this.mark(), { passive: true });
    }
    const body = layout.querySelector('.settings-body');
    sheet.querySelectorAll(':scope > .settings-section').forEach((s) => body.append(s));
    const nav = layout.querySelector('.settings-nav');
    nav.innerHTML = [...body.querySelectorAll('.settings-section')]
      .map((s, i) => `<button type="button" data-sec="${i}">${esc((s.querySelector('h3') || {}).textContent || 'Section')}</button>`)
      .join('');
    this.mark();
  },
  mark() {
    const body = document.querySelector('#settingsSheet .settings-body');
    if (!body) return;
    const secs = [...body.querySelectorAll('.settings-section')];
    let cur = 0;
    secs.forEach((s, i) => {
      if (s.offsetTop - body.offsetTop - body.scrollTop <= 40) cur = i;
    });
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) cur = secs.length - 1;
    document.querySelectorAll('#settingsSheet .settings-nav [data-sec]').forEach((b, i) => b.classList.toggle('on', i === cur));
  }
};
hooks.boot.push(() => {
  const sheet = $('settingsSheet');
  if (!sheet) return;
  SettingsNav.build();
  new MutationObserver(() => {
    if (sheet.open) SettingsNav.build();
  }).observe(sheet, { attributes: true, attributeFilter: ['open'] });
});

/* Home: in the calm layout the folder picker sits just under the message box, like the
 * project picker under the Claude desktop composer (the title bar already has search and
 * history). The dashboard layout keeps it in the page header. */
function placeProjectPicker() {
  const proj = $('homeProject');
  const row = document.querySelector('#homeComposer .composer-row');
  const head = document.querySelector('.home .dash-head-actions');
  if (!proj || !row || !head) return;
  const calm = document.documentElement.dataset.layout === 'calm';
  const box = $('homeComposer');
  proj.classList.toggle('composer-project', calm);
  if (calm && proj.previousElementSibling !== box) {
    box.after(proj);
  } else if (!calm && proj.parentElement !== head) {
    head.append(proj);
  }
}
hooks.boot.push(placeProjectPicker);
{
  const original = applyTheme;
  // eslint-disable-next-line no-global-assign
  applyTheme = function (...args) {
    const r = original(...args);
    placeProjectPicker();
    return r;
  };
}

/* ------------------------------------------------- working indicator */

/* Three terracotta dots that pass each other, with the elapsed time beside them, shown while
 * the agent in the open session is working: the same indicator Claude Code shows. */

const WorkingIndicator = {
  el: null,
  mount() {
    const row = document.querySelector('#ptyComposer .composer-row');
    if (!row || this.el) return;
    const w = document.createElement('div');
    w.id = 'ptyWorking';
    w.className = 'working-ind';
    w.hidden = true;
    w.setAttribute('role', 'status');
    w.innerHTML = `${dotsHtml}<span class="working-time"></span>`;
    const anchor = row.querySelector('.composer-mode') || row.querySelector('.plus-btn');
    if (anchor) anchor.after(w);
    else row.prepend(w);
    this.el = w;
  },
  fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  },
  render() {
    if (!this.el) return;
    const s = active();
    const busy = Boolean(s && s.status === 'running' && s.working);
    this.el.hidden = !busy;
    if (busy) this.el.querySelector('.working-time').textContent = this.fmt(Date.now() - (s.busySince || Date.now()));
  }
};
hooks.boot.push(() => {
  WorkingIndicator.mount();
  WorkingIndicator.render();
  setInterval(() => WorkingIndicator.render(), 500);
});
hooks.view.push(() => WorkingIndicator.render());
hooks.output.push(() => WorkingIndicator.render());
hooks.idle.push(() => WorkingIndicator.render());
