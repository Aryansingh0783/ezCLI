'use strict';

/* ezCLI frontend — talks to the Rust backend over the Tauri IPC bridge.
 *
 * Layout follows the Freebuff desktop shell: a rail of spaces (one per
 * project folder), a frameless titlebar of session tabs, a home screen for
 * starting sessions, and a resizable explorer for files and git changes.
 * Every session is still a real CLI in a real pseudo-terminal. */

const T = window.__TAURI__;
const invoke = (name, args) => T.core.invoke(name, args);
const listen = (event, handler) => T.event.listen(event, handler);
const $ = (id) => document.getElementById(id);
const Usage = window.ezCliUsage;

/* ------------------------------------------------------------ preferences */

const PREFS_KEY = 'ezcli.v2';
const DEFAULT_PREFS = {
  theme: 'system',
  fontSize: 13,
  zoom: 1,
  spaces: [],
  activeSpace: null,
  explorerOpen: false,
  explorerWidth: 440,
  explorerTab: 'files',
  agentId: null,
  // First-run detection is informative, not a gate. We persist dismissal too
  // so experienced users are never shown the wizard repeatedly.
  onboarded: false,
  picks: {},
  openTarget: null,
  closed: [],
  history: [],
  // Parked tabs persisted across restarts. Each entry is enough to relaunch
  // the exact same CLI configuration; the process itself does not survive.
  parked: [],
  // Session counters we can honestly measure (we never call model APIs).
  usage: {}
};

function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
const prefs = loadPrefs();
let saveTimer = 0;
function savePrefs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* storage unavailable; preferences just won't persist */
    }
  }, 150);
}

/* ----------------------------------------------------------------- themes */

const TERM_THEMES = {
  dark: {
    background: '#111318',
    foreground: '#e7e7e8',
    cursor: '#7cff3f',
    cursorAccent: '#0c0d0f',
    selectionBackground: 'rgba(124,255,63,0.20)',
    black: '#15171a',
    red: '#d56a6a',
    green: '#7fc98f',
    yellow: '#d8a14a',
    blue: '#6b9fd0',
    magenta: '#b58be0',
    cyan: '#5bb6b0',
    white: '#d9d9de',
    brightBlack: '#6a6a70',
    brightRed: '#e7a3a3',
    brightGreen: '#a9e9b3',
    brightYellow: '#ecc27a',
    brightBlue: '#97c0e8',
    brightMagenta: '#cfb0ef',
    brightCyan: '#8ad6d0',
    brightWhite: '#ffffff'
  },
  light: {
    background: '#ffffff',
    foreground: '#1d1d20',
    cursor: '#368f06',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(54,143,6,0.18)',
    black: '#1d1d20',
    red: '#c04747',
    green: '#2e8b57',
    yellow: '#966600',
    blue: '#2d6cb0',
    magenta: '#7a48cf',
    cyan: '#1f7f7a',
    white: '#63636b',
    brightBlack: '#8b8b95',
    brightRed: '#a13a3a',
    brightGreen: '#2f6a44',
    brightYellow: '#7a5200',
    brightBlue: '#1f5590',
    brightMagenta: '#5f34a8',
    brightCyan: '#14615d',
    brightWhite: '#1d1d20'
  }
};

const systemDark = matchMedia('(prefers-color-scheme: dark)');
const resolvedTheme = () => (prefs.theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : prefs.theme);

