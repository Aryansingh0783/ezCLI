'use strict';

const $ = (id) => document.getElementById(id);

const FB_THEME = {
  background: '#1c1d1c',
  foreground: '#dedfdd',
  cursor: '#b5cea5',
  cursorAccent: '#1c211b',
  selectionBackground: 'rgba(181,206,165,0.22)',
  black: '#1c1d1c',
  red: '#cf4646',
  green: '#b5cea5',
  yellow: '#d98b0a',
  blue: '#2b8fa6',
  magenta: '#b07ae0',
  cyan: '#39766d',
  white: '#dedfdd',
  brightBlack: '#949891',
  brightRed: '#e07a7a',
  brightGreen: '#cbdfbd',
  brightYellow: '#e9a834',
  brightBlue: '#53aec2',
  brightMagenta: '#c79bea',
  brightCyan: '#5aa79c',
  brightWhite: '#ffffff'
};

const ICONS = {
  code: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m9 18-6-6 6-6"/><path d="m15 6 6 6-6 6"/></svg>',
  chat: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>',
  term: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m5 8 4 4-4 4"/><path d="M12 16h7"/></svg>',
  folder: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M5 4a1 1 0 0 1 1-1h8l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M14 3v6h5"/></svg>'
};

const state = {
  agents: [],
  cwd: '',
  sep: '\\',
  selectedAgentId: null,
  sessions: [],
  activeId: null,
  seq: 0,
  pane: 'term'
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const agent = (id) => state.agents.find((a) => a.id === id);
const active = () => state.sessions.find((s) => s.id === state.activeId) || null;

/* ------------------------------------------------------------------- boot */

async function boot() {
  let info;
  try {
    info = await fetch('/api/agents').then((r) => r.json());
  } catch {
    document.body.innerHTML =
      '<div style="padding:40px;font-family:sans-serif;color:#dedfdd">Could not reach the ezCLI server. Is it still running?</div>';
    return;
  }
  state.agents = info.agents;
  state.cwd = info.cwd;
  state.sep = info.sep || '\\';
  const first = state.agents.find((a) => a.available) || state.agents[0];
  state.selectedAgentId = first ? first.id : null;

  renderAgentGrid();
  renderAgentList();
  renderChips();
  renderCwd();
  renderTabs();
  renderStatus();
  wire();
}

/* -------------------------------------------------------------- rendering */

function renderAgentGrid() {
  $('agentGrid').innerHTML = state.agents
    .map(
      (a) => `
      <button class="agent-card ${a.id === state.selectedAgentId ? 'is-selected' : ''} ${
        a.available ? '' : 'is-missing'
      }" data-agent="${esc(a.id)}" role="radio" aria-checked="${a.id === state.selectedAgentId}" ${
        a.available ? '' : 'disabled aria-disabled="true"'
      }>
        <span class="ico">${ICONS[a.icon] || ICONS.term}</span>
        <span class="meta">
          <span class="name">${esc(a.label)}</span>
          <span class="state">${a.available ? esc(a.command) : 'not installed'}</span>
        </span>
      </button>`
    )
    .join('');
  bindAgentPicks($('agentGrid'));
}

function renderAgentList() {
  $('agentList').innerHTML = state.agents
    .map(
      (a) => `
      <button class="side-row ${a.id === state.selectedAgentId ? 'is-active' : ''}" data-agent="${esc(a.id)}">
        ${ICONS[a.icon] || ICONS.term}
        <span class="label">${esc(a.label)}</span>
        ${a.available ? '' : '<span class="badge">off</span>'}
      </button>`
    )
    .join('');
  bindAgentPicks($('agentList'));
}

function bindAgentPicks(root) {
  root.querySelectorAll('[data-agent]').forEach((el) =>
    el.addEventListener('click', () => {
      if (el.disabled) return;
      state.selectedAgentId = el.dataset.agent;
      renderAgentGrid();
      renderAgentList();
      renderChips();
    })
  );
}

function renderChips() {
  const s = active();
  const src = agent(s ? s.agentId : state.selectedAgentId);
  if (!src) return;
  $('chipAgentLabel').textContent = src.label;

  const modelId = s ? s.modelId : src.__model || 'default';
  const modeId = s ? s.modeId : src.__mode || 'default';
  $('chipModelLabel').textContent = (src.models.find((m) => m.id === modelId) || src.models[0]).label;
  $('chipModeLabel').textContent = (src.modes.find((m) => m.id === modeId) || src.modes[0]).label;

  // A running session's launch flags are fixed; lock the chips so the label
  // never implies a change that would not take effect until restart.
  const locked = Boolean(s);
  $('chipModel').disabled = locked;
  $('chipMode').disabled = locked;
  $('chipModel').title = locked ? 'Model is fixed for a running session. Restart to change it.' : '';
  $('chipMode').title = locked ? 'Mode is fixed for a running session. Restart to change it.' : '';
}

function renderCwd() {
  const short = ellipsisLeft(state.cwd, 30);
  $('cwdLabel').textContent = short;
  $('heroCwdLabel').textContent = short;
}

function renderTabs() {
  $('tabstrip').innerHTML = state.sessions
    .map(
      (s) => `
      <div class="wtab ${s.id === state.activeId ? 'is-active' : ''} ${
        s.status === 'running' ? 'is-running' : s.status === 'exited' || s.status === 'error' ? 'is-exited' : ''
      }" data-tab="${s.id}" role="tab" aria-selected="${s.id === state.activeId}" title="${esc(s.title)}">
        <span class="dot"></span>
        <span class="label">${esc(s.title)}</span>
        <span class="x" data-close="${s.id}" role="button" aria-label="Close ${esc(s.title)}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </span>
      </div>`
    )
    .join('');

  $('tabstrip')
    .querySelectorAll('[data-tab]')
    .forEach((el) =>
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) return;
        selectSession(el.dataset.tab);
      })
    );
  $('tabstrip')
    .querySelectorAll('[data-close]')
    .forEach((el) =>
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSession(el.dataset.close);
      })
    );

  renderSessionTree();
  $('sessionCount').textContent = state.sessions.length;
}

