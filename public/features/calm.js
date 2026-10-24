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
      const row = e.target.closest('[data-rail-session]');
      if (row) selectSession(row.dataset.railSession);
    });
  },

  render() {
    if (!this.box) return;
    const list = spaceSessions().slice().reverse().slice(0, 12);
    this.box.hidden = list.length === 0;
    this.box.textContent = '';
    if (!list.length) return;
    const head = document.createElement('div');
    head.className = 'rail-sessions-head';
    head.textContent = 'Sessions';
    this.box.append(head);
    for (const s of list) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'rail-session' + (s.id === state.activeId ? ' active' : '');
      row.dataset.railSession = s.id;
      const dot = sessionDot(s);
      const d = document.createElement('span');
      d.className = 'status-dot' + (dot ? ' ' + dot : '');
      const t = document.createElement('span');
      t.className = 'rail-session-title';
      t.textContent = s.title || 'Untitled';
      row.append(d, t);
      this.box.append(row);
    }
  }
};

hooks.boot.push(() => {
  RailSessions.mount();
  RailSessions.render();
});
hooks.tabs.push(() => RailSessions.render());
hooks.view.push(() => RailSessions.render());