function applyTheme() {
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  for (const s of state.sessions) s.term.options.theme = TERM_THEMES[t];
  document.querySelectorAll('[data-theme-opt]').forEach((b) => {
    const on = b.dataset.themeOpt === prefs.theme;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
}

/* ------------------------------------------------------------------ icons */

const svg = (d, w = 15, sw = 1.8) =>
  `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  code: svg('<path d="m9 18-6-6 6-6"/><path d="m15 6 6 6-6 6"/>', 13),
  chat: svg('<path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/>', 13),
  term: svg('<path d="m5 8 4 4-4 4"/><path d="M12 16h7"/>', 13),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', 14, 1.6),
  file: svg('<path d="M5 4a1 1 0 0 1 1-1h8l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M14 3v6h5"/>', 14, 1.6),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>', 11, 2.4),
  twisty: svg('<path d="m9 6 6 6-6 6"/>', 10, 2.4),
  back: svg('<path d="m15 18-6-6 6-6"/>', 14, 2),
  check: svg('<path d="m5 13 4 4L19 7"/>', 13, 2.4),
  spark: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>', 14),
  branch: svg('<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10a6 6 0 0 1-6 6H8"/>', 12),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 13, 2)
};

/* ------------------------------------------------------------------ state */

const state = {
  agents: [],
  backends: null,
  homeCwd: '',
  sep: '\\',
  configPath: '',
  openTargets: [],
  sessions: [],
  activeId: null,
  activeBySpace: {},
  seq: 0,
  imports: { catalog: null, selected: null },
  git: {}, // space path -> last git_status result
  explorer: { view: 'list', root: null, expanded: new Set(), cache: new Map(), filter: '', file: null, diff: null }
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const agent = (id) => state.agents.find((a) => a.id === id);
const active = () => state.sessions.find((s) => s.id === state.activeId) || null;
const space = (id = prefs.activeSpace) => prefs.spaces.find((x) => x.id === id) || null;
const spaceSessions = (id = prefs.activeSpace) => state.sessions.filter((s) => s.spaceId === id);
const basename = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const spaceIdFor = (path) => String(path).replace(/[\\/]+$/, '').toLowerCase();

/* ------------------------------------------------------------- persistence
 *
 * Sessions themselves cannot survive the app dying: the PTY and the agent
 * process go with it. What we persist is enough metadata to recreate the
 * tab in the same configuration (agent, model, mode, cwd, title) so a
 * restart does not lose the user's workspace. Restored tabs are "parked"
 * and show a Resume button that calls launch() to spawn a fresh CLI. */

function snapshotParked() {
  prefs.activeBySpace = { ...state.activeBySpace };
  if (state.activeId && active()) prefs.activeBySpace[active().spaceId] = state.activeId;
  prefs.parked = state.sessions
    .filter((s) => space(s.spaceId))
    .map((s) => ({
      id: s.id,
      spaceId: s.spaceId,
      agentId: s.agentId,
      modelId: s.modelId,
      modeId: s.modeId,
      cwd: s.cwd,
      title: s.title,
      exitCode: s.exitCode,
      wasRunning: s.status === 'running',
      durationMs: Math.max(0, (s.lastOutputAt || Date.now()) - s.startedAt)
    }));
  savePrefs();
}

/** Count a finished session against the per-agent totals shown in Usage. */
function recordUsage(s) {
  if (!s || !s.agentId) return;
  const row = (prefs.usage[s.agentId] ||= { sessions: 0, seconds: 0, lastAt: 0 });
  row.sessions += 1;
  row.seconds += Math.max(0, Math.round(((s.lastOutputAt || Date.now()) - s.startedAt) / 1000));
  row.lastAt = Date.now();
  savePrefs();
}

function pick(a) {
  const p = (prefs.picks[a.id] ||= {});
  if (!a.models.some((m) => m.id === p.model)) p.model = a.models[0] ? a.models[0].id : 'default';
  if (!a.modes.some((m) => m.id === p.mode)) p.mode = a.modes[0] ? a.modes[0].id : 'default';
  return p;
}
const label = (list, id) => (list.find((x) => x.id === id) || list[0] || { label: 'Default' }).label;

/* ------------------------------------------------------------------- boot */

async function boot() {
  if (!T) {
    $('startupRecovery').querySelector('p').textContent = 'ezCLI needs to run inside its desktop window.';
    return;
  }
  let info;
  try {
    info = await invoke('list_agents');
  } catch (err) {
    $('startupRecovery').querySelector('p').textContent = 'The backend did not respond: ' + String(err);
    return;
  }
  state.agents = info.agents;
  state.homeCwd = info.cwd;
  state.sep = info.sep || '\\';
  state.configPath = info.config_path || '';
  invoke('open_targets')
    .then((t) => {
      state.openTargets = t;
      renderHead();
    })
    .catch(() => {});

  if (!prefs.spaces.length) addSpace(info.cwd, { silent: true });
  if (!space()) prefs.activeSpace = prefs.spaces[0].id;
  if (!agent(prefs.agentId) || !agent(prefs.agentId).available) {
    const first = state.agents.find((a) => a.available) || state.agents[0];
    prefs.agentId = first ? first.id : null;
  }

  // Detection only reports installation/auth presence. It never returns a
  // credential value to the webview. A failure leaves the app fully usable.
  try {
    state.backends = await invoke('detect_backends');
    const recommended = agent(state.backends.recommended);
    if (!prefs.onboarded && recommended && recommended.available) {
      prefs.agentId = recommended.id;
    }
  } catch {
    state.backends = null;
  }

  // Recreate every tab that was open at last shutdown as a parked session.
  // Nothing has launched yet; the user resumes with one click.
  for (const sn of prefs.parked || []) {
    if (!space(sn.spaceId) || !agent(sn.agentId)) continue;
    buildParked(sn);
  }
  // Persisted per-space active tab from the last run.
  state.activeBySpace = { ...(prefs.activeBySpace || {}) };

  $('startupRecovery').remove();
  $('app').hidden = false;

  applyTheme();
  applyZoom();
  applyExplorerWidth();
  setExplorerOpen(prefs.explorerOpen, { quiet: true });
  renderAll();
  wire();
  refreshGit();
  setInterval(tick, 1000);
  $('homeInput').focus();
  showOnboarding();
}

function renderAll() {
  renderSpaces();
  renderTabs();
  renderHome();
  renderView();
}

/* ------------------------------------------------------------------ spaces */

function addSpace(path, { silent = false } = {}) {
  const id = spaceIdFor(path);
  if (!prefs.spaces.some((x) => x.id === id)) prefs.spaces.push({ id, path, name: basename(path) });
  prefs.activeSpace = id;
  savePrefs();
  if (!silent) {
    selectSpace(id);
    toast(`Opened ${basename(path)}`, 'ok');
  }
}

function initials(name) {
  const parts = String(name).split(/[\s._-]+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : String(name).slice(0, 2);
  return s.toUpperCase();
}

function sessionDot(s) {
  if (s.status === 'error') return 'error';
  if (s.status === 'parked') return 'parked';
  if (s.status !== 'running') return '';
  if (s.working) return 'working';
  if (s.unseen) return 'unseen';
  return 'running';
}

function spaceDot(id) {
  const list = spaceSessions(id);
  if (list.some((s) => s.status === 'running' && s.working)) return 'working';
  if (list.some((s) => s.unseen)) return 'unseen';
  if (list.some((s) => s.status === 'running')) return 'running';
  return '';
}

function renderSpaces() {
  $('spaces').innerHTML = prefs.spaces
    .map((sp) => {
      const dot = spaceDot(sp.id);
      return `<button class="space ${sp.id === prefs.activeSpace ? 'active' : ''}" data-space="${esc(sp.id)}" title="${esc(
        sp.name
      )}\n${esc(sp.path)}" aria-label="${esc(sp.name)}">${esc(initials(sp.name))}${
        dot ? `<span class="status-dot ${dot}"></span>` : ''
      }</button>`;
    })
    .join('');
}

function selectSpace(id) {
  if (!space(id)) return;
  if (state.activeId) state.activeBySpace[prefs.activeSpace] = state.activeId;
  prefs.activeSpace = id;
  savePrefs();
  const remembered = state.activeBySpace[id];
  const next = spaceSessions(id).find((s) => s.id === remembered) || null;
  state.explorer.root = null;
  selectSession(next ? next.id : null);
  renderSpaces();
  renderHome();
  refreshGit();
  if (prefs.explorerOpen) renderExplorer(true);
}

async function chooseFolder() {
  const defaultPath = space() ? space().path : state.homeCwd;
  try {
    const dir = T.dialog && T.dialog.open
      ? await T.dialog.open({ directory: true, multiple: false, defaultPath })
      : await invoke('plugin:dialog|open', { options: { directory: true, multiple: false, defaultPath } });
    if (dir) addSpace(Array.isArray(dir) ? dir[0] : dir);
  } catch (err) {
    // No native dialog (plugin missing): fall back to typing a path.
    const typed = window.prompt('Folder to open as a space:', defaultPath);
    if (!typed) return;
    try {
      const r = await invoke('list_dir', { path: typed });
      addSpace(r.path);
    } catch (e) {
      toast(String(e), 'error');
    }
  }
}

function spaceMenu(anchor, sp) {
  const n = spaceSessions(sp.id).length;
  openMenu(anchor, {
    title: sp.name,
    items: [
      { label: 'Rename…', run: () => renameSpace(sp) },
      { label: 'Open in…', run: () => openInMenu(anchor, sp.path) },
      { label: 'Copy path', run: () => copy(sp.path) },
      { sep: true },
      {
        label: n ? `Remove space (close ${n} tab${n > 1 ? 's' : ''} first)` : 'Remove space',
        danger: true,
        disabled: n > 0 || prefs.spaces.length < 2,
        run: () => {
          prefs.spaces = prefs.spaces.filter((x) => x.id !== sp.id);
          if (prefs.activeSpace === sp.id) prefs.activeSpace = prefs.spaces[0].id;
          savePrefs();
          selectSpace(prefs.activeSpace);
        }
      }
    ]
  });
}

function renameSpace(sp) {
  const name = window.prompt('Space name:', sp.name);
  if (!name || !name.trim()) return;
  sp.name = name.trim();
  savePrefs();
  renderSpaces();
  renderHome();
}

/* ------------------------------------------------------------------- tabs */

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function tabMeta(s) {
  const a = agent(s.agentId);
  const model = a ? label(a.models, s.modelId) : '';
  let st;
  if (s.status === 'parked') st = 'parked';
  else if (s.status === 'starting') st = 'starting';
  else if (s.status === 'error') st = 'failed';
  else if (s.status === 'exited') st = `exited ${s.exitCode ?? ''}`.trim();
  else st = s.working ? 'working' : fmtElapsed(Date.now() - s.startedAt);
  const dot = sessionDot(s);
  return `${dot ? `<span class="status-dot ${dot}"></span>` : '<span class="status-dot"></span>'}
    <span class="tab-badge">${esc(st)}</span>${model && model !== 'Default' ? `<span>${esc(model)}</span>` : ''}`;
}

function renderTabs() {
  snapshotParked();
  const list = spaceSessions();
  $('tabs').innerHTML = list
    .map((s) => {
      const a = agent(s.agentId);
      return `<div class="tab ${s.id === state.activeId ? 'active' : ''}" data-tab="${s.id}" role="tab" draggable="true"
          aria-selected="${s.id === state.activeId}" title="${esc(s.title)} — ${esc(s.cwd)}">
        <div class="tab-row"><span class="tab-icon">${ICONS[a && a.icon] || ICONS.term}</span>
          <span class="tab-title">${esc(s.title)}</span></div>
        <div class="tab-meta" data-meta="${s.id}">${tabMeta(s)}</div>
        <button class="tab-close" data-close="${s.id}" aria-label="Close ${esc(s.title)}">${ICONS.close}</button>
      </div>`;
    })
    .join('');
  const el = $('tabs').querySelector('.tab.active');
  if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function updateTabMeta(s) {
  const el = $('tabs').querySelector(`[data-meta="${s.id}"]`);
  if (el) el.innerHTML = tabMeta(s);
}

function tabMenu(anchor, s, x, y) {
  const others = spaceSessions().filter((o) => o.id !== s.id);
  openMenu(anchor, {
    at: x != null ? { x, y } : null,
    items: [
      { label: 'Rename…', run: () => renameTab(s) },
      { label: 'Duplicate', run: () => createSession(s.agentId, { modelId: s.modelId, modeId: s.modeId, cwd: s.cwd }) },
      { label: 'Restart', run: () => restartSession(s) },
      { label: 'Copy folder path', run: () => copy(s.cwd) },
      { sep: true },
      { label: 'Close', hint: 'Ctrl+Alt+W', run: () => closeSession(s.id) },
      { label: 'Close other tabs', disabled: !others.length, run: () => others.forEach((o) => closeSession(o.id)) }
    ]
  });
}

function renameTab(s) {
  const el = $('tabs').querySelector(`[data-tab="${s.id}"] .tab-title`);
  if (!el) return;
  const input = document.createElement('input');
  input.className = 'files-search';
  input.style.height = '18px';
  input.value = s.title;
  el.replaceWith(input);
  input.focus();
  input.select();
  const done = (commit) => {
    if (commit && input.value.trim()) s.title = input.value.trim();
    renderTabs();
    renderHead();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(true), { once: true });
}

/* --------------------------------------------------------------- sessions */

/** Materialize a parked snapshot as a session shell. No PTY, no listeners,
 *  until the user clicks Resume. Visuals and tab metadata work from the
 *  snapshot so the workspace reads the same as it did at shutdown. */
function buildParked(sn) {
  const a = agent(sn.agentId);
  if (!a) return null;
  const host = document.createElement('div');
  host.className = 'term-host';
  host.style.visibility = 'hidden';
  $('termHosts').appendChild(host);

  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'DM Mono', ui-monospace, Consolas, monospace",
    fontSize: prefs.fontSize,
    lineHeight: 1.3,
    cursorBlink: false,
    allowProposedApi: true,
    theme: TERM_THEMES[resolvedTheme()],
    scrollback: 10000
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  term.attachCustomKeyEventHandler((e) => !isAppShortcut(e));
  term.writeln('\x1b[38;2;106;106;112mSession from your last run.  Press Resume to launch it again.\x1b[0m');

  const s = {
    id: sn.id || `t${++state.seq}`,
    ptyId: null,
    spaceId: sn.spaceId,
    agentId: sn.agentId,
    modelId: sn.modelId,
    modeId: sn.modeId,
    cwd: sn.cwd,
    title: sn.title,
    status: 'parked',
    exitCode: sn.exitCode,
    startedAt: Date.now(),
    lastOutputAt: 0,
    working: false,
    unseen: false,
    command: '',
    pendingPrompt: '',
    draft: '',
    context: [],
    usage: Usage.createUsageState(),
    pcControl: false,
    term,
    fit,
    host,
    unlisten: []
  };
  // Keep the id generator ahead of any imported id so future tabs don't collide.
  const n = Number(String(s.id).replace(/[^0-9]/g, '')) || 0;
  if (n > state.seq) state.seq = n;
  state.sessions.push(s);

  term.onData((d) => s.ptyId && invoke('send_input', { id: s.ptyId, data: d }).catch(() => {}));
  term.onScroll(() => s.id === state.activeId && updateScrollButton(s));
  return s;
}

async function createSession(agentId, opts = {}) {
  const a = agent(agentId);
  if (!a) return null;
  if (!a.available) {
    toast(`${a.label} is not installed. Point agents.json at its executable, then reload agents.`, 'error');
    return null;
  }
  const p = pick(a);
  const sp = space(opts.spaceId) || space();
  const host = document.createElement('div');
  host.className = 'term-host';
  host.style.visibility = 'hidden';
  $('termHosts').appendChild(host);

  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'DM Mono', ui-monospace, Consolas, monospace",
    fontSize: prefs.fontSize,
    lineHeight: 1.3,
    cursorBlink: true,
    allowProposedApi: true,
    theme: TERM_THEMES[resolvedTheme()],
    scrollback: 10000
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  try {
    term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => T.opener ? T.opener.openUrl(uri) : window.open(uri)));
  } catch {
    /* optional addon */
  }
  term.open(host);
  // Our Ctrl+Alt shortcuts must never be swallowed by the terminal.
  term.attachCustomKeyEventHandler((e) => !isAppShortcut(e));

  const count = state.sessions.filter((x) => x.agentId === agentId).length + 1;
  const s = {
    id: `t${++state.seq}`,
    ptyId: null,
    spaceId: sp.id,
    agentId,
    modelId: opts.modelId || p.model,
    modeId: opts.modeId || p.mode,
    cwd: opts.cwd || sp.path,
    title: opts.title || `${a.label} ${count}`,
    status: 'starting',
    exitCode: null,
    startedAt: Date.now(),
    lastOutputAt: 0,
    working: false,
    unseen: false,
    command: '',
    pendingPrompt: opts.prompt || '',
    draft: '',
    context: [],
    usage: Usage.createUsageState(),
    pcControl: false,
    term,
    fit,
    host,
    unlisten: []
  };
  state.sessions.push(s);

  term.onData((d) => s.ptyId && invoke('send_input', { id: s.ptyId, data: d }).catch(() => {}));
  term.onScroll(() => s.id === state.activeId && updateScrollButton(s));
  term.onTitleChange((t) => {
    // Some CLIs set a meaningful terminal title; adopt it unless renamed.
    if (t && t.trim() && !opts.title && t.length < 80) {
      s.title = t.trim();
      renderTabs();
      if (s.id === state.activeId) renderHead();
    }
  });

  selectSession(s.id);
  requestAnimationFrame(() => launch(s));
  return s;
}

/** Spawn (or respawn) the CLI behind a session. Each launch gets a fresh
 *  pty id so a late exit event from a previous process can't touch it. */
async function launch(s) {
  if (s.ptyId) invoke('set_pc_control', { sessionId: s.ptyId, enabled: false }).catch(() => {});
  for (const un of s.unlisten.splice(0)) safe(un);
  // A relaunch creates a fresh underlying CLI session, so observed metrics
  // must not leak from the prior process into this one.
  s.usage = Usage.createUsageState();
  s.pcControl = false;
  const ptyId = `p${++state.seq}`;
  s.ptyId = ptyId;
  s.status = 'starting';
  s.startedAt = Date.now();
  s.exitCode = null;

  s.unlisten.push(
    await listen(`pty-data:${ptyId}`, (e) => {
      s.term.write(e.payload);
      const usageChanged = Usage.ingest(s.usage, e.payload);
      s.lastOutputAt = Date.now();
      if (!s.working) {
        s.working = true;
        updateTabMeta(s);
        renderSpaces();
        if (s.id === state.activeId) renderStatus();
      }
      if (s.id !== state.activeId || !document.hasFocus()) {
        if (!s.unseen && s.id !== state.activeId) {
          s.unseen = true;
          updateTabMeta(s);
        }
      }
      if (s.id === state.activeId) {
        updateScrollButton(s);
        if (usageChanged) renderStatus();
      }
    })
  );
  s.unlisten.push(
    await listen(`pty-exit:${ptyId}`, (e) => {
      if (s.ptyId !== ptyId) return;
      invoke('set_pc_control', { sessionId: ptyId, enabled: false }).catch(() => {});
      s.pcControl = false;
      // Consent covers one process. Relaunching after an exit asks again.
      s.wantPcControl = false;
      Usage.ingest(s.usage, '', true);
      s.status = 'exited';
      s.exitCode = e.payload;
      s.working = false;
      s.term.write(`\r\n\x1b[38;2;106;106;112m── process exited (code ${e.payload}) ──\x1b[0m\r\n`);
      recordUsage(s);
      updateTabMeta(s);
      renderSpaces();
      if (s.id === state.activeId) {
        renderHead();
        renderStatus();
      } else {
        toast(`${s.title} exited (code ${e.payload})`, e.payload === 0 ? '' : 'error', () => {
          selectSpace(s.spaceId);
          selectSession(s.id);
        });
      }
    })
  );

  try {
    s.fit.fit();
  } catch {
    /* geometry races are retried on resize */
  }
  try {
    const r = await invoke('start_session', {
      id: ptyId,
      agentId: s.agentId,
      modelId: s.modelId,
      modeId: s.modeId,
      cwd: s.cwd,
      cols: s.term.cols,
      rows: s.term.rows,
      pcControl: Boolean(s.wantPcControl)
    });
    s.status = 'running';
    s.command = r.command;
    s.cwd = r.cwd;
    s.pcControl = Boolean(r.pcControl);
    if (s.pendingPrompt) {
      // If the CLI never goes quiet, deliver the first message anyway.
      setTimeout(() => deliverPending(s), 10000);
    }
  } catch (err) {
    s.status = 'error';
    // A failed launch must not leave a pending PC-control request behind.
    s.wantPcControl = false;
    s.term.write(`\r\n\x1b[38;2;231;163;163m${String(err).replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
  }
  updateTabMeta(s);
  renderSpaces();
  if (s.id === state.activeId) {
    renderHead();
    renderStatus();
  }
}

function deliverPending(s) {
  if (!s.pendingPrompt || s.status !== 'running') return;
  const text = s.pendingPrompt;
  s.pendingPrompt = '';
  sendText(s, text);
}

async function restartSession(s, { keepPcControl = false } = {}) {
  // PC-control consent covers one process; only the PC-control chip itself
  // may carry a fresh grant into the next launch.
  if (!keepPcControl) s.wantPcControl = false;
  if (s.ptyId) await invoke('kill_session', { id: s.ptyId }).catch(() => {});
  s.term.write('\r\n\x1b[38;2;106;106;112m── restarting ──\x1b[0m\r\n');
  launch(s);
}

function selectSession(id) {
  const prev = active();
  if (prev) prev.draft = $('ptyInput').value;
  state.activeId = id;
  const s = active();
  if (s) {
    s.unseen = false;
    state.activeBySpace[s.spaceId] = s.id;
  }
  for (const x of state.sessions) x.host.style.visibility = x.id === id ? 'visible' : 'hidden';
  $('ptyInput').value = s ? s.draft : '';
  autoGrow($('ptyInput'));
  renderContext();
  renderTabs();
  renderSpaces();
  renderView();
  if (s) {
    requestAnimationFrame(() => {
      fitSession(s);
      s.term.focus();
      updateScrollButton(s);
    });
  }
}

async function closeSession(id) {
  const i = state.sessions.findIndex((s) => s.id === id);
  if (i === -1) return;
  const s = state.sessions[i];
  if (s.status === 'running') recordUsage(s);
  if (s.ptyId) invoke('set_pc_control', { sessionId: s.ptyId, enabled: false }).catch(() => {});
  if (s.ptyId) invoke('kill_session', { id: s.ptyId }).catch(() => {});
  for (const un of s.unlisten) safe(un);
  s.term.dispose();
  s.host.remove();
  state.sessions.splice(i, 1);

  prefs.closed.unshift({
    agentId: s.agentId,
    modelId: s.modelId,
    modeId: s.modeId,
    cwd: s.cwd,
    spaceId: s.spaceId,
    title: s.title,
    closedAt: Date.now()
  });
  prefs.closed = prefs.closed.slice(0, 25);
  savePrefs();

  if (state.activeId === id) {
    const siblings = spaceSessions(s.spaceId);
    const next = siblings.length ? siblings[Math.min(i, siblings.length - 1)] : null;
    // index above is global; fall back to the last sibling if it overshot
    selectSession(next ? next.id : null);
  } else {
    renderTabs();
    renderSpaces();
  }
}

function reopenClosed(entry) {
  prefs.closed = prefs.closed.filter((c) => c !== entry);
  savePrefs();
  if (entry.spaceId && space(entry.spaceId) && entry.spaceId !== prefs.activeSpace) selectSpace(entry.spaceId);
  createSession(entry.agentId, { modelId: entry.modelId, modeId: entry.modeId, cwd: entry.cwd, title: entry.title });
}

function closedTabsMenu(anchor) {
  openMenu(anchor, {
    title: 'Closed tabs',
    search: 'Search closed tabs',
    empty: 'Nothing closed yet.',
    items: prefs.closed.map((c) => ({
      label: c.title,
      hint: `${basename(c.cwd)} · ${fmtAgo(c.closedAt)}`,
      run: () => reopenClosed(c)
    }))
  });
}

function fitSession(s) {
  if (!s) return;
  try {
    s.fit.fit();
  } catch {
    return;
  }
  if (s.ptyId && s.status === 'running') {
    invoke('resize_session', { id: s.ptyId, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
  }
  if (s.id === state.activeId) renderStatus();
}
const fitActive = () => fitSession(active());

function updateScrollButton(s) {
  const b = s.term.buffer.active;
  $('scrollBottom').hidden = b.viewportY >= b.baseY;
}

/** One-second heartbeat: settles "working" into idle and ticks tab clocks. */
function tick() {
  const now = Date.now();
  let changed = false;
  for (const s of state.sessions) {
    if (s.working && now - s.lastOutputAt > 1500) {
      s.working = false;
      changed = true;
      onIdle(s);
    }
    if (s.status === 'running') updateTabMeta(s);
  }
  if (changed) {
    renderSpaces();
    renderStatus();
  }
}

let gitTimer = 0;
function onIdle(s) {
  // A conservative multi-line summary is held until the terminal goes quiet,
  // so a single labelled value can never be mistaken for complete telemetry.
  Usage.ingest(s.usage, '', true);
  deliverPending(s);
  // The agent probably just edited files; refresh the change count.
  if (s.spaceId === prefs.activeSpace) {
    clearTimeout(gitTimer);
    gitTimer = setTimeout(refreshGit, 400);
  }
}

/* ------------------------------------------------------------------ views */

function renderView() {
  const s = active();
  $('home').classList.toggle('is-hidden', Boolean(s));
  $('workspace').classList.toggle('is-active', Boolean(s));
  renderHead();
  renderStatus();
}

function renderHome() {
  const sp = space();
  const a = agent(prefs.agentId);
  $('homeTitle').textContent = sp ? `What should we work on in ${sp.name}?` : 'What should we work on?';
  $('homeProjectLabel').textContent = sp ? ellipsisLeft(sp.path, 48) : 'Choose a folder';
  if (a) {
    const p = pick(a);
    const caret =
      '<svg class="caret" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m6 9 6 6 6-6"/></svg>';
    const fill = (id, cap, val, show = true) => {
      const el = $(id);
      el.hidden = !show;
      el.innerHTML = `<span class="pill-cap">${cap}</span><span class="pill-val">${esc(val)}</span>${caret}`;
    };
    fill('homeAgent', 'Agent', a.label);
    fill('homeModel', 'Model', label(a.models, p.model), a.models.length > 0);
    fill('homeMode', 'Mode', label(a.modes, p.mode), a.modes.length > 1);
  }

  $('agentStrip').innerHTML = state.agents
    .map(
      (x) => `<button class="agent-option ${x.id === prefs.agentId ? 'selected' : ''}" data-agent="${esc(x.id)}"
        role="radio" aria-checked="${x.id === prefs.agentId}" ${x.available ? '' : 'disabled'}
        title="${esc(x.available ? x.resolved || x.command : `${x.command} was not found on PATH`)}">
        ${ICONS[x.icon] || ICONS.term}<span>${esc(x.label)}</span>${x.available ? '' : '<span class="off">not installed</span>'}
      </button>`
    )
    .join('');

  const prompts = [
    ['Explain this codebase', 'Give me a tour of this project: what it does, how it is laid out, and where to start reading.'],
    ['Review my changes', 'Review my uncommitted changes. Point out bugs, risky edits and anything I forgot.'],
    ['Find and fix a bug', 'Find the most likely bug in this project, explain it, and fix it.'],
    ['Write tests', 'Find the least-tested important code in this project and write tests for it.']
  ];
  $('suggested').innerHTML = prompts
    .map(
      ([t, body], i) => `<button class="suggested-prompt" data-suggest="${i}">
        <span class="suggested-prompt-mark">${ICONS.spark}</span><span><b>${esc(t)}</b>${esc(body)}</span></button>`
    )
    .join('');
  $('suggested').querySelectorAll('[data-suggest]').forEach((b) =>
    b.addEventListener('click', () => {
      $('homeInput').value = prompts[Number(b.dataset.suggest)][1];
      autoGrow($('homeInput'));
      $('homeInput').focus();
    })
  );
}

function renderHead() {
  const s = active();
  if (!s) return;
  const a = agent(s.agentId);
  const dot = sessionDot(s);
  $('headStatus').innerHTML = `<span class="status-dot ${dot}"></span>`;
  $('headTitle').textContent = `${s.title}`;

  const agentEl = $('headAgent');
  if (agentEl) {
    agentEl.hidden = !a;
    agentEl.textContent = a ? a.label : '';
  }

  // Visible model pill in the session head is the quickest way to see
  // which model is actually driving the running process.
  const modelEl = $('headModel');
  if (modelEl) {
    const name = a ? label(a.models, s.modelId) : '';
    modelEl.hidden = !name;
    modelEl.textContent = name;
  }

  const g = state.git[space(s.spaceId) ? space(s.spaceId).path : ''];
  $('headBranch').hidden = !(g && g.repo);
  if (g && g.repo) $('headBranch').innerHTML = `${ICONS.branch}${esc(g.branch)}`;
  $('actStop').disabled = s.status !== 'running';
  const control = $('headControl');
  const supportsPc = Boolean(a && a.pc_control);
  control.disabled = !supportsPc || s.status !== 'running' || !s.ptyId;
  control.classList.toggle('granted', Boolean(s.pcControl));
  control.textContent = s.pcControl ? 'PC control on' : 'PC control off';
  control.title = !supportsPc
    ? `PC control isn't available for ${a ? a.label : 'this agent'} yet`
    : s.pcControl
      ? 'Restart this session without PC control'
      : 'Restart this session with PC control (screenshot)';
  $('actRestart').hidden = s.status === 'parked';
  $('actRestart').textContent = s.status === 'running' ? 'Restart' : 'Relaunch';

  const resume = $('actResume');
  if (resume) {
    resume.hidden = s.status !== 'parked';
  }

  const t = preferredTarget();
  $('openInPrimary').textContent = t ? `Open in ${t.label}` : 'Open';
  $('openInPrimary').disabled = !t;
}

function renderStatus() {
  const s = active();
  const st = $('stState');
  if (!s) {
    st.textContent = 'idle';
    st.className = 'st-state';
    $('stCmd').textContent = space() ? `${spaceSessions().length} tab(s) in ${space().name}` : 'no session';
    $('stCwd').textContent = space() ? space().path : '';
    $('stSize').textContent = '';
    renderLiveUsage(null);
    return;
  }
  const label = s.status === 'running' ? (s.working ? 'working' : 'running') : s.status;
  st.textContent = label;
  st.className = `st-state ${s.status === 'running' ? (s.working ? 'working' : 'running') : s.status === 'error' ? 'error' : ''}`;
  $('stCmd').textContent = s.command || (agent(s.agentId) || {}).command || '';
  $('stCwd').textContent = s.cwd;
  $('stSize').textContent = `${s.term.cols}×${s.term.rows}`;
  renderLiveUsage(s);
}

function renderLiveUsage(s) {
  const strip = $('liveUsage');
  const metrics = $('liveUsageMetrics');
  const announcer = $('usageAnnouncer');
  if (!s || !s.usage) {
    strip.hidden = true;
    metrics.textContent = '';
    announcer.textContent = '';
    return;
  }

  strip.hidden = false;
  const usage = s.usage;
  if (!usage.observed) {
    strip.classList.add('unavailable');
    strip.removeAttribute('title');
    strip.setAttribute('aria-label', 'Usage not reported by this CLI');
    metrics.textContent = 'Not reported by CLI';
    announcer.textContent = '';
    return;
  }

  strip.classList.remove('unavailable');
  const hasTokens = (values) => ['input', 'output', 'cached'].some((key) => values[key] != null);
  const turn = hasTokens(usage.turn) ? Usage.formatTokens(Usage.tokenTotal(usage.turn)) : '—';
  const total = hasTokens(usage.total) ? Usage.formatTokens(Usage.tokenTotal(usage.total)) : '—';
  const field = (key, label, value) =>
    `<span class="live-usage-item" data-usage="${key}"><b>${label}</b>${value}</span>`;
  const cost = usage.total.cost == null ? '' : field('cost', 'cost', Usage.formatCost(usage.total.cost));
  metrics.innerHTML = [
    field('input', 'in', Usage.formatTokens(usage.total.input)),
    field('output', 'out', Usage.formatTokens(usage.total.output)),
    field('cached', 'cache', Usage.formatTokens(usage.total.cached)),
    field('turn', '+turn', turn),
    field('total', 'total', total),
    cost
  ].join('');

  const summary = `Observed session usage: input ${Usage.formatTokens(usage.total.input)} tokens, output ${Usage.formatTokens(usage.total.output)} tokens, cached ${Usage.formatTokens(usage.total.cached)} tokens, current turn ${turn} tokens, session total ${total} tokens${usage.total.cost == null ? '' : `, cost ${Usage.formatCost(usage.total.cost)}`}.`;
  strip.title = summary;
  strip.setAttribute('aria-label', summary);
  if (usage.updatedAt !== usage.announcedAt) {
    announcer.textContent = summary;
    usage.announcedAt = usage.updatedAt;
  }
}

/* ------------------------------------------------------------- composer */

function renderContext() {
  const s = active();
  const box = $('composerContext');
  if (!s || !s.context.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = s.context
    .map(
      (p, i) => `<span class="context-pill" title="${esc(p)}"><span>@${esc(p)}</span>
      <button data-ctx="${i}" aria-label="Remove ${esc(p)}">${ICONS.close}</button></span>`
    )
    .join('');
  box.querySelectorAll('[data-ctx]').forEach((b) =>
    b.addEventListener('click', () => {
      s.context.splice(Number(b.dataset.ctx), 1);
      renderContext();
    })
  );
}

function addToChat(absPath) {
  const s = active();
  if (!s) return toast('Open a session first, then add files to it.');
  const rel = relativeTo(absPath, s.cwd);
  if (!s.context.includes(rel)) s.context.push(rel);
  renderContext();
  $('ptyInput').focus();
}

function relativeTo(p, base) {
  const norm = (x) => String(x).replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(p);
  const b = norm(base);
  if (a.toLowerCase().startsWith(b.toLowerCase() + '/')) return a.slice(b.length + 1);
  return a;
}

/** Type text into a CLI. Multi-line text goes through bracketed paste when
 *  the program asked for it, so a newline doesn't submit half a message. */
function sendText(s, text) {
  if (!s.ptyId) return;
  const multi = /\r|\n/.test(text);
  const bracketed = s.term.modes && s.term.modes.bracketedPasteMode;
  if (multi && bracketed) {
    invoke('send_input', { id: s.ptyId, data: `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~` }).catch(() => {});
    setTimeout(() => invoke('send_input', { id: s.ptyId, data: '\r' }).catch(() => {}), 40);
  } else {
    invoke('send_input', { id: s.ptyId, data: text.replace(/\r?\n/g, ' ') }).catch(() => {});
    setTimeout(() => invoke('send_input', { id: s.ptyId, data: '\r' }).catch(() => {}), 20);
  }
}

function pushHistory(text) {
  const t = text.trim();
  if (!t) return;
  prefs.history = [t, ...prefs.history.filter((h) => h !== t)].slice(0, 100);
  savePrefs();
}

function sendComposer() {
  const el = $('ptyInput');
  const s = active();
  if (!s) return;
  const v = el.value;
  if (!v.trim() && !s.context.length) return;
  if (s.status !== 'running') {
    toast('This session is not running.', 'error', () => restartSession(s));
    return;
  }
  const ctx = s.context.map((p) => `@${p}`).join(' ');
  const text = ctx ? `${ctx} ${v}`.trim() : v;
  pushHistory(v);
  sendText(s, text);
  s.context = [];
  s.draft = '';
  el.value = '';
  histPos = -1;
  autoGrow(el);
  renderContext();
}

let histPos = -1;
function walkHistory(el, dir) {
  if (!prefs.history.length) return false;
  const next = histPos + dir;
  if (next < -1 || next >= prefs.history.length) return false;
  histPos = next;
  el.value = histPos === -1 ? '' : prefs.history[histPos];
  autoGrow(el);
  el.setSelectionRange(el.value.length, el.value.length);
  return true;
}

function historyMenu(anchor) {
  openMenu(anchor, {
    title: 'Prompt history',
    search: 'Search history',
    empty: 'No prompts sent yet.',
    items: prefs.history.map((h) => ({
      label: h.replace(/\s+/g, ' ').slice(0, 120),
      run: () => {
        $('ptyInput').value = h;
        autoGrow($('ptyInput'));
        $('ptyInput').focus();
      }
    }))
  });
}

/* --------------------------------------------------------------- explorer */

function setExplorerOpen(open, { quiet = false } = {}) {
  prefs.explorerOpen = open;
  savePrefs();
  $('explorer').hidden = !open;
  $('explorerToggle').classList.toggle('on', open);
  document.querySelector('.main').classList.toggle('explorer-docked', open);
  if (open && !quiet) renderExplorer(true);
  if (open && quiet) renderExplorer(true);
  requestAnimationFrame(fitActive);
}

function applyExplorerWidth() {
  document.querySelector('.main').style.setProperty('--explorer-width', `${prefs.explorerWidth}px`);
}

function explorerRoot() {
  const s = active();
  return s ? s.cwd : space() ? space().path : state.homeCwd;
}

function renderExplorer(reset = false) {
  if (!prefs.explorerOpen) return;
  const ex = state.explorer;
  const root = explorerRoot();
  if (reset || ex.root !== root) {
    if (ex.root !== root) {
      ex.expanded = new Set();
      ex.cache = new Map();
      ex.filter = '';
    }
    ex.root = root;
    ex.view = 'list';
  }
  document.querySelectorAll('[data-xtab]').forEach((t) => t.classList.toggle('active', t.dataset.xtab === prefs.explorerTab));
  if (ex.view === 'file') return renderFileView();
  if (ex.view === 'diff') return renderDiffView();
  if (prefs.explorerTab === 'files') renderFiles();
  else renderChanges();
}

async function loadDir(path) {
  const ex = state.explorer;
  if (ex.cache.has(path)) return ex.cache.get(path);
  const data = await invoke('list_dir', { path });
  ex.cache.set(path, data.entries);
  return data.entries;
}

const NOISE = new Set(['.git', 'node_modules', 'target', '.next', 'dist', '__pycache__', '.venv']);

async function renderFiles() {
  const ex = state.explorer;
  const box = $('explorerContent');
  if (!box.querySelector('.files-search')) {
    box.innerHTML = `<div class="files-toolbar"><input class="files-search" id="fileFilter" placeholder="Filter files" aria-label="Filter files" /></div>
      <div class="crumbs" id="fileCrumbs"></div><ul class="explorer-list" id="fileList"><li class="explorer-empty">Loading files…</li></ul>`;
    const f = $('fileFilter');
    f.value = ex.filter;
    f.addEventListener('input', () => {
      ex.filter = f.value;
      drawFileRows();
    });
  }
  $('fileCrumbs').textContent = ex.root;
  try {
    await loadDir(ex.root);
    for (const d of ex.expanded) await loadDir(d).catch(() => ex.expanded.delete(d));
  } catch (err) {
    $('fileList').innerHTML = `<li class="explorer-empty"><b>Couldn’t list files</b>${esc(String(err))}</li>`;
    return;
  }
  drawFileRows();
}

function drawFileRows() {
  const ex = state.explorer;
  const list = $('fileList');
  if (!list) return;
  const rows = [];
  const q = ex.filter.trim().toLowerCase();
  if (q) {
    // Search everything loaded so far (the root plus expanded folders).
    for (const [, entries] of ex.cache) {
      for (const e of entries) if (e.name.toLowerCase().includes(q)) rows.push({ e, depth: 0, rel: relativeTo(e.path, ex.root) });
    }
    rows.sort((a, b) => a.rel.localeCompare(b.rel));
  } else {
    const walk = (dir, depth) => {
      for (const e of ex.cache.get(dir) || []) {
        rows.push({ e, depth });
        if (e.dir && ex.expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    walk(ex.root, 0);
  }
  if (!rows.length) {
    list.innerHTML = `<li class="explorer-empty">${q ? 'No loaded files match. Expand folders to search inside them.' : 'Empty folder.'}</li>`;
    return;
  }
  list.innerHTML = rows
    .slice(0, 3000)
    .map(({ e, depth, rel }) => {
      const open = e.dir && ex.expanded.has(e.path);
      const name = rel
        ? `<span class="dir-part">${esc(rel.slice(0, rel.length - e.name.length))}</span>${esc(e.name)}`
        : esc(e.name);
      return `<li><button class="file-row ${open ? 'open' : ''}" style="--depth:${depth}" data-path="${esc(e.path)}" data-dir="${e.dir ? 1 : 0}">
        <span class="twisty">${e.dir ? ICONS.twisty : ''}</span>
        <span class="ico">${e.dir ? ICONS.folder : ICONS.file}</span>
        <span class="name ${NOISE.has(e.name) ? 'dir-part' : ''}">${name}</span>
        ${e.dir ? '' : `<span class="meta">${fmtSize(e.size)}</span>`}</button></li>`;
    })
    .join('');
}

async function toggleDir(path) {
  const ex = state.explorer;
  if (ex.expanded.has(path)) ex.expanded.delete(path);
  else {
    try {
      await loadDir(path);
      ex.expanded.add(path);
    } catch (err) {
      return toast(String(err), 'error');
    }
  }
  drawFileRows();
}

async function renderFileView() {
  const ex = state.explorer;
  const box = $('explorerContent');
  box.innerHTML = viewerHead(ex.file, true) + '<pre class="code-view numbered" id="codeView"><span class="ln">Loading file…</span></pre>';
  wireViewerHead(ex.file);
  let data;
  try {
    data = await invoke('read_file', { path: ex.file });
  } catch (err) {
    $('codeView').innerHTML = `<span class="ln">Couldn’t open this file: ${esc(String(err))}</span>`;
    return;
  }
  if (data.binary) {
    $('codeView').classList.remove('numbered');
    $('codeView').innerHTML = '<span class="ln">Binary file.</span>';
    return;
  }
  const lines = data.text.split('\n');
  $('codeView').innerHTML = lines.map((l) => `<span class="ln">${esc(l) || ' '}</span>`).join('');
  if (data.truncated) box.insertAdjacentHTML('beforeend', `<div class="code-note">Showing the first 256 KB of ${fmtSize(data.size)}.</div>`);
}

function viewerHead(path, canAdd) {
  return `<div class="viewer-head">
    <button class="head-icon" id="viewerBack" aria-label="Back">${ICONS.back}</button>
    <span class="path" title="${esc(path)}">${esc(relativeTo(path, state.explorer.root))}</span>
    ${canAdd ? '<button class="btn" id="viewerAdd" title="Mention this file in your next message">Add to chat</button>' : ''}
  </div>`;
}
function wireViewerHead(path) {
  $('viewerBack').addEventListener('click', () => {
    state.explorer.view = 'list';
    renderExplorer();
  });
  const add = $('viewerAdd');
  if (add) add.addEventListener('click', () => addToChat(path));
}

async function refreshGit() {
  const sp = space();
  if (!sp) return;
  let g;
  try {
    g = await invoke('git_status', { path: active() ? active().cwd : sp.path });
  } catch {
    g = { repo: false, reason: 'Could not run git.' };
  }
  state.git[sp.path] = g;
  const n = g.repo ? g.files.length : 0;
  $('changesCount').hidden = !n;
  $('changesCount').textContent = n;
  $('explorerDot').hidden = !n || prefs.explorerOpen;
  renderHead();
  if (prefs.explorerOpen && prefs.explorerTab === 'changes' && state.explorer.view === 'list') renderChanges(true);
}

function changeKind(f) {
  if (f.untracked) return ['U', 'added'];
  const c = f.code.trim();
  if (c.includes('D')) return ['D', 'deleted'];
  if (c.includes('A')) return ['A', 'added'];
  if (c.includes('R')) return ['R', 'modified'];
  return ['M', 'modified'];
}

async function renderChanges(fromCache = false) {
  const box = $('explorerContent');
  const sp = space();
  if (!fromCache) {
    box.innerHTML = '<div class="explorer-empty">Loading changes…</div>';
    await refreshGit();
    return;
  }
  const g = state.git[sp.path];
  if (!g) return;
  if (!g.repo) {
    box.innerHTML = `<div class="explorer-empty"><b>No repository</b>${esc(g.reason || 'This folder is not a git repository.')}</div>`;
    return;
  }
  if (!g.files.length) {
    box.innerHTML = `<div class="crumbs">${esc(g.branch)} · ${esc(g.root)}</div><div class="explorer-empty"><b>No changes</b>Working tree clean.</div>`;
    return;
  }
  const add = g.files.reduce((n, f) => n + (f.added || 0), 0);
  const del = g.files.reduce((n, f) => n + (f.removed || 0), 0);
  box.innerHTML = `<div class="files-toolbar"><span class="head-branch">${ICONS.branch}${esc(g.branch)}</span><span class="grow"></span>
      <span class="meta">${g.files.length} file${g.files.length > 1 ? 's' : ''} · <span class="num-add">+${add}</span> <span class="num-del">−${del}</span></span></div>
    <ul class="explorer-list">${g.files
      .map((f) => {
        const [code, kind] = changeKind(f);
        const name = basename(f.file);
        const dir = f.file.slice(0, f.file.length - name.length);
        const nums =
          f.added != null ? `<span class="meta"><span class="num-add">+${f.added}</span> <span class="num-del">−${f.removed}</span></span>` : '';
        return `<li><button class="file-row" data-file="${esc(f.file)}" data-untracked="${f.untracked ? 1 : 0}" title="${esc(f.file)}">
          <span class="change-status ${kind}">${code}</span>
          <span class="name"><span class="dir-part">${esc(dir)}</span>${esc(name)}</span>${nums}</button></li>`;
      })
      .join('')}</ul>`;
}

async function renderDiffView() {
  const ex = state.explorer;
  const g = state.git[space().path];
  const abs = g && g.root ? `${g.root}/${ex.diff.file}` : ex.diff.file;
  const box = $('explorerContent');
  box.innerHTML = viewerHead(abs, true) + '<pre class="code-view" id="codeView"><span class="ln">Loading diff…</span></pre>';
  wireViewerHead(abs);
  let data;
  try {
    data = await invoke('git_diff', { path: g ? g.root : explorerRoot(), file: ex.diff.file, untracked: ex.diff.untracked });
  } catch (err) {
    $('codeView').innerHTML = `<span class="ln">${esc(String(err))}</span>`;
    return;
  }
  if (!data.diff) {
    $('codeView').innerHTML = `<span class="ln">${esc(data.note || 'No changes to show.')}</span>`;
    return;
  }
  $('codeView').innerHTML = data.diff
    .split('\n')
    .map((line) => {
      let cls = '';
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) cls = 'd-meta';
      else if (line.startsWith('+')) cls = 'd-add';
      else if (line.startsWith('-')) cls = 'd-del';
      else if (line.startsWith('@@')) cls = 'd-hunk';
      return `<span class="ln ${cls}">${esc(line) || ' '}</span>`;
    })
    .join('');
}

function startExplorerResize(e) {
  e.preventDefault();
  const main = document.querySelector('.main');
  const rect = main.getBoundingClientRect();
  document.body.classList.add('resizing-pane');
  let raf = 0;
  const move = (ev) => {
    const w = Math.round(Math.min(Math.max(rect.right - ev.clientX, 260), rect.width - 320));
    prefs.explorerWidth = w;
    applyExplorerWidth();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(fitActive);
  };
  const up = () => {
    document.body.classList.remove('resizing-pane');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    savePrefs();
    fitActive();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/* --------------------------------------------------------------- open in */

function preferredTarget() {
  return (
    state.openTargets.find((t) => t.id === prefs.openTarget) ||
    state.openTargets.find((t) => !['files', 'terminal'].includes(t.id)) ||
    state.openTargets[0] ||
    null
  );
}

async function openIn(targetId, path) {
  try {
    await invoke('open_in', { target: targetId, path });
    prefs.openTarget = targetId;
    savePrefs();
    renderHead();
  } catch (err) {
    toast(String(err), 'error');
  }
}

function openInMenu(anchor, path) {
  const cur = preferredTarget();
  openMenu(anchor, {
    title: 'Open in',
    items: state.openTargets.map((t) => ({ label: t.label, on: cur && t.id === cur.id, run: () => openIn(t.id, path) }))
  });
}

/* ------------------------------------------------------------------ menus */

/**
 * items: [{ label, hint, on, disabled, danger, run } | { sep: true }]
 * opts: { title, search (placeholder), empty, at: {x, y} }
 */
function openMenu(anchor, { title, items, search, empty, at } = {}) {
  const menu = $('menu');
  const draw = (q = '') => {
    const shown = items.filter((it) => it.sep || !q || it.label.toLowerCase().includes(q) || (it.hint || '').toLowerCase().includes(q));
    const real = shown.filter((it) => !it.sep);
    menu.querySelector('.menu-items').innerHTML = real.length
      ? shown
          .map((it) =>
            it.sep
              ? '<div class="menu-sep"></div>'
              : `<button class="header-menu-item ${it.on ? 'on' : ''} ${it.danger ? 'danger' : ''}" data-i="${items.indexOf(it)}" ${
                  it.disabled ? 'disabled' : ''
                } role="menuitem"><span class="header-menu-check">${ICONS.check}</span><span class="label">${esc(it.label)}</span>${
                  it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ''
                }</button>`
          )
          .join('')
      : `<div class="menu-empty">${esc(empty || 'Nothing here.')}</div>`;
  };
  menu.innerHTML =
    (title ? `<div class="menu-head">${esc(title)}</div>` : '') +
    (search && items.length ? `<input class="menu-search" placeholder="${esc(search)}" aria-label="${esc(search)}" />` : '') +
    '<div class="menu-items"></div>';
  draw();
  menu.hidden = false;
  $('scrim').hidden = false;

  const r = at ? { left: at.x, bottom: at.y, right: at.x } : anchor.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 10);
  const top = r.bottom + 6 + menu.offsetHeight > window.innerHeight ? Math.max(8, r.bottom - menu.offsetHeight - (at ? 0 : 40)) : r.bottom + 6;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  menu.onclick = (e) => {
    const b = e.target.closest('[data-i]');
    if (!b || b.disabled) return;
    const it = items[Number(b.dataset.i)];
    closeMenu();
    it.run && it.run();
  };
  const input = menu.querySelector('.menu-search');
  if (input) {
    input.focus();
    input.addEventListener('input', () => draw(input.value.trim().toLowerCase()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = menu.querySelector('[data-i]:not([disabled])');
        if (first) first.click();
      }
    });
  }
}
function closeMenu() {
  $('menu').hidden = true;
  $('scrim').hidden = true;
  $('menu').onclick = null;
}

function agentMenu(anchor) {
  const items = [];
  for (const a of state.agents) {
    if (items.length) items.push({ sep: true });
    const p = pick(a);
    if (a.models.length < 2) {
      items.push({
        label: a.label,
        hint: a.available ? '' : 'not installed',
        on: a.id === prefs.agentId,
        disabled: !a.available,
        run: () => chooseAgent(a.id)
      });
      continue;
    }
    for (const m of a.models) {
      items.push({
        label: `${a.label} · ${m.label}`,
        hint: a.available ? '' : 'not installed',
        on: a.id === prefs.agentId && p.model === m.id,
        disabled: !a.available,
        run: () => {
          pick(a).model = m.id;
          chooseAgent(a.id);
        }
      });
    }
  }
  openMenu(anchor, { title: 'Agent and model', items });
}

function modeMenu(anchor) {
  const a = agent(prefs.agentId);
  if (!a) return;
  const p = pick(a);
  openMenu(anchor, {
    title: 'Mode',
    items: a.modes.map((m) => ({
      label: m.label,
      on: m.id === p.mode,
      run: () => {
        p.mode = m.id;
        savePrefs();
        renderHome();
      }
    }))
  });
}

/** Model picker for the currently selected agent. Lives on its own on the
 *  home screen (next to the agent pill) so changing model takes one click,
 *  not a submenu dive. */
function modelMenu(anchor, forAgent) {
  const a = forAgent || agent(prefs.agentId);
  if (!a) return;
  const p = pick(a);
  openMenu(anchor, {
    title: `${a.label} · Model`,
    items: a.models.map((m) => ({
      label: m.label,
      on: m.id === p.model,
      run: () => {
        p.model = m.id;
        savePrefs();
        renderHome();
      }
    }))
  });
}

/** Agent-only picker. Models get their own menu (modelMenu) now. */
function agentOnlyMenu(anchor) {
  openMenu(anchor, {
    title: 'Agent',
    items: state.agents.map((a) => ({
      label: a.label,
      hint: a.available ? '' : 'not installed',
      on: a.id === prefs.agentId,
      disabled: !a.available,
      run: () => chooseAgent(a.id)
    }))
  });
}

function chooseAgent(id) {
  prefs.agentId = id;
  savePrefs();
  renderHome();
}

/** Switch a session to a different installed CLI. A running CLI must be
 * relaunched because processes cannot change their executable in place. */
async function switchSessionAgent(s, id) {
  const next = agent(id);
  if (!s || !next || !next.available || next.id === s.agentId) return;
  const running = s.status === 'running' || s.status === 'starting';
  if (running) {
    const ok = await confirmDialog(
      `Switch to ${next.label}?`,
      'The current CLI process will stop and this session will relaunch with the selected backend.',
      'Switch and relaunch'
    );
    if (!ok) return;
  }

  if (s.ptyId) await invoke('kill_session', { id: s.ptyId }).catch(() => {});
  const p = pick(next);
  s.agentId = next.id;
  s.modelId = p.model;
  s.modeId = p.mode;
  s.command = '';
  s.working = false;
  if (s.status === 'parked') {
    renderAll();
    snapshotParked();
    return;
  }

  s.term.writeln(`\r\n\x1b[38;2;106;106;112m── switching to ${next.label} ──\x1b[0m\r\n`);
  launch(s);
}

function projectMenu(anchor) {
  openMenu(anchor, {
    title: 'Space',
    items: [
      ...prefs.spaces.map((sp) => ({ label: sp.name, hint: ellipsisLeft(sp.path, 34), on: sp.id === prefs.activeSpace, run: () => selectSpace(sp.id) })),
      { sep: true },
      { label: 'Open folder…', run: chooseFolder }
    ]
  });
}

/* ----------------------------------------------------------- toasts, dialogs */

function toast(msg, kind = '', onClick) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  el.addEventListener('click', () => {
    el.remove();
    onClick && onClick();
  });
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

function renderUsage() {
  const rows = state.agents.map((a) => {
    const live = state.sessions.filter((s) => s.agentId === a.id && s.status === 'running').length;
    const u = prefs.usage[a.id] || { sessions: 0, seconds: 0, lastAt: 0 };
    return { agent: a, live, past: u.sessions, seconds: u.seconds, lastAt: u.lastAt };
  });
  const fmtHMS = (s) => {
    if (!s) return '—';
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  };
  $('usageTable').innerHTML = `
    <div class="usage-row usage-head">
      <span>Agent</span><span>Live</span><span>Past</span><span>Active time</span><span>Last used</span>
    </div>
    ${rows
      .map(
        (r) => `<div class="usage-row">
          <span class="usage-agent">${ICONS[r.agent.icon] || ICONS.term}${esc(r.agent.label)}</span>
          <span>${r.live || '—'}</span>
          <span>${r.past || '—'}</span>
          <span>${fmtHMS(r.seconds)}</span>
          <span>${r.lastAt ? fmtAgo(r.lastAt) : '—'}</span>
        </div>`
      )
      .join('')}`;
}

/* ---------------------------------------------------------- local imports */

function showImportSheet() {
  const sheet = $('importSheet');
  if (!sheet.open) sheet.showModal();
  refreshImports();
}

async function refreshImports() {
  const refresh = $('refreshImports');
  refresh.disabled = true;
  refresh.textContent = 'Scanning local chats…';
  try {
    state.imports.catalog = await invoke('list_imports');
    state.imports.selected = null;
    renderImportCatalog();
    renderImportPreview();
  } catch (err) {
    $('importList').innerHTML = `<p class="note import-empty">${esc(String(err))}</p>`;
    $('importSources').textContent = '';
  } finally {
    refresh.disabled = false;
    refresh.textContent = 'Refresh local chats';
  }
}

function renderImportCatalog() {
  const catalog = state.imports.catalog;
  if (!catalog) return;
  $('importSources').innerHTML = catalog.sources
    .map(
      (source) => `<div class="import-source ${source.available ? 'available' : ''}">
        <b>${esc(source.label)}</b><span>${esc(source.detail)}</span>
      </div>`
    )
    .join('');
  if (!catalog.conversations.length) {
    $('importList').innerHTML = '<p class="note import-empty">No recognized local conversations were found. Unsupported or malformed files are left untouched.</p>';
    return;
  }
  $('importList').innerHTML = catalog.conversations
    .map(
      (chat) => `<button type="button" class="import-row" role="option" aria-selected="false" data-import-chat="${esc(chat.id)}">
        <b>${esc(chat.title)}</b>
        <span>${esc(chat.source)} · ${esc(chat.project)} · ${chat.messageCount} message${chat.messageCount === 1 ? '' : 's'}${chat.truncated ? ' · partial' : ''}</span>
      </button>`
    )
    .join('');
}

async function openImportedChat(id) {
  try {
    state.imports.selected = await invoke('read_imported_chat', { id });
    $('importList').querySelectorAll('[data-import-chat]').forEach((row) => {
      row.classList.toggle('selected', row.dataset.importChat === id);
      row.setAttribute('aria-selected', String(row.dataset.importChat === id));
    });
    renderImportPreview();
  } catch (err) {
    toast(String(err), 'error');
  }
}

function renderImportPreview() {
  const chat = state.imports.selected;
  const preview = $('importPreview');
  if (!chat) {
    preview.innerHTML = '<p class="note">Choose a conversation to preview it here.</p>';
    return;
  }
  const visible = chat.messages.slice(0, 120);
  preview.innerHTML = `
    <header class="import-preview-head">
      <h3>${esc(chat.title)}</h3>
      <p>${esc(chat.source)} · ${esc(chat.project)} · ${chat.messages.length} message${chat.messages.length === 1 ? '' : 's'}${chat.truncated ? ' · partial import' : ''}</p>
    </header>
    <p class="note import-readonly">Read-only preview. Starting a fresh session does not attach this transcript as context.</p>
    <div class="import-messages">${visible
      .map(
        (message) => `<article class="import-message ${message.role === 'user' ? 'user' : 'assistant'}">
          <h4>${message.role === 'user' ? 'You' : 'Assistant'}</h4><pre>${esc(message.content)}</pre>
        </article>`
      )
      .join('')}${chat.messages.length > visible.length ? '<p class="note import-more">Preview limited to the first 120 imported messages.</p>' : ''}</div>`;
}

function backendFacts(report) {
  if (!report) return ['Could not check your installed backends. You can choose one from the home screen.'];
  const facts = [];
  if (report.claudeCli) facts.push('Claude Code found on PATH');
  if (report.codexCli) facts.push('Codex found on PATH');
  if (report.chatgptCli) facts.push('ChatGPT CLI found on PATH');
  if (report.claudeSignin) facts.push('Claude sign-in detected');
  if (report.anthropicKey) facts.push('Anthropic API key configured');
  if (report.openaiKey) facts.push('OpenAI API key configured');
  return facts.length ? facts : ['No supported CLI or configured sign-in was detected yet.'];
}

function renderOnboarding() {
  const report = state.backends;
  const recommended = report && agent(report.recommended);
  $('onboardingSummary').textContent = recommended && recommended.available
    ? `${recommended.label} is the recommended starting backend for this computer.`
    : 'Choose a local CLI when you are ready. You can change it for each session.';
  $('backendFacts').innerHTML = backendFacts(report).map((fact) => `<li>${esc(fact)}</li>`).join('');
  $('backendChoices').innerHTML = state.agents
    .map((a) => {
      const selected = a.id === prefs.agentId;
      const recommendedClass = recommended && a.id === recommended.id ? ' recommended' : '';
      return `<button class="backend-choice${selected ? ' selected' : ''}${recommendedClass}" data-onboarding-agent="${esc(a.id)}"
        role="radio" aria-checked="${selected}" ${a.available ? '' : 'disabled'}>
        <span class="backend-choice-main">${ICONS[a.icon] || ICONS.term}<span>${esc(a.label)}</span></span>
        <span class="backend-choice-status">${a.available ? (recommended && a.id === recommended.id ? 'Recommended' : 'Installed') : 'Not installed'}</span>
      </button>`;
    })
    .join('');
}

function finishOnboarding() {
  prefs.onboarded = true;
  savePrefs();
  if ($('onboardingSheet').open) $('onboardingSheet').close();
}

function showOnboarding() {
  if (prefs.onboarded) return;
  renderOnboarding();
  // It is a modeless dialog by design: users can start working immediately
  // instead of being forced through setup before they reach a real terminal.
  $('onboardingSheet').show();
}

function confirmDialog(title, body, okLabel = 'Confirm') {
  const d = $('confirmSheet');
  $('confirmTitle').textContent = title;
  $('confirmBody').textContent = body;
  $('confirmOk').textContent = okLabel;
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Could not copy to the clipboard.', 'error');
  }
}

/** Open a URL in the user's real browser via the Tauri opener plugin. */
function openUrl(url) {
  if (!/^https?:\/\//i.test(url)) return;
  try {
    (T.opener && T.opener.openUrl ? T.opener.openUrl(url) : invoke('plugin:opener|open_url', { url })).catch(() =>
      toast('Could not open the link.', 'error')
    );
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

/* ---------------------------------------------------------- zoom and fonts */

function applyZoom() {
  try {
    T.webview.getCurrentWebview().setZoom(prefs.zoom);
  } catch {
    /* older runtime without webview zoom */
  }
  setTimeout(fitActive, 60);
}
function zoomBy(d) {
  prefs.zoom = d === 0 ? 1 : Math.min(2, Math.max(0.6, Math.round((prefs.zoom + d) * 10) / 10));
  savePrefs();
  applyZoom();
  toast(`Zoom ${Math.round(prefs.zoom * 100)}%`);
}
function setFontSize(n) {
  prefs.fontSize = Math.min(24, Math.max(9, n));
  savePrefs();
  $('fontSizeLabel').textContent = `${prefs.fontSize} px`;
  for (const s of state.sessions) {
    s.term.options.fontSize = prefs.fontSize;
  }
  requestAnimationFrame(() => state.sessions.forEach(fitSession));
}

/* ----------------------------------------------------------------- window */

let closing = false;
async function guardClose(event) {
  if (closing) return;
  let live = 0;
  try {
    live = await invoke('running_sessions');
  } catch {
    live = state.sessions.filter((s) => s.status === 'running').length;
  }
  if (live > 0) {
    const ok = await confirmDialog(
      'Quit ezCLI?',
      `${live} session${live > 1 ? 's are' : ' is'} still running. Quitting stops ${live > 1 ? 'them' : 'it'}.`,
      'Quit'
    );
    if (!ok) {
      event.preventDefault();
      return;
    }
  }
  closing = true;
  for (const s of state.sessions) if (s.ptyId) await invoke('kill_session', { id: s.ptyId }).catch(() => {});
}

async function syncMaxIcon() {
  try {
    const max = await T.window.getCurrentWindow().isMaximized();
    $('winMax').innerHTML = max
      ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2.5" y="4" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 4V3a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5H8" stroke="currentColor" stroke-width="1.2"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2.5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>';
    $('winMax').setAttribute('aria-label', max ? 'Restore window' : 'Maximize window');
  } catch {
    /* window API unavailable */
  }
}

/* --------------------------------------------------------------- shortcuts */

function isAppShortcut(e) {
  if (e.type !== 'keydown' || !(e.ctrlKey && e.altKey) || e.metaKey) return false;
  // AltGr reports as Ctrl+Alt on Windows; it types characters, never shortcuts.
  if (e.getModifierState && e.getModifierState('AltGraph')) return false;
  return /^(Key[NWBKT]|Digit[1-9]|ArrowLeft|ArrowRight|Slash|Equal|Minus|Digit0|NumpadAdd|NumpadSubtract|Numpad0)$/.test(e.code);
}

function onShortcut(e) {
  if (!isAppShortcut(e)) return;
  const code = e.code;
  const list = spaceSessions();
  const idx = list.findIndex((s) => s.id === state.activeId);
  let handled = true;
  if (code === 'KeyT' && e.shiftKey) {
    if (prefs.closed[0]) reopenClosed(prefs.closed[0]);
  } else if (e.shiftKey) handled = false;
  else if (code === 'KeyN') newSession();
  else if (code === 'KeyW') state.activeId && closeSession(state.activeId);
  else if (code === 'KeyB') setExplorerOpen(!prefs.explorerOpen);
  else if (code === 'KeyK') active() && active().term.clear();
  else if (code === 'Slash') (active() ? $('ptyInput') : $('homeInput')).focus();
  else if (code === 'Equal' || code === 'NumpadAdd') zoomBy(0.1);
  else if (code === 'Minus' || code === 'NumpadSubtract') zoomBy(-0.1);
  else if (code === 'Digit0' || code === 'Numpad0') zoomBy(0);
  else if (code === 'ArrowLeft' && list.length) selectSession(list[(idx - 1 + list.length) % list.length].id);
  else if (code === 'ArrowRight' && list.length) selectSession(list[(idx + 1) % list.length].id);
  else if (/^Digit[1-9]$/.test(code)) {
    const s = list[Number(code.slice(5)) - 1];
    if (s) selectSession(s.id);
  } else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function newSession() {
  // A new tab always opens on the home screen of the current space, so the
  // agent, model and first message can be picked before anything launches.
  selectSession(null);
  $('homeInput').focus();
}

function startFromHome() {
  const prompt = $('homeInput').value.trim();
  if (prompt) pushHistory(prompt);
  createSession(prefs.agentId, { prompt });
  $('homeInput').value = '';
  autoGrow($('homeInput'));
}

/* ----------------------------------------------------------------- helpers */

function safe(fn) {
  try {
    fn();
  } catch {
    /* ignore */
  }
}
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtAgo(t) {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function ellipsisLeft(s, max) {
  s = String(s);
  return s.length > max ? '…' + s.slice(-(max - 1)) : s;
}
function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

/* ------------------------------------------------------------------ wiring */

function wire() {
  window.addEventListener('keydown', onShortcut, true);
  $('scrim').addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('menu').hidden) closeMenu();
  });

  // window chrome
  const win = T.window.getCurrentWindow();
  $('winMin').addEventListener('click', () => win.minimize());
  $('winMax').addEventListener('click', () => win.toggleMaximize());
  $('winClose').addEventListener('click', () => win.close());
  win.onCloseRequested(guardClose);
  win.onResized(() => {
    syncMaxIcon();
    fitActive();
  });
  syncMaxIcon();

  // titlebar
  $('brandBtn').addEventListener('click', newSession);
  $('tabNew').addEventListener('click', newSession);
  $('closedTabsBtn').addEventListener('click', (e) => closedTabsMenu(e.currentTarget));
  $('explorerToggle').addEventListener('click', () => setExplorerOpen(!prefs.explorerOpen));

  const tabs = $('tabs');
  tabs.addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) return closeSession(close.dataset.close);
    const t = e.target.closest('[data-tab]');
    if (t) selectSession(t.dataset.tab);
  });
  tabs.addEventListener('auxclick', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t && e.button === 1) closeSession(t.dataset.tab);
  });
  tabs.addEventListener('dblclick', (e) => {
    const t = e.target.closest('[data-tab]');
    const s = t && state.sessions.find((x) => x.id === t.dataset.tab);
    if (s) renameTab(s);
  });
  tabs.addEventListener('contextmenu', (e) => {
    const t = e.target.closest('[data-tab]');
    const s = t && state.sessions.find((x) => x.id === t.dataset.tab);
    if (!s) return;
    e.preventDefault();
    tabMenu(t, s, e.clientX, e.clientY);
  });
  // drag to reorder
  let dragId = null;
  tabs.addEventListener('dragstart', (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    dragId = t.dataset.tab;
    t.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  tabs.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    tabs.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
    const t = e.target.closest('[data-tab]');
    if (t && t.dataset.tab !== dragId) t.classList.add('drop-before');
  });
  tabs.addEventListener('drop', (e) => {
    e.preventDefault();
    const t = e.target.closest('[data-tab]');
    if (dragId && t && t.dataset.tab !== dragId) {
      const from = state.sessions.findIndex((s) => s.id === dragId);
      const [moved] = state.sessions.splice(from, 1);
      const to = state.sessions.findIndex((s) => s.id === t.dataset.tab);
      state.sessions.splice(to, 0, moved);
    }
  });
  tabs.addEventListener('dragend', () => {
    dragId = null;
    renderTabs();
  });

  // rail
  $('spaces').addEventListener('click', (e) => {
    const b = e.target.closest('[data-space]');
    if (b) selectSpace(b.dataset.space);
  });
  $('spaces').addEventListener('contextmenu', (e) => {
    const b = e.target.closest('[data-space]');
    if (!b) return;
    e.preventDefault();
    spaceMenu(b, space(b.dataset.space));
  });
  $('spaceAdd').addEventListener('click', chooseFolder);
  $('settingsBtn').addEventListener('click', () => {
    $('fontSizeLabel').textContent = `${prefs.fontSize} px`;
    $('agentsPath').textContent = state.configPath || '~/.ezcli/agents.json';
    applyTheme();
    $('settingsSheet').showModal();
  });
  $('helpBtn').addEventListener('click', () => $('helpSheet').showModal());

  // First-run setup is deliberately optional. Closing with Escape counts as
  // a dismissal so we never interrupt a returning user with the same dialog.
  $('onboardingSheet').addEventListener('close', () => {
    if (!prefs.onboarded) {
      prefs.onboarded = true;
      savePrefs();
    }
  });
  $('onboardingSkip').addEventListener('click', finishOnboarding);
  $('onboardingContinue').addEventListener('click', finishOnboarding);
  $('backendChoices').addEventListener('click', (e) => {
    const choice = e.target.closest('[data-onboarding-agent]');
    if (!choice || choice.disabled) return;
    chooseAgent(choice.dataset.onboardingAgent);
    renderOnboarding();
  });
  $('backendChoices').addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) return;
    const choices = [...$('backendChoices').querySelectorAll('[data-onboarding-agent]:not(:disabled)')];
    const current = choices.indexOf(e.target.closest('[data-onboarding-agent]'));
    if (current < 0 || !choices.length) return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    const next = choices[(current + step + choices.length) % choices.length];
    next.focus();
    next.click();
  });

  // settings
  document.querySelectorAll('[data-theme-opt]').forEach((b) =>
    b.addEventListener('click', () => {
      prefs.theme = b.dataset.themeOpt;
      savePrefs();
      applyTheme();
    })
  );
  systemDark.addEventListener('change', () => prefs.theme === 'system' && applyTheme());
  $('fontDown').addEventListener('click', () => setFontSize(prefs.fontSize - 1));
  $('fontUp').addEventListener('click', () => setFontSize(prefs.fontSize + 1));
  $('reloadAgents').addEventListener('click', reloadAgents);
  $('openConfig').addEventListener('click', () => {
    const dir = state.configPath.replace(/[\\/][^\\/]+$/, '');
    openIn('files', dir);
  });
  $('openUsage').addEventListener('click', () => {
    $('settingsSheet').close();
    renderUsage();
    $('usageSheet').showModal();
  });
  $('openAnthropic').addEventListener('click', () => openUrl('https://console.anthropic.com/settings/usage'));
  $('openOpenai').addEventListener('click', () => openUrl('https://platform.openai.com/usage'));
  $('resetUsage').addEventListener('click', async () => {
    const ok = await confirmDialog('Reset local usage counters?', 'The provider dashboards keep the real totals.', 'Reset');
    if (!ok) return;
    prefs.usage = {};
    savePrefs();
    renderUsage();
  });
  $('openImports').addEventListener('click', showImportSheet);
  $('refreshImports').addEventListener('click', refreshImports);
  $('importList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-import-chat]');
    if (row) openImportedChat(row.dataset.importChat);
  });
  $('importNewSession').addEventListener('click', () => {
    if ($('importSheet').open) $('importSheet').close();
    newSession();
  });

  // home
  $('homeProject').addEventListener('click', (e) => projectMenu(e.currentTarget));
  $('homeAgent').addEventListener('click', (e) => agentOnlyMenu(e.currentTarget));
  $('homeModel').addEventListener('click', (e) => modelMenu(e.currentTarget));
  $('homeMode').addEventListener('click', (e) => modeMenu(e.currentTarget));
  $('homeSend').addEventListener('click', startFromHome);
  $('homeInput').addEventListener('input', (e) => autoGrow(e.target));
  $('homeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      startFromHome();
    }
  });
  $('agentStrip').addEventListener('click', (e) => {
    const b = e.target.closest('[data-agent]');
    if (b && !b.disabled) chooseAgent(b.dataset.agent);
  });

  // session head
  $('actStop').addEventListener('click', () => {
    const s = active();
    if (s && s.ptyId) invoke('kill_session', { id: s.ptyId }).catch(() => {});
  });
  $('actRestart').addEventListener('click', () => active() && restartSession(active()));
  $('actResume').addEventListener('click', () => {
    const s = active();
    if (s) launch(s);
  });
  $('headModel').addEventListener('click', (e) => {
    const s = active();
    if (!s) return;
    const a = agent(s.agentId);
    if (!a) return;
    openMenu(e.currentTarget, {
      title: `${a.label} · Model`,
      items: a.models.map((m) => ({
        label: m.label,
        on: m.id === s.modelId,
        run: () => {
          if (m.id === s.modelId) return;
          s.modelId = m.id;
          pick(a).model = m.id;
          savePrefs();
          renderHead();
          if (s.status === 'running') {
            toast('Model changed. Restart the session to apply.', 'ok', () => restartSession(s));
          }
        }
      }))
    });
  });
  $('headControl').addEventListener('click', async () => {
    const s = active();
    if (!s || !s.ptyId || s.status !== 'running') return;
    const a = agent(s.agentId);
    if (!a || !a.pc_control) return;
    const enabling = !s.pcControl;
    // The CLI only learns about tools at launch, so turning PC control on or
    // off restarts the process. Say so before the user loses their place.
    const ok = enabling
      ? await confirmDialog(
          'Turn on PC control?',
          `${a.label} restarts with ezCLI's screenshot tool attached, so it can see your primary screen when it decides to. Its current conversation in this tab ends. Permission lasts only for this process and ends when it exits or you turn it off.`,
          'Restart with PC control'
        )
      : await confirmDialog(
          'Turn off PC control?',
          `${a.label} restarts without ezCLI's tools. Its current conversation in this tab ends.`,
          'Restart without it'
        );
    if (!ok) return;
    // Revoke the current process immediately, before the restart completes.
    await invoke('set_pc_control', { sessionId: s.ptyId, enabled: false }).catch(() => {});
    s.wantPcControl = enabling;
    await restartSession(s, { keepPcControl: true });
    toast(enabling ? 'PC control is on for this session.' : 'PC control is off.');
  });
  $('headAgent').addEventListener('click', (e) => {
    const s = active();
    if (!s) return;
    openMenu(e.currentTarget, {
      title: 'Backend',
      items: state.agents.map((a) => ({
        label: a.label,
        hint: a.available ? (a.id === s.agentId ? 'Current' : 'Switch and relaunch') : 'not installed',
        on: a.id === s.agentId,
        disabled: !a.available,
        run: () => switchSessionAgent(s, a.id)
      }))
    });
  });
  $('openInPrimary').addEventListener('click', () => {
    const t = preferredTarget();
    if (t) openIn(t.id, active() ? active().cwd : space().path);
  });
  $('openInMenu').addEventListener('click', (e) => openInMenu(e.currentTarget, active() ? active().cwd : space().path));
  $('scrollBottom').addEventListener('click', () => {
    const s = active();
    if (!s) return;
    s.term.scrollToBottom();
    updateScrollButton(s);
    s.term.focus();
  });

  // composer
  const pty = $('ptyInput');
  pty.addEventListener('input', () => {
    autoGrow(pty);
    histPos = -1;
    if (active()) active().draft = pty.value;
  });
  pty.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendComposer();
    } else if (e.key === 'ArrowUp' && (pty.value === '' || histPos > -1) && !pty.value.slice(0, pty.selectionStart).includes('\n')) {
      if (walkHistory(pty, 1)) e.preventDefault();
    } else if (e.key === 'ArrowDown' && histPos > -1) {
      if (walkHistory(pty, -1)) e.preventDefault();
    } else if (e.key === 'Escape') {
      active() && active().term.focus();
    }
  });
  $('btnSend').addEventListener('click', sendComposer);
  $('btnHistory').addEventListener('click', (e) => historyMenu(e.currentTarget));
  $('btnInterrupt').addEventListener('click', () => {
    const s = active();
    if (s && s.ptyId) invoke('send_input', { id: s.ptyId, data: '\x03' }).catch(() => {});
  });
  $('btnEsc').addEventListener('click', () => {
    const s = active();
    if (s && s.ptyId) invoke('send_input', { id: s.ptyId, data: '\x1b' }).catch(() => {});
  });

  // explorer
  $('explorerClose').addEventListener('click', () => setExplorerOpen(false));
  $('explorerRefresh').addEventListener('click', () => {
    state.explorer.cache = new Map();
    renderExplorer(true);
    refreshGit();
  });
  $('explorerResize').addEventListener('pointerdown', startExplorerResize);
  document.querySelectorAll('[data-xtab]').forEach((t) =>
    t.addEventListener('click', () => {
      prefs.explorerTab = t.dataset.xtab;
      savePrefs();
      state.explorer.view = 'list';
      renderExplorer();
    })
  );
  $('explorerContent').addEventListener('click', (e) => {
    const row = e.target.closest('.file-row');
    if (!row) return;
    if (row.dataset.path) {
      if (row.dataset.dir === '1') return toggleDir(row.dataset.path);
      state.explorer.view = 'file';
      state.explorer.file = row.dataset.path;
      renderExplorer();
    } else if (row.dataset.file) {
      state.explorer.view = 'diff';
      state.explorer.diff = { file: row.dataset.file, untracked: row.dataset.untracked === '1' };
      renderExplorer();
    }
  });
  $('explorerContent').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.file-row');
    if (!row) return;
    e.preventDefault();
    const g = state.git[space().path];
    const abs = row.dataset.path || (g && g.root ? `${g.root}/${row.dataset.file}` : row.dataset.file);
    openMenu(row, {
      at: { x: e.clientX, y: e.clientY },
      items: [
        { label: 'Add to chat', disabled: !active(), run: () => addToChat(abs) },
        { label: 'Copy path', run: () => copy(abs) },
        { label: 'Copy relative path', run: () => copy(relativeTo(abs, explorerRoot())) }
      ]
    });
  });

  window.addEventListener('resize', fitActive);
  window.addEventListener('focus', () => {
    const s = active();
    if (s && s.unseen) {
      s.unseen = false;
      updateTabMeta(s);
      renderSpaces();
    }
  });
}

async function reloadAgents() {
  try {
    state.agents = await invoke('reload_agents');
    if (!agent(prefs.agentId)) {
      const first = state.agents.find((a) => a.available) || state.agents[0];
      prefs.agentId = first ? first.id : null;
    }
    renderHome();
    toast('Agents reloaded from agents.json.', 'ok');
  } catch (err) {
    toast(String(err), 'error');
  }
}

boot();