function renderSessionTree() {
  const tree = $('sessionTree');
  if (!state.sessions.length) {
    tree.innerHTML = '<p class="side-empty">No sessions yet.</p>';
    return;
  }
  tree.innerHTML = state.sessions
    .map(
      (s) => `
      <button class="side-row ${s.id === state.activeId ? 'is-active' : ''}" data-sess="${s.id}">
        ${ICONS[agent(s.agentId).icon] || ICONS.term}
        <span class="label">${esc(s.title)}</span>
        <span class="badge">${s.status === 'running' ? 'live' : esc(s.status)}</span>
      </button>`
    )
    .join('');
  tree.querySelectorAll('[data-sess]').forEach((el) =>
    el.addEventListener('click', () => selectSession(el.dataset.sess))
  );
}

function renderStatus() {
  const s = active();
  const st = $('stState');
  if (!s) {
    st.textContent = 'idle';
    st.className = 'dead';
    $('stCmd').textContent = 'no session';
    $('stCwd').textContent = '';
    $('stSize').textContent = '';
    return;
  }
  st.textContent = s.status;
  st.className = s.status === 'running' ? 'live' : 'dead';
  $('stCmd').textContent = s.command || agent(s.agentId).command;
  $('stCwd').textContent = s.cwd || state.cwd;
  $('stSize').textContent = s.term ? `${s.term.cols}×${s.term.rows}` : '';
}

/* -------------------------------------------------------------- sessions */

