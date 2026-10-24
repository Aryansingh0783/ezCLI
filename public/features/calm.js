'use strict';
/* Calm layout: the sidebar lists the active project's sessions, the way the
 * Claude desktop app lists recent chats. Only shown in the wide, calm sidebar. */

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
      d.className = 'status-dot' + (dot ? ' ' + dot : '');
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
    return [...uniq.filter((m) => pinned.has(m.id)), ...uniq.filter((m) => !pinned.has(m.id))].slice(0, 8);
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
