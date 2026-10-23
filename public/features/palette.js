'use strict';
/* Command palette (Ctrl+Alt+P, or the search button in the titlebar).
 *
 * One searchable list of everything the window can do. Feature modules add
 * their own entries with registerCommand(); dynamic entries (tabs, spaces,
 * agents) are built fresh each time the palette opens. */

const paletteCommands = [];

/** Register a palette entry. `when()` hides it while it doesn't apply. */
function registerCommand(cmd) {
  paletteCommands.push(cmd);
}

const PaletteUI = (() => {
  let dialog = null;
  let items = [];
  let shown = [];
  let index = 0;

  function dynamicItems() {
    const out = [];
    for (const s of state.sessions) {
      const a = agent(s.agentId);
      const sp = space(s.spaceId);
      out.push({
        group: 'Tabs',
        label: s.title,
        hint: `${a ? a.label : ''}${sp ? ' · ' + sp.name : ''}`,
        run: () => {
          if (s.spaceId !== prefs.activeSpace) selectSpace(s.spaceId);
          selectSession(s.id);
        }
      });
    }
    for (const sp of prefs.spaces) {
      out.push({ group: 'Spaces', label: `Go to ${sp.name}`, hint: sp.path, run: () => selectSpace(sp.id) });
    }
    for (const a of state.agents.filter((x) => x.available)) {
      out.push({
        group: 'Start',
        label: `New ${a.label} session`,
        hint: a.free ? 'Free' : '',
        run: () => {
          selectSession(null);
          chooseAgent(a.id);
          startFromHome();
        }
      });
    }
    return out;
  }

  function staticItems() {
    return [
      { group: 'Session', label: 'New session', keys: 'Ctrl Alt N', run: () => newSession() },
      { group: 'Session', label: 'Close tab', keys: 'Ctrl Alt W', when: () => Boolean(active()), run: () => closeSession(state.activeId) },
      { group: 'Session', label: 'Restart session', when: () => Boolean(active()), run: () => restartSession(active()) },
      { group: 'Session', label: 'Stop session', when: () => Boolean(active() && active().ptyId), run: () => stopSession(active()) },
      { group: 'Session', label: 'Clear terminal', keys: 'Ctrl Alt K', when: () => Boolean(active()), run: () => active().term.clear() },
      { group: 'Session', label: 'Reopen closed tab', keys: 'Ctrl Alt Shift T', when: () => prefs.closed.length > 0, run: () => reopenClosed(prefs.closed[0]) },
      { group: 'Session', label: 'Choose agent…', run: () => agentOnlyMenu($('homeAgent')) },
      { group: 'Session', label: 'Choose model…', run: () => (active() ? $('headModel').click() : modelMenu($('homeModel'))) },
      { group: 'Workspace', label: 'Open folder…', run: () => chooseFolder() },
      { group: 'Workspace', label: 'Toggle explorer', keys: 'Ctrl Alt B', run: () => setExplorerOpen(!prefs.explorerOpen) },
      { group: 'Workspace', label: 'Show changes', run: () => { setExplorerOpen(true); document.querySelector('[data-xtab="changes"]').click(); } },
      { group: 'App', label: 'Settings', run: () => $('settingsSheet').showModal() },
      { group: 'App', label: 'Keyboard shortcuts', run: () => $('helpSheet').showModal() },
      { group: 'App', label: 'Usage', run: () => $('openUsage').click() }
    ];
  }

  /** Every query word must appear in the label, group or hint. */
  function match(item, words) {
    const hay = `${item.label} ${item.group || ''} ${item.hint || ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }

  function draw() {
    const q = dialog.querySelector('input').value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    shown = items.filter((it) => match(it, words)).slice(0, 80);
    index = Math.min(index, Math.max(0, shown.length - 1));
    const list = dialog.querySelector('.palette-list');
    if (!shown.length) {
      list.innerHTML = `<div class="palette-empty">No command matches “${esc(q)}”.</div>`;
      return;
    }
    let lastGroup = '';
    list.innerHTML = shown
      .map((it, i) => {
        const head = it.group !== lastGroup ? `<div class="palette-group">${esc(it.group)}</div>` : '';
        lastGroup = it.group;
        const keys = it.keys ? `<span class="palette-keys">${it.keys.split(' ').map((k) => `<kbd>${esc(k)}</kbd>`).join('')}</span>` : '';
        return `${head}<button class="palette-item${i === index ? ' on' : ''}" data-i="${i}" role="option" aria-selected="${i === index}">
          <span class="palette-label">${esc(it.label)}</span>${it.hint ? `<span class="palette-hint">${esc(it.hint)}</span>` : ''}${keys}</button>`;
      })
      .join('');
    const on = list.querySelector('.palette-item.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function run(i) {
    const it = shown[i];
    if (!it) return;
    dialog.close();
    setTimeout(() => {
      try {
        it.run();
      } catch (err) {
        toast(String(err), 'error');
      }
    }, 0);
  }

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'palette';
    dialog.setAttribute('aria-label', 'Command palette');
    dialog.innerHTML = `<div class="palette-search">${ICONS.search}<input placeholder="Type a command, tab, folder or agent" aria-label="Search commands" spellcheck="false" autocomplete="off" /><kbd>Esc</kbd></div>
      <div class="palette-list" role="listbox"></div>`;
    document.body.appendChild(dialog);
    const input = dialog.querySelector('input');
    input.addEventListener('input', () => {
      index = 0;
      draw();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') index = Math.min(index + 1, shown.length - 1);
      else if (e.key === 'ArrowUp') index = Math.max(index - 1, 0);
      else if (e.key === 'Enter') return run(index);
      else return;
      e.preventDefault();
      draw();
    });
    dialog.querySelector('.palette-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) run(Number(b.dataset.i));
    });
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }

  function open(prefill = '') {
    if (!dialog) build();
    items = [...staticItems(), ...paletteCommands, ...dynamicItems()].filter((it) => !it.when || it.when());
    const input = dialog.querySelector('input');
    input.value = prefill;
    index = 0;
    draw();
    if (!dialog.open) dialog.showModal();
    input.focus();
  }

  return { open };
})();

ICONS.search = svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 15);

hooks.shortcut.push((code) => {
  if (code !== 'KeyP') return false;
  PaletteUI.open();
  return true;
});

hooks.boot.push(() => {
  const btn = document.createElement('button');
  btn.className = 'head-icon';
  btn.id = 'paletteBtn';
  btn.title = 'Command palette (Ctrl+Alt+P)';
  btn.setAttribute('aria-label', 'Command palette');
  btn.innerHTML = ICONS.search;
  btn.addEventListener('click', () => PaletteUI.open());
  $('closedTabsBtn').before(btn);
});