function createSession(agentId, opts = {}) {
  const a = agent(agentId);
  if (!a) return null;
  if (!a.available) {
    flashHero(`${a.label} is not installed. Point agents.json at its executable, then reload agents.`);
    return null;
  }

  const id = `s${++state.seq}`;
  const host = document.createElement('div');
  host.className = 'term-host';
  host.style.display = 'none';
  $('termHost').appendChild(host);

  const term = new Terminal({
    fontFamily: 'JetBrains Mono, DM Mono, ui-monospace, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.35,
    cursorBlink: true,
    allowProposedApi: true,
    theme: FB_THEME,
    scrollback: 10000
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  try {
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
  } catch {
    /* optional addon */
  }
  term.open(host);

  const count = state.sessions.filter((x) => x.agentId === agentId).length + 1;
  const sess = {
    id,
    agentId,
    title: `${a.label} ${count}`,
    modelId: opts.modelId || a.__model || 'default',
    modeId: opts.modeId || a.__mode || 'default',
    cwd: state.cwd,
    status: 'starting',
    command: '',
    term,
    fit,
    host,
    ws: null,
    pendingPrompt: opts.prompt || ''
  };
  state.sessions.push(sess);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/pty`);
  sess.ws = ws;

  ws.addEventListener('open', () => {
    fitSession(sess);
    ws.send(
      JSON.stringify({
        type: 'start',
        agentId,
        modelId: sess.modelId,
        modeId: sess.modeId,
        cwd: sess.cwd,
        cols: term.cols,
        rows: term.rows
      })
    );
  });

  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === 'data') {
      term.write(m.data);
    } else if (m.type === 'started') {
      sess.status = 'running';
      sess.command = m.command;
      sess.cwd = m.cwd;
      renderTabs();
      if (sess.id === state.activeId) renderStatus();
      if (sess.pendingPrompt) {
        const text = sess.pendingPrompt;
        sess.pendingPrompt = '';
        setTimeout(() => sendRaw(sess, text + '\r'), 700);
      }
    } else if (m.type === 'exit') {
      sess.status = 'exited';
      term.write(`\r\n\x1b[38;2;148;152;145m-- process exited (code ${m.exitCode}) --\x1b[0m\r\n`);
      renderTabs();
      if (sess.id === state.activeId) renderStatus();
    } else if (m.type === 'fatal') {
      sess.status = 'error';
      term.write(`\r\n\x1b[38;2;224;122;122m${String(m.message).replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
      renderTabs();
      if (sess.id === state.activeId) renderStatus();
    }
  });

  ws.addEventListener('close', () => {
    if (sess.status === 'running' || sess.status === 'starting') {
      sess.status = 'exited';
      renderTabs();
      if (sess.id === state.activeId) renderStatus();
    }
  });
  ws.addEventListener('error', () => {
    if (sess.status === 'starting') {
      sess.status = 'error';
      term.write('\r\n\x1b[38;2;224;122;122mConnection to the ezCLI server failed.\x1b[0m\r\n');
      renderTabs();
      if (sess.id === state.activeId) renderStatus();
    }
  });

  term.onData((d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: d }));
  });

  switchPane('term');
  selectSession(id);
  renderTabs();
  return sess;
}

function sendRaw(sess, data) {
  if (sess && sess.ws && sess.ws.readyState === WebSocket.OPEN) {
    sess.ws.send(JSON.stringify({ type: 'input', data }));
  }
}

function selectSession(id) {
  state.activeId = id;
  state.sessions.forEach((s) => {
    s.host.style.display = s.id === id ? 'block' : 'none';
  });
  const s = active();
  $('hero').classList.toggle('is-hidden', Boolean(s));
  $('workspace').classList.toggle('is-active', Boolean(s));
  if (s) {
    requestAnimationFrame(() => {
      fitSession(s);
      if (state.pane === 'term') s.term.focus();
    });
  }
  renderTabs();
  renderChips();
  renderStatus();
}

function closeSession(id) {
  const i = state.sessions.findIndex((s) => s.id === id);
  if (i === -1) return;
  const s = state.sessions[i];
  try {
    if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: 'kill' }));
    if (s.ws) s.ws.close();
  } catch {
    /* already closing */
  }
  s.term.dispose();
  s.host.remove();
  state.sessions.splice(i, 1);
  const next = state.sessions.length ? state.sessions[Math.min(i, state.sessions.length - 1)].id : null;
  selectSession(next);
}

function fitSession(s) {
  if (!s) return;
  try {
    s.fit.fit();
  } catch {
    return;
  }
  if (s.ws && s.ws.readyState === WebSocket.OPEN) {
    s.ws.send(JSON.stringify({ type: 'resize', cols: s.term.cols, rows: s.term.rows }));
  }
  if (s.id === state.activeId) renderStatus();
}

/* ----------------------------------------------------------------- panes */

function switchPane(name) {
  state.pane = name;
  document.querySelectorAll('.panetab[data-pane]').forEach((t) => {
    const on = t.dataset.pane === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.pane[data-pane]').forEach((p) => {
    p.classList.toggle('is-active', p.dataset.pane === name);
  });
  $('termFoot').classList.toggle('is-hidden', name !== 'term');

  const s = active();
  if (name === 'term' && s) {
    requestAnimationFrame(() => {
      fitSession(s);
      s.term.focus();
    });
  } else if (name === 'files') {
    loadFiles(s ? s.cwd : state.cwd);
  } else if (name === 'changes') {
    loadChanges(s ? s.cwd : state.cwd);
  }
}

async function loadFiles(dir) {
  const list = $('fileList');
  list.innerHTML = '<li class="side-empty">Loading…</li>';
  $('filePreview').innerHTML = '<p class="empty">Select a file to preview it.</p>';
  let data;
  try {
    data = await fetch(`/api/files?path=${encodeURIComponent(dir)}`).then((r) => r.json());
  } catch {
    list.innerHTML = '<li class="side-empty">Could not read the folder.</li>';
    return;
  }
  if (data.error) {
    list.innerHTML = `<li class="side-empty">${esc(data.error)}</li>`;
    return;
  }

  $('fileCrumbs').innerHTML =
    (data.parent ? `<button data-dir="${esc(data.parent)}">..</button><span class="crumb-sep">/</span>` : '') +
    `<span>${esc(data.path)}</span>`;
  $('fileCrumbs')
    .querySelectorAll('[data-dir]')
    .forEach((b) => b.addEventListener('click', () => loadFiles(b.dataset.dir)));

  list.innerHTML =
    data.entries
      .map(
        (e) => `
      <li data-path="${esc(e.path)}" data-dir="${e.dir ? '1' : '0'}">
        ${e.dir ? ICONS.folder : ICONS.file}
        <span class="name">${esc(e.name)}</span>
        ${e.dir ? '' : `<span class="meta">${fmtSize(e.size)}</span>`}
      </li>`
      )
      .join('') || '<li class="side-empty">Empty folder.</li>';

  list.querySelectorAll('li[data-path]').forEach((li) =>
    li.addEventListener('click', () => {
      if (li.dataset.dir === '1') {
        loadFiles(li.dataset.path);
      } else {
        list.querySelectorAll('li').forEach((x) => x.classList.remove('is-active'));
        li.classList.add('is-active');
        previewFile(li.dataset.path);
      }
    })
  );
}

async function previewFile(file) {
  const box = $('filePreview');
  box.innerHTML = '<p class="empty">Loading…</p>';
  let data;
  try {
    data = await fetch(`/api/file?path=${encodeURIComponent(file)}`).then((r) => r.json());
  } catch {
    box.innerHTML = '<p class="empty">Could not read the file.</p>';
    return;
  }
  if (data.error) return void (box.innerHTML = `<p class="empty">${esc(data.error)}</p>`);
  if (data.binary) return void (box.innerHTML = '<p class="empty">Binary file.</p>');
  box.textContent = data.text + (data.truncated ? '\n\n… preview truncated …' : '');
}

async function loadChanges(dir) {
  const list = $('gitList');
  list.innerHTML = '<li class="side-empty">Loading…</li>';
  $('gitPreview').innerHTML = '';
  $('gitHead').innerHTML = '';
  let data;
  try {
    data = await fetch(`/api/git?path=${encodeURIComponent(dir)}`).then((r) => r.json());
  } catch {
    list.innerHTML = '<li class="side-empty">Could not run git.</li>';
    return;
  }

  if (!data.repo) {
    $('gitHead').innerHTML = '';
    list.innerHTML = `<li class="side-empty">${esc(data.reason || 'Not a git repository.')}</li>`;
    $('gitPreview').innerHTML = '<p class="empty">Open a session inside a git repository to see changes.</p>';
    return;
  }

  $('gitHead').innerHTML = `<span class="branch">${ICONS.code} ${esc(data.branch)}</span><span class="crumb-sep">·</span><span>${esc(
    data.root
  )}</span>`;

  if (!data.files.length) {
    list.innerHTML = '<li class="side-empty">Working tree clean.</li>';
    $('gitPreview').innerHTML = '<p class="empty">No uncommitted changes.</p>';
    return;
  }

  list.innerHTML = data.files
    .map((f) => {
      const cls = f.untracked || f.code.includes('A') ? 'g-add' : f.code.includes('D') ? 'g-del' : 'g-mod';
      const code = f.untracked ? '??' : f.code.trim() || 'M';
      return `
      <li data-file="${esc(f.file)}" data-untracked="${f.untracked ? '1' : '0'}">
        <span class="gcode ${cls}">${esc(code)}</span>
        <span class="name">${esc(f.file)}</span>
      </li>`;
    })
    .join('');

  list.querySelectorAll('li[data-file]').forEach((li) =>
    li.addEventListener('click', () => {
      list.querySelectorAll('li').forEach((x) => x.classList.remove('is-active'));
      li.classList.add('is-active');
      showDiff(dir, li.dataset.file, li.dataset.untracked === '1');
    })
  );
}

async function showDiff(dir, file, untracked) {
  const box = $('gitPreview');
  box.innerHTML = '<p class="empty">Loading…</p>';
  let data;
  try {
    const q = `path=${encodeURIComponent(dir)}&file=${encodeURIComponent(file)}${untracked ? '&untracked=1' : ''}`;
    data = await fetch(`/api/diff?${q}`).then((r) => r.json());
  } catch {
    box.innerHTML = '<p class="empty">Could not load the diff.</p>';
    return;
  }
  if (data.error) return void (box.innerHTML = `<p class="empty">${esc(data.error)}</p>`);
  if (!data.diff) return void (box.innerHTML = `<p class="empty">${esc(data.note || 'No changes.')}</p>`);

  box.innerHTML = data.diff
    .split('\n')
    .map((line) => {
      let cls = '';
      if (line.startsWith('+') && !line.startsWith('+++')) cls = 'dl-add';
      else if (line.startsWith('-') && !line.startsWith('---')) cls = 'dl-del';
      else if (line.startsWith('@@')) cls = 'dl-hunk';
      else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---'))
        cls = 'dl-meta';
      return `<span class="${cls}">${esc(line) || ' '}</span>`;
    })
    .join('\n');
}

/* ------------------------------------------------------------------ menu */

function openMenu(anchor, title, items, onPick) {
  const menu = $('menu');
  menu.innerHTML =
    (title ? `<div class="mh">${esc(title)}</div>` : '') +
    items
      .map(
        (it, i) =>
          `<button class="mi ${it.on ? 'is-on' : ''}" data-i="${i}" ${it.disabled ? 'disabled' : ''} role="menuitem">${esc(
            it.label
          )}
            <svg class="tick" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m5 13 4 4L19 7"/></svg>
          </button>`
      )
      .join('');
  menu.hidden = false;
  $('scrim').hidden = false;

  const r = anchor.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 12);
  const top = Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 12);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  menu.querySelectorAll('[data-i]').forEach((el) =>
    el.addEventListener('click', () => {
      const it = items[Number(el.dataset.i)];
      if (it.disabled) return;
      closeMenu();
      onPick(it);
    })
  );
}
function closeMenu() {
  $('menu').hidden = true;
  $('scrim').hidden = true;
}

function flashHero(msg) {
  const sub = document.querySelector('.hero .sub');
  if (!sub) return;
  const prev = sub.dataset.base || sub.textContent;
  sub.dataset.base = prev;
  sub.textContent = msg;
  sub.style.color = 'var(--fb-danger-text)';
  clearTimeout(flashHero._t);
  flashHero._t = setTimeout(() => {
    sub.textContent = prev;
    sub.style.color = '';
  }, 4000);
}

/* ---------------------------------------------------------------- helpers */

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function ellipsisLeft(s, max) {
  return s.length > max ? '…' + s.slice(-(max - 1)) : s;
}
function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}

/* ------------------------------------------------------------------ wiring */

function wire() {
  $('scrim').addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('menu').hidden) closeMenu();
  });

  $('toggleSidebar').addEventListener('click', (e) => {
    const hidden = $('sidebar').classList.toggle('is-hidden');
    e.currentTarget.classList.toggle('is-on', !hidden);
    e.currentTarget.setAttribute('aria-label', hidden ? 'Show sidebar' : 'Hide sidebar');
    setTimeout(() => fitSession(active()), 360);
  });

  const startFromHero = () => {
    const prompt = $('heroInput').value.trim();
    const s = createSession(state.selectedAgentId, { prompt });
    if (s) {
      $('heroInput').value = '';
      autoGrow($('heroInput'));
    }
  };

  $('newTab').addEventListener('click', () => createSession(state.selectedAgentId));
  $('sideNew').addEventListener('click', () => selectSession(null));
  $('promoNew').addEventListener('click', startFromHero);
  $('heroStart').addEventListener('click', startFromHero);
  $('railHome').addEventListener('click', () => selectSession(null));
  $('railSessions').addEventListener('click', () => state.sessions.length && selectSession(state.sessions[0].id));
  $('railSettings').addEventListener('click', (e) =>
    openMenu(e.currentTarget, 'Settings', [{ label: 'Reload agents.json', id: 'reload' }], (it) => {
      if (it.id === 'reload') reloadAgents();
    })
  );
  $('railHelp').addEventListener('click', () => $('helpSheet').showModal());

  $('heroInput').addEventListener('input', (e) => autoGrow(e.target));
  $('heroInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      startFromHero();
    }
  });

  $('ptyInput').addEventListener('input', (e) => autoGrow(e.target));
  $('ptyInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendComposer();
    }
  });
  $('btnSend').addEventListener('click', sendComposer);
  $('btnInterrupt').addEventListener('click', () => {
    sendRaw(active(), '\x03');
    const s = active();
    if (s && state.pane === 'term') s.term.focus();
  });
  $('btnEsc').addEventListener('click', () => sendRaw(active(), '\x1b'));

  $('navClear').addEventListener('click', () => active() && active().term.clear());
  $('navStop').addEventListener('click', () => {
    const s = active();
    if (s && s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: 'kill' }));
  });
  $('navRestart').addEventListener('click', () => {
    const s = active();
    if (!s) return;
    const { agentId, modelId, modeId } = s;
    closeSession(s.id);
    createSession(agentId, { modelId, modeId });
  });

  document.querySelectorAll('.panetab[data-pane]').forEach((t) =>
    t.addEventListener('click', () => switchPane(t.dataset.pane))
  );
  $('paneRefresh').addEventListener('click', () => switchPane(state.pane));

  $('chipAgent').addEventListener('click', (e) => {
    if (active()) return; // agent is fixed once a session exists
    openMenu(
      e.currentTarget,
      'Agent',
      state.agents.map((a) => ({
        label: a.available ? a.label : `${a.label} — not installed`,
        id: a.id,
        on: a.id === state.selectedAgentId,
        disabled: !a.available
      })),
      (it) => {
        state.selectedAgentId = it.id;
        renderAgentGrid();
        renderAgentList();
        renderChips();
      }
    );
  });

  $('chipModel').addEventListener('click', (e) => {
    if (active()) return;
    const a = agent(state.selectedAgentId);
    const cur = a.__model || 'default';
    openMenu(
      e.currentTarget,
      'Model',
      a.models.map((m) => ({ label: m.label, id: m.id, on: m.id === cur })),
      (it) => {
        a.__model = it.id;
        renderChips();
      }
    );
  });

  $('chipMode').addEventListener('click', (e) => {
    if (active()) return;
    const a = agent(state.selectedAgentId);
    const cur = a.__mode || 'default';
    openMenu(
      e.currentTarget,
      'Mode',
      a.modes.map((m) => ({ label: m.label, id: m.id, on: m.id === cur })),
      (it) => {
        a.__mode = it.id;
        renderChips();
      }
    );
  });

  const choose = () => {
    const dir = window.prompt('Folder new sessions should start in:', state.cwd);
    if (!dir) return;
    fetch(`/api/files?path=${encodeURIComponent(dir)}`)
      .then((r) => r.json())
      .then((r) => {
        if (r.error) return flashHero(r.error);
        state.cwd = r.path;
        renderCwd();
      })
      .catch(() => flashHero('Could not open that folder.'));
  };
  $('pickCwd').addEventListener('click', choose);
  $('heroCwd').addEventListener('click', choose);

  window.addEventListener('resize', () => fitSession(active()));
  window.addEventListener('beforeunload', () => {
    state.sessions.forEach((s) => {
      try {
        s.ws && s.ws.close();
      } catch {
        /* ignore */
      }
    });
  });

  // Ctrl+Alt is the modifier so these never intercept the agent's own
  // terminal shortcuts (Ctrl+W, Ctrl+C, Ctrl+1 … are all left alone).
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.altKey) || e.shiftKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === 'n') {
      e.preventDefault();
      createSession(state.selectedAgentId);
    } else if (k === 'w') {
      e.preventDefault();
      if (state.activeId) closeSession(state.activeId);
    } else if (k === 'b') {
      e.preventDefault();
      $('toggleSidebar').click();
    } else if (k === 'k') {
      e.preventDefault();
      active() && active().term.clear();
    } else if (e.code && /^Digit[1-9]$/.test(e.code)) {
      const idx = Number(e.code.slice(5)) - 1;
      if (state.sessions[idx]) {
        e.preventDefault();
        switchPane('term');
        selectSession(state.sessions[idx].id);
      }
    }
  });
}

function sendComposer() {
  const el = $('ptyInput');
  const v = el.value;
  if (!v.trim() || !active()) return;
  sendRaw(active(), v + '\r');
  el.value = '';
  autoGrow(el);
}

async function reloadAgents() {
  try {
    const r = await fetch('/api/agents/reload', { method: 'POST' }).then((x) => x.json());
    if (!r.ok) return flashHero(r.error || 'Reload failed.');
    const keep = state.selectedAgentId;
    state.agents = r.agents;
    if (!agent(keep)) {
      const first = state.agents.find((a) => a.available) || state.agents[0];
      state.selectedAgentId = first ? first.id : null;
    }
    renderAgentGrid();
    renderAgentList();
    renderChips();
    flashHero('Agents reloaded from agents.json.');
  } catch {
    flashHero('Could not reach the server to reload agents.');
  }
}

boot();
