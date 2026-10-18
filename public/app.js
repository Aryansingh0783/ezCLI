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
const SessionRouting = window.ezCliSessionRouting;
const { isContinuationMode, freshModeId, modelSwitchPlan } = SessionRouting;

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
  usage: {},
  // Optional third-party MCP server (Klavis AI's Strata). Blank by default;
  // ezCLI never sets this itself. See public/features/strata.js.
  strataUrl: ''
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
  catalogs: {}, // agent id -> live model ids from the agent's own catalog
  systemProfile: null, // coarse local hardware facts, used only for routing advice
  explorer: { view: 'list', root: null, expanded: new Set(), cache: new Map(), filter: '', file: null, diff: null }
};

/* ------------------------------------------------------------- extensions
 *
 * Feature modules in public/features/ subscribe to these instead of patching
 * the core. Each handler runs in isolation: one failing feature never breaks
 * the session plumbing. */

const hooks = { boot: [], output: [], idle: [], exit: [], launched: [], closing: [], tabs: [], view: [], shortcut: [] };
function emit(name, ...args) {
  for (const fn of hooks[name] || []) {
    try {
      fn(...args);
    } catch (err) {
      console.error(`[ezcli ${name} hook]`, err);
    }
  }
}
const WINDOW_PARAMS = new URLSearchParams(location.search);
/** Only the first window restores and saves parked tabs; extra windows start empty. */
const IS_MAIN_WINDOW = !WINDOW_PARAMS.get('window');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const agent = (id) => state.agents.find((a) => a.id === id);
const active = () => state.sessions.find((s) => s.id === state.activeId) || null;
const space = (id = prefs.activeSpace) => prefs.spaces.find((x) => x.id === id) || null;
const spaceSessions = (id = prefs.activeSpace) => state.sessions.filter((s) => s.spaceId === id);
const basename = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const spaceIdFor = (path) => String(path).replace(/[\\/]+$/, '').toLowerCase();

/** A `.cmd` shim may set the terminal title to its shell executable. That is
 * useful shell metadata, but never a useful session name. */
function isMeaningfulTerminalTitle(title) {
  const text = String(title ?? '').trim();
  if (!text || text.length >= 80) return false;
  // Console hosts title a window "Windows PowerShell", "Administrator: Command
  // Prompt" or a full exe path; none of those name the session.
  const shell = basename(text).toLowerCase().replace(/^administrator:\s*/, '');
  return ![
    'cmd', 'cmd.exe', 'command prompt', 'powershell', 'powershell.exe', 'windows powershell', 'pwsh', 'pwsh.exe',
    'bash', 'bash.exe', 'sh', 'sh.exe', 'zsh', 'zsh.exe', 'fish', 'fish.exe', 'node', 'node.exe'
  ].includes(shell);
}

/* AgentOut will expose this value after the backend reload. The fallback makes
 * a just-updated frontend truthful with an older local backend too. */
const IMAGE_TRANSPORT_FALLBACK = Object.freeze({
  'claude-code': 'clipboard_only',
  'claude-chat': 'clipboard_only',
  codex: 'initial_flag',
  opencode: 'interactive_at_reference',
  gemini: 'interactive_at_reference',
  antigravity: 'clipboard_only',
  freebuff: 'none',
  chatgpt: 'none'
});
function imageTransport(a) {
  const value = String(a && (a.imageTransport || a.image_transport) || IMAGE_TRANSPORT_FALLBACK[a && a.id] || 'none').toLowerCase();
  return ['interactive_at_reference', 'clipboard_only', 'initial_flag', 'initial_positional', 'none'].includes(value) ? value : 'none';
}

/* ------------------------------------------------------------- persistence
 *
 * Sessions themselves cannot survive the app dying: the PTY and the agent
 * process go with it. What we persist is enough metadata to recreate the
 * tab in the same configuration (agent, model, mode, cwd, title) so a
 * restart does not lose the user's workspace. Restored tabs are "parked"
 * and show a Resume button that calls launch() to spawn a fresh CLI. */

function snapshotParked() {
  if (!IS_MAIN_WINDOW) return;
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
      effortId: s.effortId,
      cwd: s.cwd,
      title: s.title,
      exitCode: s.exitCode,
      providerSessionId: s.providerSessionId || '',
      transcriptId: s.transcriptId || '',
      prompts: (s.prompts || []).slice(-30),
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

/** A syntactically safe saved dynamic-model id. It remains displayable before
 * a live catalog has been refreshed, but it is never enough to launch a
 * require-selection agent by itself. */
const isCatalogModelId = (a, id) => Boolean(
  a && a.dynamic_models &&
  typeof id === 'string' &&
  /^[A-Za-z0-9][\w.:/@-]*$/.test(id) &&
  !(a.models || []).some((m) => m.id === id)
);

/** A dynamic model that this app has actually obtained from the agent or its
 * documented catalog during the current run. */
const isLiveCatalogModel = (a, id) => Boolean(
  isCatalogModelId(a, id) &&
  Array.isArray(state.catalogs[a.id]) &&
  state.catalogs[a.id].includes(id)
);

function catalogModelDisplay(a, id) {
  if (a && a.id === 'ollama-cloud') return id;
  const slash = String(id).indexOf('/');
  return slash >= 0 ? String(id).slice(slash + 1) : id;
}

/** Static models from agents.json plus, for agents with a live catalog, every
 *  model that catalog reported. Catalog entries keep their full id. */
function allModels(a) {
  // Models that need the user's own paid API key stay hidden unless they opt in.
  const staticModels = (a.models || []).filter((m) => (prefs.showPaidModels || !m.paid) && !(a.requiresModelSelection && m.id === 'default' && !(m.args || []).length));
  const known = new Set(staticModels.map((m) => m.id));
  const cat = (state.catalogs[a.id] || []).filter((id) => !known.has(id)).map((id) => {
    const slash = id.indexOf('/');
    return {
      id,
      label: catalogModelDisplay(a, id),
      provider: slash >= 0 ? id.slice(0, slash) : ''
    };
  });
  return [...staticModels, ...cat];
}
/** "Free" or "Paid" for a model, from the agent's modelPricing in agents.json. */
function modelPrice(a, id) {
  const own = a && (a.models || []).find((m) => m.id === id);
  if (own && own.paid) return 'Paid';
  const pricing = a && a.modelPricing;
  if (!pricing) return '';
  const bare = (x) => String(x).toLowerCase().replace(/(-cloud|:cloud)$/, '');
  const free = (pricing.free || []).map(bare).includes(bare(id)) || pricing.default === 'free';
  if (free) return 'Free';
  return pricing.default === 'paid' ? 'Paid' : '';
}

const modelLabel = (a, id) => {
  if (!a) return '';
  const m = allModels(a).find((x) => x.id === id);
  if (m) return m.label;
  // A saved catalog pick whose catalog hasn't loaded yet still shows its name.
  return isCatalogModelId(a, id) ? catalogModelDisplay(a, id) : label(a.models, id);
};
const effortLabel = (a, id) => label((a && a.efforts) || [], id);

function pick(a) {
  const p = (prefs.picks[a.id] ||= {});
  const catalogIsLoaded = Array.isArray(state.catalogs[a.id]);
  const known = allModels(a).some((m) => m.id === p.model) ||
    (catalogIsLoaded ? isLiveCatalogModel(a, p.model) : isCatalogModelId(a, p.model));
  if (!known) p.model = a.requiresModelSelection ? '' : (a.models[0] ? a.models[0].id : 'default');
  if (!a.modes.some((m) => m.id === p.mode)) p.mode = a.modes[0] ? a.modes[0].id : 'default';
  const efforts = a.efforts || [];
  if (!efforts.some((e) => e.id === p.effort)) p.effort = efforts[0] ? efforts[0].id : 'default';
  return p;
}

/** Fresh tabs may use a saved Plan/Auto choice, but a saved Continue/Resume
 * choice must never silently reconnect every tab to one provider conversation. */
function normalizeSavedContinuationModes() {
  let changed = false;
  for (const a of state.agents) {
    const p = prefs.picks[a.id];
    if (!p || !isContinuationMode(a, p.mode)) continue;
    p.mode = freshModeId(a, p.mode);
    changed = true;
  }
  // A parked tab has no provider-side conversation identifier—only a generic
  // `resume latest` argument. Reusing it after an app restart would therefore
  // attach it to whatever unrelated conversation the CLI considers latest.
  for (const sn of prefs.parked || []) {
    const a = agent(sn.agentId);
    if (!a || !isContinuationMode(a, sn.modeId)) continue;
    sn.modeId = freshModeId(a, sn.modeId);
    changed = true;
  }
  if (changed) savePrefs();
  return changed;
}

function resetContinuationPick(a) {
  const p = pick(a);
  if (!isContinuationMode(a, p.mode)) return false;
  p.mode = freshModeId(a, p.mode);
  savePrefs();
  return true;
}

const label = (list, id) => (list.find((x) => x.id === id) || list[0] || { label: 'Default' }).label;

/** Ask an agent for its live model list (e.g. OpenCode's key-free models).
 *  Runs only when the user opens the Model menu or presses refresh. */
async function fetchCatalog(a, { quiet = false } = {}) {
  try {
    state.catalogs[a.id] = await invoke('agent_models', { agentId: a.id });
    // A stored dynamic id is only a display placeholder until it appears in
    // the catalog refreshed for this app run. Do not let a stale preference
    // survive into a required-model launch.
    const p = prefs.picks[a.id];
    if (a.requiresModelSelection && p && p.model && !isLiveCatalogModel(a, p.model)) {
      p.model = '';
      savePrefs();
    }
    return state.catalogs[a.id];
  } catch (err) {
    if (!quiet) toast(String(err), 'error');
    return state.catalogs[a.id] || [];
  }
}

/** Resolve a live catalog model before an operation can stop or create a CLI.
 * The Rust backend repeats this check, but doing it here preserves a user's
 * prompt and their currently running session when a stored choice went stale. */
async function resolveRequiredModel(a, requestedModel, { quiet = false } = {}) {
  if (!a || !a.requiresModelSelection) return requestedModel;
  if (!Array.isArray(state.catalogs[a.id]) && (a.available || a.catalogAvailableWithoutCommand)) {
    await fetchCatalog(a, { quiet });
  }
  const selected = requestedModel || pick(a).model;
  if (isLiveCatalogModel(a, selected)) return selected;
  const p = prefs.picks[a.id];
  if (p && p.model === selected) {
    p.model = '';
    savePrefs();
  }
  if (!quiet) toast(`Choose a live ${a.label} model from the Model menu before starting a session.`, 'error');
  return '';
}

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
  // Older builds persisted Continue/Resume as the default for every future
  // tab. Those variants reopen a provider's globally latest conversation, so
  // reset the saved carry-over once rather than recreating one chat everywhere.
  const resetSavedResumeModes = normalizeSavedContinuationModes();
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
  // Hardware facts are advisory only: they help explain when a local Ollama
  // model may fit, but they never restrict Ollama Cloud models.
  invoke('detect_system_profile')
    .then((profile) => {
      state.systemProfile = profile;
      renderOnboarding();
      renderOnboardingConfig();
    })
    .catch(() => { state.systemProfile = null; });

  // Recreate every tab that was open at last shutdown as a parked session.
  // Nothing has launched yet; the user resumes with one click.
  for (const sn of IS_MAIN_WINDOW ? prefs.parked || [] : []) {
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
  if (resetSavedResumeModes) {
    toast('Saved Continue/Resume modes were reset to Default. Pick one again only when you want to reopen the latest CLI conversation.');
  }
  if (IS_MAIN_WINDOW) showOnboarding();
  emit('boot');
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
  const model = modelLabel(a, s.modelId);
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
  emit('tabs');
}

function updateTabMeta(s) {
  const el = $('tabs').querySelector(`[data-meta="${s.id}"]`);
  if (el) el.innerHTML = tabMeta(s);
}

/** Extra tab-menu entries contributed by feature modules. */
const tabMenuItems = [];
function tabMenuExtras(s) {
  return tabMenuItems.flatMap((fn) => {
    try {
      return fn(s) || [];
    } catch {
      return [];
    }
  });
}

function tabMenu(anchor, s, x, y) {
  const others = spaceSessions().filter((o) => o.id !== s.id);
  openMenu(anchor, {
    at: x != null ? { x, y } : null,
    items: [
      { label: 'Rename…', run: () => renameTab(s) },
      {
        label: 'Duplicate',
        run: () => createSession(s.agentId, {
          modelId: s.modelId,
          modeId: s.modeId,
          effortId: s.effortId,
          cwd: s.cwd
        })
      },
      { label: 'Restart', run: () => restartSession(s) },
      { label: 'Copy folder path', run: () => copy(s.cwd) },
      ...tabMenuExtras(s),
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

/** Put a parked tab's saved terminal text back on screen, so closing the app
 *  does not lose what the conversation looked like. */
async function restoreSavedText(s) {
  const dim = (t) => `\x1b[38;2;106;106;112m${t}\x1b[0m`;
  const hint = s.providerSessionId
    ? 'Resume continues the same conversation.'
    : 'Resume starts the CLI again in this folder.';
  let saved = '';
  if (s.transcriptId) {
    try {
      saved = (await invoke('read_transcript', { id: s.transcriptId })).text || '';
    } catch {
      /* no saved copy yet: the tab was never run, or the file was deleted */
    }
  }
  if (saved.trim()) {
    s.term.write(saved.replace(/\r?\n/g, '\r\n'));
    s.term.write(`\r\n${dim('── restored from your last session ──')}\r\n`);
  }
  s.term.writeln(dim(`Session from your last run. ${hint}`));
  s.term.scrollToBottom();
}

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
    // Liquid glass draws the terminal over a frosted pane.
    allowTransparency: (prefs.style || 'glass') === 'glass',
    theme: TERM_THEMES[resolvedTheme()],
    scrollback: 10000
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  term.attachCustomKeyEventHandler((e) => !isAppShortcut(e));


  const s = {
    id: sn.id || `t${++state.seq}`,
    ptyId: null,
    launchEpoch: 0,
    spaceId: sn.spaceId,
    agentId: sn.agentId,
    modelId: sn.modelId,
    modeId: sn.modeId,
    effortId: sn.effortId || pick(a).effort,
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
    // Image paths are deliberately transient: unlike prompt history or parked
    // session metadata, a selected local image is never written to localStorage.
    imageRefs: [],
    // The CLI's own conversation id and ezCLI's saved copy of this tab, so the
    // conversation survives the app closing.
    providerSessionId: sn.providerSessionId || '',
    resumeNext: Boolean(sn.providerSessionId),
    transcriptId: sn.transcriptId || '',
    prompts: Array.isArray(sn.prompts) ? sn.prompts : [],
    usage: Usage.createUsageState(),
    pcControl: false,
    term,
    fit,
    host,
    unlisten: []
  };
  restoreSavedText(s);
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
    notInstalledToast(a);
    return null;
  }
  const p = pick(a);
  const selectedModel = await resolveRequiredModel(a, opts.modelId || p.model);
  if (a.requiresModelSelection && !selectedModel) return null;
  const requestedModeId = opts.modeId ?? p.mode;
  // Only the home picker can deliberately ask to reopen a provider-side
  // conversation. Every other source of a new tab is a fresh CLI session.
  const modeId = opts.allowContinuation && isContinuationMode(a, requestedModeId)
    ? requestedModeId
    : freshModeId(a, requestedModeId);
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
    // Liquid glass draws the terminal over a frosted pane.
    allowTransparency: (prefs.style || 'glass') === 'glass',
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
    launchEpoch: 0,
    spaceId: sp.id,
    agentId,
    modelId: selectedModel,
    modeId,
    effortId: opts.effortId ?? p.effort,
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
    // Image paths are deliberately transient: unlike prompt history or parked
    // session metadata, a selected local image is never written to localStorage.
    imageRefs: [],
    // Set when continuing a conversation the CLI already knows by id.
    providerSessionId: opts.resumeId || '',
    resumeNext: Boolean(opts.resumeId),
    transcriptId: '',
    prompts: opts.prompt ? [opts.prompt] : [],
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
    if (!opts.title && isMeaningfulTerminalTitle(t)) {
      s.title = t.trim();
      renderTabs();
      if (s.id === state.activeId) renderHead();
    }
  });

  selectSession(s.id);
  requestAnimationFrame(() => launch(s));
  return s;
}

/** Invalidate an in-flight launch before replacing or closing its session. */
function invalidateLaunch(s) {
  s.launchEpoch = Number.isSafeInteger(s.launchEpoch) ? s.launchEpoch + 1 : 1;
  return s.launchEpoch;
}

/** Spawn (or respawn) the CLI behind a session. Each launch gets a fresh
 *  pty id and epoch so a late async result cannot touch a newer process. */
async function launch(s) {
  const launchEpoch = invalidateLaunch(s);
  const isCurrentLaunch = () => s.launchEpoch === launchEpoch;
  if (s.ptyId) invoke('set_pc_control', { sessionId: s.ptyId, enabled: false }).catch(() => {});
  // The backend only passes a catalog model if it fetched that catalog itself;
  // make sure it has, or the session would quietly start on the default model.
  const la = agent(s.agentId);
  if (la && la.requiresModelSelection) {
    const selectedModel = await resolveRequiredModel(la, s.modelId, { quiet: true });
    if (!isCurrentLaunch()) return false;
    if (!selectedModel) {
      s.status = 'error';
      s.term.write(`\r\n\x1b[38;2;231;163;163mChoose a live ${la.label} model from the Model menu before launching this session.\x1b[0m\r\n`);
      updateTabMeta(s);
      renderSpaces();
      if (s.id === state.activeId) {
        renderHead();
        renderStatus();
      }
      return false;
    }
    s.modelId = selectedModel;
  } else if (la && isCatalogModelId(la, s.modelId) && !state.catalogs[la.id]) {
    await fetchCatalog(la, { quiet: true });
    if (!isCurrentLaunch()) return false;
  }
  for (const un of s.unlisten.splice(0)) safe(un);
  // A relaunch creates a fresh underlying CLI session, so observed metrics
  // must not leak from the prior process into this one.
  s.usage = Usage.createUsageState();
  s.pcControl = false;
  s.strataActive = false;
  // Window-unique: every window numbers its tabs from 1, and the backend
  // keeps one session table for all windows.
  const ptyId = `p${WINDOW_PARAMS.get('window') || 1}-${++state.seq}`;
  s.ptyId = ptyId;
  s.status = 'starting';
  s.startedAt = Date.now();
  s.exitCode = null;

  if (!(await attachPty(s, ptyId, isCurrentLaunch))) return false;

  try {
    s.fit.fit();
  } catch {
    /* geometry races are retried on resize */
  }
  // Conversation memory: resume the CLI's own conversation when we know its id,
  // otherwise start under an id we choose (Claude Code) so it can be resumed
  // later. Codex picks its own id; sessions.js reads it back after launch.
  const la2 = agent(s.agentId);
  let sessionId = '';
  let resuming = false;
  if (s.resumeNext && s.providerSessionId && la2 && la2.sessionResume) {
    // Only resume a conversation the CLI actually stored; a tab that ran nothing
    // but local commands has none, and starting fresh beats an empty screen.
    const stored = await invoke('provider_session_exists', { agentId: s.agentId, sessionId: s.providerSessionId }).catch(() => true);
    if (!isCurrentLaunch()) return false;
    if (stored) {
      sessionId = s.providerSessionId;
      resuming = true;
    } else {
      s.term.writeln('\x1b[38;2;106;106;112m(That conversation was never stored by the CLI, so this starts a new one.)\x1b[0m');
      s.providerSessionId = '';
    }
  }
  if (!resuming) {
    if (la2 && la2.sessionNew) {
      s.providerSessionId = crypto.randomUUID();
      sessionId = s.providerSessionId;
    } else {
      // A fresh launch is a new conversation; Codex's id is found after it starts.
      s.providerSessionId = '';
    }
  }
  s.resumeNext = false;
  try {
    const r = await invoke('start_session', {
      id: ptyId,
      agentId: s.agentId,
      modelId: s.modelId,
      modeId: s.modeId,
      effortId: s.effortId,
      cwd: s.cwd,
      cols: s.term.cols,
      rows: s.term.rows,
      pcControl: Boolean(s.wantPcControl),
      strataUrl: s.wantStrata && prefs.strataUrl ? prefs.strataUrl : null,
      providerSessionId: sessionId || null,
      resume: resuming
    });
    if (!isCurrentLaunch() || s.ptyId !== ptyId) {
      invoke('kill_session', { id: ptyId }).catch(() => {});
      return false;
    }
    s.status = 'running';
    s.command = r.command;
    s.cwd = r.cwd;
    s.pcControl = Boolean(r.pcControl);
    s.strataActive = Boolean(r.strataActive);
    if (s.pendingPrompt) {
      // If the CLI never goes quiet, deliver the first message anyway.
      setTimeout(() => deliverPending(s), 10000);
    }
    emit('launched', s);
  } catch (err) {
    if (!isCurrentLaunch() || s.ptyId !== ptyId) {
      invoke('kill_session', { id: ptyId }).catch(() => {});
      return false;
    }
    s.status = 'error';
    // A failed launch must not leave a pending PC-control request behind.
    s.wantPcControl = false;
    s.wantStrata = false;
    s.term.write(`\r\n\x1b[38;2;231;163;163m${String(err).replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
  }
  updateTabMeta(s);
  renderSpaces();
  if (s.id === state.activeId) {
    renderHead();
    renderStatus();
  }
  return s.status === 'running';
}

/** Subscribe a session to a PTY's output and exit events. Used by launch()
 *  and by a window that adopts a running PTY moved from another window. */
async function attachPty(s, ptyId, isCurrentLaunch = () => true) {
  const unlistenData = await listen(`pty-data:${ptyId}`, (e) => {
    if (!isCurrentLaunch() || s.ptyId !== ptyId) return;
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
    emit('output', s, e.payload);
  });
  if (!isCurrentLaunch()) {
    safe(unlistenData);
    return false;
  }
  s.unlisten.push(unlistenData);
  const unlistenExit = await listen(`pty-exit:${ptyId}`, (e) => {
    if (!isCurrentLaunch() || s.ptyId !== ptyId) return;
    invoke('set_pc_control', { sessionId: ptyId, enabled: false }).catch(() => {});
    s.pcControl = false;
    s.strataActive = false;
    // Consent covers one process. Relaunching after an exit asks again.
    s.wantPcControl = false;
    s.wantStrata = false;
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
    emit('exit', s, e.payload);
  });
  if (!isCurrentLaunch()) {
    safe(unlistenExit);
    return false;
  }
  s.unlisten.push(unlistenExit);
  return true;
}

/** What is on a session's visible terminal screen, as plain text. A TUI draws
 *  a question wherever it likes (Codex puts its prompt at the top of an
 *  otherwise empty screen), so look at every visible row, not just the bottom. */
function screenTail(s, count = s.term.rows) {
  const b = s.term.buffer.active;
  const lines = [];
  for (let i = Math.max(0, b.length - count); i < b.length; i++) {
    const l = b.getLine(i);
    const t = l ? l.translateToString(true).trim() : '';
    if (t) lines.push(t);
  }
  return lines.join('\n');
}

/** A CLI can stop on its own question (update, trust this folder, sign in)
 *  where Enter means "yes". Text sent then would answer it by accident: Codex's
 *  update prompt defaults to "Update now", which runs `npm install -g`. */
function cliBlocker(s) {
  const text = screenTail(s);
  if (/update available/i.test(text) && /esc skip|skip until next version/i.test(text)) return { kind: 'update' };
  if (/yes, i trust this folder|do you trust the files in this folder|trust this folder/i.test(text)) return { kind: 'trust', hint: 'confirm whether you trust this folder' };
  if (/press enter to log ?in|please (log|sign) ?in to continue/i.test(text)) return { kind: 'login', hint: 'sign in' };
  return null;
}

/** True when it is safe to send. An update prompt is skipped with Esc (the
 *  harmless choice); every other question is left for the user to answer. */
async function prepareToSend(s, { quiet = false } = {}) {
  for (let i = 0; i < 3; i++) {
    const block = cliBlocker(s);
    if (!block) return true;
    if (block.kind !== 'update') {
      if (!quiet) toast(`${(agent(s.agentId) || {}).label || 'The CLI'} is waiting for you to ${block.hint}. Answer it in the terminal, then send again.`, 'error');
      return false;
    }
    await invoke('send_input', { id: s.ptyId, data: '\x1b' }).catch(() => {});
    await sleep(700);
  }
  return !cliBlocker(s);
}

/** Deliver the first message typed on the home screen once the CLI is ready.
 *  If the CLI is stuck on a question, keep the message and try again. */
async function deliverPending(s) {
  if (!s.pendingPrompt || s.status !== 'running' || s.delivering) return;
  s.delivering = true;
  try {
    for (let tries = 0; tries < 60 && s.pendingPrompt && s.status === 'running'; tries++) {
      if (await prepareToSend(s, { quiet: tries !== 0 })) {
        const text = s.pendingPrompt;
        s.pendingPrompt = '';
        await sendText(s, text);
        return;
      }
      await sleep(2500);
    }
  } finally {
    s.delivering = false;
  }
}

/** Stop a process immediately and invalidate any launch that has not finished. */
function stopSession(s) {
  if (!s || !s.ptyId) return false;
  const ptyId = s.ptyId;
  invalidateLaunch(s);
  if (s.status === 'running') recordUsage(s);
  s.ptyId = null;
  s.status = 'exited';
  s.exitCode = null;
  s.working = false;
  s.wantPcControl = false;
  s.pcControl = false;
  s.wantStrata = false;
  s.strataActive = false;
  for (const un of s.unlisten.splice(0)) safe(un);
  s.term.write('\r\n\x1b[38;2;106;106;112m── stopped by user ──\x1b[0m\r\n');
  updateTabMeta(s);
  renderSpaces();
  if (s.id === state.activeId) {
    renderHead();
    renderStatus();
  }
  invoke('kill_session', { id: ptyId }).catch(() => {});
  return true;
}

async function restartSession(s, { keepPcControl = false, keepStrata = false } = {}) {
  const a = agent(s.agentId);
  const selectedModel = await resolveRequiredModel(a, s.modelId);
  if (a && a.requiresModelSelection && !selectedModel) return false;
  if (selectedModel) s.modelId = selectedModel;
  // PC-control and Strata consent cover one process each; only their own
  // chips may carry a fresh grant into the next launch.
  if (!keepPcControl) s.wantPcControl = false;
  if (!keepStrata) s.wantStrata = false;
  invalidateLaunch(s);
  if (s.ptyId) await invoke('kill_session', { id: s.ptyId }).catch(() => {});
  s.term.write('\r\n\x1b[38;2;106;106;112m── restarting ──\x1b[0m\r\n');
  return launch(s);
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
  emit('closing', s);
  invalidateLaunch(s);
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
    effortId: s.effortId,
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
  createSession(entry.agentId, {
    modelId: entry.modelId,
    modeId: entry.modeId,
    effortId: entry.effortId,
    cwd: entry.cwd,
    title: entry.title
  });
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
// A declaration, not a const, so the compare grid can extend it.
function fitActive() {
  return fitSession(active());
}

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
  emit('idle', s);
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
  renderSessionAgentNotice(s);
  renderHead();
  renderStatus();
  emit('view', s);
}

function renderSessionAgentNotice(s = active()) {
  const notice = $('sessionAgentNotice');
  if (!notice) return;
  const isGemini = Boolean(s && s.agentId === 'gemini');
  const isOllamaCloud = Boolean(s && s.agentId === 'ollama-cloud');
  notice.hidden = !isGemini && !isOllamaCloud;
  notice.innerHTML = isGemini
    ? '<strong>Gemini CLI setup:</strong> Personal Google sign-in is no longer supported here. Use Antigravity CLI for a personal account; Gemini CLI needs a Gemini API key, Vertex AI, or an enterprise setup.'
    : isOllamaCloud
      ? '<strong>Ollama Cloud:</strong> This tab launches a remote model. It requires an Ollama sign-in from your own terminal (<code>ollama signin</code>); ezCLI never handles your account or API key.'
      : '';
}

function renderHome() {
  const sp = space();
  const a = agent(prefs.agentId);
  $('homeTitle').textContent = sp ? `What should we work on in ${sp.name}?` : 'What should we work on?';
  $('homeProjectLabel').textContent = sp ? ellipsisLeft(sp.path, 48) : 'Choose a folder';
  const routeNotice = $('homeRouteNotice');
  const routeAdvice = ollamaRouteAdvice(a);
  routeNotice.hidden = !routeAdvice;
  routeNotice.textContent = routeAdvice;
  if (a) {
    const p = pick(a);
    const caret =
      '<svg class="caret" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m6 9 6 6 6-6"/></svg>';
    const fill = (id, cap, val, show = true) => {
      const el = $(id);
      el.hidden = !show;
      el.innerHTML = `<span class="pill-cap">${cap}</span><span class="pill-val">${esc(val)}</span>${caret}`;
      // The value can be clipped (long catalog model names); keep it readable.
      el.title = `${cap}: ${val}`;
    };
    fill('homeAgent', 'Agent', a.label);
    fill('homeModel', 'Model', modelLabel(a, p.model), a.models.length > 0 || a.dynamic_models);
    fill('homeEffort', 'Effort', effortLabel(a, p.effort), (a.efforts || []).length > 1);
    fill('homeMode', 'Mode', label(a.modes, p.mode), a.modes.length > 1);
  }

  $('agentStrip').innerHTML = state.agents
    .map(
      (x) => `<button class="agent-option ${x.id === prefs.agentId ? 'selected' : ''}" data-agent="${esc(x.id)}"
        role="radio" aria-checked="${x.id === prefs.agentId}" ${x.available ? '' : 'disabled'}
        title="${esc(x.available ? x.resolved || x.command : `${x.command} was not found on PATH`)}">
        ${ICONS[x.icon] || ICONS.term}<span>${esc(x.label)}</span>${x.free ? '<span class="free-badge">Free</span>' : ''}${x.available ? '' : '<span class="off">not installed</span>'}
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
    const name = modelLabel(a, s.modelId);
    modelEl.hidden = !name;
    modelEl.textContent = name;
    modelEl.title = `Model: ${name}. Select another model to start a fresh session.`;
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
      : 'Restart this session with PC control (screenshot, mouse and keyboard)';
  // Strata is a third-party tool server (Settings → Strata); the chip only
  // exists at all once a URL is configured there, same gate as PC control
  // (the agent must be able to receive an MCP server in the first place).
  const strata = $('headStrata');
  const strataConfigured = Boolean(prefs.strataUrl && prefs.strataUrl.trim());
  strata.hidden = !strataConfigured;
  if (strataConfigured) {
    strata.disabled = !supportsPc || s.status !== 'running' || !s.ptyId;
    strata.classList.toggle('granted', Boolean(s.strataActive));
    strata.textContent = s.strataActive ? 'Strata on' : 'Strata off';
    strata.title = !supportsPc
      ? `Strata isn't available for ${a ? a.label : 'this agent'} yet`
      : s.strataActive
        ? 'Restart this session without Strata'
        : 'Restart this session with the Strata tools configured in Settings';
  }
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
    $('stCmd').textContent = space() ? `${tabCount(spaceSessions().length)} in ${space().name}` : 'no session';
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

  const usage = s.usage;
  if (!usage.observed) {
    // Most CLIs print no usage. A permanent "not reported" label is noise, so
    // the strip appears only once a CLI actually reports something.
    strip.hidden = true;
    metrics.textContent = '';
    announcer.textContent = '';
    return;
  }

  strip.hidden = false;
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
  const files = s && Array.isArray(s.context) ? s.context : [];
  const images = attachmentsOf(s);
  renderImageAttachControl(s);
  if (!s || (!files.length && !images.length)) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  const filePills = files
    .map(
      (p, i) => `<span class="context-pill" title="${esc(p)}"><span>@${esc(p)}</span>
      <button data-ctx="${i}" aria-label="Remove ${esc(p)}">${ICONS.close}</button></span>`
    )
    .join('');
  box.innerHTML = filePills + attachmentPills(s);
  box.querySelectorAll('[data-ctx]').forEach((b) =>
    b.addEventListener('click', () => {
      s.context.splice(Number(b.dataset.ctx), 1);
      renderContext();
    })
  );
  box.querySelectorAll('[data-image-ref]').forEach((b) =>
    b.addEventListener('click', () => {
      s.imageRefs.splice(Number(b.dataset.imageRef), 1);
      renderContext();
    })
  );
}

/* ---------------------------------------------------------- attachments
 *
 * ezCLI never uploads media. It hands each CLI a local file the way that CLI
 * really reads pictures, chosen by the agent's declared image transport:
 *   interactive_at_reference  an @path mention (OpenCode, Gemini). Both read
 *                             inside the project only, so files from elsewhere
 *                             are copied into a git-ignored .ezcli-attachments
 *                             folder in the session folder first.
 *   clipboard_only,           Claude Code and Codex attach an image path that
 *   initial_flag              arrives as a bracketed paste. Without bracketed
 *                             paste the quoted path goes in the prompt instead.
 *   initial_positional        `ollama run` loads image paths in the prompt
 *                             (multimodal models only).
 * Only Gemini reads video. For every other agent a video becomes a few still
 * frames sampled with the user's own ffmpeg. */

const IMAGE_FILE_EXTENSIONS = ['avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'tif', 'tiff', 'webp'];
const VIDEO_FILE_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'mpeg', 'mpg', '3gp'];
const extRe = (list) => new RegExp(`\\.(${list.join('|')})$`, 'i');
const isImageFile = (path) => extRe(IMAGE_FILE_EXTENSIONS).test(String(path));
const isVideoFile = (path) => extRe(VIDEO_FILE_EXTENSIONS).test(String(path));
const NATIVE_VIDEO_TRANSPORT_AGENTS = new Set(['gemini']);
const VIDEO_FRAME_COUNT = 6;
const FFMPEG_INSTALL = 'winget install Gyan.FFmpeg';

function attachTransport(a) {
  const t = imageTransport(a);
  return t === 'none' ? null : t;
}

/** Older code stored bare path strings; normalise to attachment objects. */
function attachmentsOf(s) {
  if (!s) return [];
  if (!Array.isArray(s.imageRefs)) s.imageRefs = [];
  s.imageRefs = s.imageRefs.map((x) => (typeof x === 'string' ? { kind: 'image', path: x } : x)).filter((x) => x && x.path);
  return s.imageRefs;
}

const isInside = (p, base) => {
  const norm = (x) => String(x).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return Boolean(base) && norm(p).startsWith(norm(base) + '/');
};

function renderImageAttachControl(s = active()) {
  const button = $('btnAttachImage');
  if (!button) return;
  const a = s && agent(s.agentId);
  const transport = attachTransport(a);
  button.dataset.imageTransport = transport || 'none';
  const usable = Boolean(s && a && transport);
  button.hidden = !usable;
  button.disabled = !usable;
  if (!usable) return;
  const video = NATIVE_VIDEO_TRANSPORT_AGENTS.has(a.id) ? 'videos' : 'videos (as sampled frames)';
  const copy = `Attach images or ${video} for ${a.label}. You can also paste a screenshot or drop files here.`;
  button.title = copy;
  button.setAttribute('aria-label', copy);
}

/** A file path the target CLI can read for an @mention: inside the session
 *  folder and free of spaces. Anything else is copied in first. */
async function workspaceCopy(s, path) {
  if (isInside(path, s.cwd) && !/\s/.test(relativeTo(path, s.cwd))) return path;
  return invoke('stage_attachment', { path, workspace: s.cwd });
}

async function addAttachments(paths, s = active()) {
  const a = s && agent(s.agentId);
  if (!s || !a) return toast('Open a session first, then attach files to it.');
  const transport = attachTransport(a);
  const media = paths.filter((p) => isImageFile(p) || isVideoFile(p));
  const others = paths.filter((p) => !media.includes(p));
  others.forEach((p) => addToChat(p));
  if (!media.length) return;
  if (!transport) {
    toast(`${a.label} cannot read images or video through its CLI, so nothing was attached.`, 'error');
    return;
  }
  const atRef = transport === 'interactive_at_reference';
  const list = attachmentsOf(s);
  let added = 0;
  for (const original of media) {
    try {
      if (isImageFile(original)) {
        const path = atRef ? await workspaceCopy(s, original) : original;
        if (!list.some((x) => x.path === path)) list.push({ kind: 'image', path });
        added++;
      } else if (NATIVE_VIDEO_TRANSPORT_AGENTS.has(a.id)) {
        const path = await workspaceCopy(s, original);
        if (!list.some((x) => x.path === path)) list.push({ kind: 'video', path, name: basename(original) });
        added++;
      } else {
        toast(`Sampling ${VIDEO_FRAME_COUNT} frames from ${basename(original)}…`);
        const got = await invoke('extract_video_frames', {
          path: original,
          count: VIDEO_FRAME_COUNT,
          workspace: atRef ? s.cwd : null
        });
        list.push({ kind: 'video', path: original, name: basename(original), duration: got.duration, frames: got.frames });
        added++;
      }
    } catch (err) {
      if (String(err).includes('FFMPEG_MISSING')) {
        toast(`Videos need ffmpeg to sample frames for ${a.label}. Install it with: ${FFMPEG_INSTALL} — then try again. Click to copy.`, 'error', () => copy(FFMPEG_INSTALL));
      } else {
        toast(`Couldn’t attach ${basename(original)}: ${String(err)}`, 'error');
      }
    }
  }
  if (s.id === state.activeId) {
    renderContext();
    $('ptyInput').focus();
  }
  if (added) toast(`Attached ${added} file${added === 1 ? '' : 's'} for ${a.label}. They stay on this PC; the CLI reads them locally.`, 'ok');
}

async function chooseImageReferences() {
  const s = active();
  const a = s && agent(s.agentId);
  if (!s || !a) return toast('Open a session first, then attach files to it.');
  if (!attachTransport(a)) {
    toast(`${a.label} cannot read images or video through its CLI.`, 'error');
    return;
  }
  let chosen;
  const options = {
    multiple: true,
    defaultPath: s.cwd || state.homeCwd,
    filters: [
      { name: 'Images and videos', extensions: [...IMAGE_FILE_EXTENSIONS, ...VIDEO_FILE_EXTENSIONS] },
      { name: 'Images', extensions: IMAGE_FILE_EXTENSIONS },
      { name: 'Videos', extensions: VIDEO_FILE_EXTENSIONS }
    ]
  };
  try {
    chosen = T.dialog && T.dialog.open ? await T.dialog.open(options) : await invoke('plugin:dialog|open', { options });
  } catch (err) {
    toast(`Couldn’t open the file picker: ${String(err)}`, 'error');
    return;
  }
  const paths = Array.isArray(chosen) ? chosen : chosen ? [chosen] : [];
  if (paths.length) await addAttachments(paths, s);
}

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** Ctrl+V of a screenshot (Win+Shift+S) or a copied image. */
async function pasteImages(e) {
  const items = [...((e.clipboardData && e.clipboardData.items) || [])].filter(
    (i) => i.kind === 'file' && /^image\//i.test(i.type)
  );
  if (!items.length) return;
  e.preventDefault();
  const s = active();
  const a = s && agent(s.agentId);
  if (!s || !a) return toast('Open a session first, then paste the image.');
  const transport = attachTransport(a);
  if (!transport) return toast(`${a.label} cannot read images through its CLI.`, 'error');
  const list = attachmentsOf(s);
  for (const item of items) {
    const blob = item.getAsFile();
    if (!blob) continue;
    try {
      const path = await invoke('save_pasted_image', {
        data: await blobToBase64(blob),
        mime: blob.type,
        workspace: transport === 'interactive_at_reference' ? s.cwd : null
      });
      list.push({ kind: 'image', path, name: 'Pasted image' });
    } catch (err) {
      toast(`Couldn’t paste the image: ${String(err)}`, 'error');
    }
  }
  renderContext();
}

/** Files dropped anywhere on the window go to the active session. Tauri
 *  delivers real paths for native drops, so nothing is read into memory. */
function wireFileDrop() {
  const composer = $('ptyComposer');
  const off = () => composer.classList.remove('drop-ready');
  listen('tauri://drag-enter', () => active() && composer.classList.add('drop-ready'));
  listen('tauri://drag-leave', off);
  listen('tauri://drag-drop', (e) => {
    off();
    const paths = (e.payload && e.payload.paths) || [];
    if (!paths.length || !active()) return;
    addAttachments(paths);
  });
}

/** The text a CLI receives for one attached file. */
function attachmentRef(transport, s, path) {
  if (transport === 'interactive_at_reference') return `@${relativeTo(path, s.cwd)}`;
  if (transport === 'initial_positional') return path;
  return /\s/.test(path) ? `"${path}"` : path;
}

const fmtSeconds = (t) => `${Number(t).toFixed(1)}s`;

/* Verified live: Claude Code and Codex turn a pasted image path into an
 * "[Image #n]" attachment in their own composer. */
const PASTE_ATTACH_AGENTS = new Set(['claude-code', 'claude-chat', 'codex']);

/** Prompt lines describing the attachments, plus the image paths to paste
 *  first when the CLI attaches pasted image paths itself. */
function attachmentPrompt(s, a) {
  const transport = attachTransport(a);
  const paste = Boolean(a && PASTE_ATTACH_AGENTS.has(a.id) && s.term && s.term.modes && s.term.modes.bracketedPasteMode);
  const lines = [];
  const pastes = [];
  const ref = (path) => {
    if (!paste) return attachmentRef(transport, s, path);
    pastes.push(path);
    return `[Image #${pastes.length}]`;
  };
  for (const x of attachmentsOf(s)) {
    if (x.kind === 'image') {
      lines.push(`Image: ${ref(x.path)}${paste ? ` (${x.name || basename(x.path)})` : ''}`);
    } else if (!x.frames) {
      lines.push(`Video: ${attachmentRef(transport, s, x.path)}`);
    } else {
      const total = x.duration ? ` (${fmtSeconds(x.duration)} long)` : '';
      lines.push(`Frames sampled from the video "${x.name}"${total}, in order:`);
      for (const f of x.frames) lines.push(`  at ${fmtSeconds(f.at)}: ${ref(f.path)}`);
    }
  }
  return { lines, pastes };
}
function attachmentPills(s) {
  return attachmentsOf(s)
    .map((x, i) => {
      const name = x.name || basename(x.path);
      const kind = x.kind === 'image' ? 'Image' : x.frames ? `Video · ${x.frames.length} frames` : 'Video';
      const tip = x.frames
        ? `${x.frames.length} still frames sampled locally from ${x.path}`
        : `Local file, read by the CLI on this PC: ${x.path}`;
      return `<span class="context-pill image-context" title="${esc(tip)}"><span class="context-kind">${esc(kind)}</span><span>${esc(name)}</span>
      <button data-image-ref="${i}" aria-label="Remove ${esc(name)}">${ICONS.close}</button></span>`;
    })
    .join('');
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

/** Put one message into a CLI's input box and submit it.
 *
 *  Terminal UIs (Codex, Claude Code, OpenCode) treat fast typed characters as
 *  a paste and swallow the Enter that follows, so a message needed a second
 *  manual Enter. When the CLI enabled bracketed paste we send the text as a
 *  real paste (one atomic insert), wait for the UI to take it, then press
 *  Enter. Without bracketed paste we type the text on one line instead.
 *  Per-agent overrides live in agents.json under "submit". */
function sendText(s, text) {
  if (!s.ptyId) return Promise.resolve(false);
  const cfg = (agent(s.agentId) || {}).submit || {};
  const bracketed = Boolean(s.term.modes && s.term.modes.bracketedPasteMode);
  const usePaste = cfg.paste === 'always' || (cfg.paste !== 'never' && bracketed);
  // Longer messages take the UI longer to lay out before it will accept Enter.
  const delay = Number.isFinite(cfg.delayMs) ? cfg.delayMs : Math.min(900, 220 + Math.floor(text.length / 12));
  const ptyId = s.ptyId;
  const out = (data) => invoke('send_input', { id: ptyId, data }).catch(() => {});
  if (usePaste) out(`\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`);
  else out(text.replace(/\r?\n/g, ' '));
  return new Promise((resolve) => {
    setTimeout(async () => {
      // The tab may have been restarted or closed while we waited.
      if (s.ptyId !== ptyId) return resolve(false);
      await out('\r');
      resolve(true);
    }, usePaste ? delay : Math.max(120, delay));
  });
}

function pushHistory(text) {
  const t = text.trim();
  if (!t) return;
  prefs.history = [t, ...prefs.history.filter((h) => h !== t)].slice(0, 100);
  savePrefs();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Paste each image path on its own so the CLI recognises it as an image. */
async function pasteImagePaths(s, paths) {
  if (!paths.length || !(s.term.modes && s.term.modes.bracketedPasteMode)) return;
  for (const p of paths) {
    await invoke('send_input', { id: s.ptyId, data: `\x1b[200~${p}\x1b[201~` }).catch(() => {});
    await sleep(150);
  }
}

async function sendComposer() {
  const el = $('ptyInput');
  const s = active();
  if (!s) return;
  const v = el.value;
  const files = Array.isArray(s.context) ? s.context : [];
  const images = attachmentsOf(s);
  if (!v.trim() && !files.length && !images.length) return;
  if (s.status !== 'running') {
    toast('This session is not running.', 'error', () => restartSession(s));
    return;
  }
  const fileRefs = files.map((p) => `@${p}`).join(' ');
  // Local paths in the form this CLI reads; ezCLI never uploads the files.
  const media = attachmentPrompt(s, agent(s.agentId));
  const ask = v.trim() || (images.length ? 'Look at the attached media.' : '');
  const text = [fileRefs, ...media.lines, ask].filter(Boolean).join('\n').trim();
  if (!(await prepareToSend(s))) return;
  pushHistory(v);
  // Clear first so a second Enter during the paste can't send twice.
  s.context = [];
  s.imageRefs = [];
  s.draft = '';
  el.value = '';
  histPos = -1;
  autoGrow(el);
  renderContext();
  await pasteImagePaths(s, media.pastes);
  await sendText(s, text);
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
      <span class="meta">${g.files.length} change${g.files.length > 1 ? 's' : ''} · <span class="num-add">+${add}</span> <span class="num-del">−${del}</span></span></div>
    <ul class="explorer-list">${g.files
      .map((f) => {
        const [code, kind] = changeKind(f);
        // An untracked folder arrives once, as "path/to/folder/".
        const name = basename(f.file) + (f.file.endsWith('/') ? '/' : '');
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
                  it.badge ? `<span class="${it.badge === 'Free' ? 'free-badge' : 'paid-badge'}">${esc(it.badge)}</span>` : ''
                }${it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ''}</button>`
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

  // Fit each picker to the usable side of its anchor. A long live model
  // catalog must scroll inside a framed menu, never spill under the titlebar
  // or leave the selected control detached from its choices.
  const r = at
    ? { left: at.x, right: at.x, top: at.y, bottom: at.y }
    : anchor.getBoundingClientRect();
  const inset = 10;
  const gap = 6;
  const roomBelow = window.innerHeight - r.bottom - gap - inset;
  const roomAbove = r.top - gap - inset;
  const placeBelow = roomBelow >= Math.min(menu.scrollHeight, 260) || roomBelow >= roomAbove;
  const available = Math.max(120, placeBelow ? roomBelow : roomAbove);
  menu.style.maxHeight = `${available}px`;
  const left = Math.min(r.left, window.innerWidth - menu.offsetWidth - inset);
  const top = placeBelow
    ? Math.min(r.bottom + gap, window.innerHeight - menu.offsetHeight - inset)
    : Math.max(inset, r.top - gap - menu.offsetHeight);
  menu.style.left = `${Math.max(inset, left)}px`;
  menu.style.top = `${top}px`;

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
      hint: isContinuationMode(a, m.id) ? 'Reopens the latest CLI conversation once' : '',
      on: m.id === p.mode,
      run: () => {
        p.mode = m.id;
        savePrefs();
        renderHome();
        renderOnboardingConfig();
      }
    }))
  });
}

function effortMenu(anchor, forAgent) {
  const a = forAgent || agent(prefs.agentId);
  const efforts = (a && a.efforts) || [];
  if (!a || efforts.length < 2) return;
  const p = pick(a);
  openMenu(anchor, {
    title: `${a.label} · Effort`,
    items: efforts.map((effort) => ({
      label: effort.label,
      on: effort.id === p.effort,
      run: () => {
        p.effort = effort.id;
        savePrefs();
        renderHome();
        renderOnboardingConfig();
      }
    }))
  });
}

/** Model picker for the currently selected agent. Lives on its own on the
 *  home screen (next to the agent pill) so changing model takes one click,
 *  not a submenu dive. */
async function modelMenu(anchor, forAgent) {
  const a = forAgent || agent(prefs.agentId);
  if (!a) return;
  if (a.dynamic_models && !state.catalogs[a.id] && (a.available || a.catalogAvailableWithoutCommand)) await fetchCatalog(a);
  const p = pick(a);
  const choose = (id) => {
    p.model = id;
    savePrefs();
    renderHome();
    renderOnboardingConfig();
  };
  const items = allModels(a).map((m) => ({
    label: m.label,
    hint: m.provider || '',
    badge: modelPrice(a, m.id),
    on: m.id === p.model,
    run: () => choose(m.id)
  }));
  if (a.id === 'ollama-cloud') {
    items.unshift(
      { label: 'Models that run on a free Ollama account', hint: 'Sign in once with "ollama signin"', disabled: true },
      { sep: true }
    );
  }
  const pricing = a.modelPricing;
  if (pricing && pricing.note && items.length) {
    items.push({ sep: true }, { label: pricing.note, disabled: true });
  }
  const emptyText = a.id === 'ollama-cloud'
    ? 'No cloud models were returned. Check your connection and refresh.'
    : a.id === 'ollama'
      ? 'No local models downloaded yet. Run "ollama pull <model>" in a terminal, then refresh. Cloud models are under Ollama Cloud.'
      : 'No models were returned. Refresh after the CLI is ready.';
  if (!allModels(a).length) items.unshift({ label: emptyText, disabled: true });
  if (a.dynamic_models) {
    items.push({ sep: true });
    items.push({
      label: 'Refresh model list',
      hint: state.catalogs[a.id] ? `${state.catalogs[a.id].length} available` : '',
      run: async () => {
        await fetchCatalog(a);
        modelMenu(anchor, a);
      }
    });
  }
  openMenu(anchor, {
    title: `${a.label} · Model`,
    search: items.length > 8 ? 'Search models' : '',
    empty: emptyText,
    items
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
  renderOnboardingConfig();
}

/** Switch a session to a different installed CLI. A running CLI must be
 * relaunched because processes cannot change their executable in place. */
async function switchSessionAgent(s, id) {
  const next = agent(id);
  if (!s || !next || !next.available || next.id === s.agentId) return;
  // A required live model must be selected before we even ask the user to
  // replace their current process. If there is no valid choice, leave this
  // session exactly as it is and open the destination's model menu instead.
  const nextPick = pick(next);
  const nextModel = await resolveRequiredModel(next, nextPick.model, { quiet: true });
  if (next.requiresModelSelection && !nextModel) {
    toast(`Choose a live ${next.label} model, then switch this session again.`, 'error');
    await modelMenu($('headModel'), next);
    return;
  }
  const running = s.status === 'running' || s.status === 'starting';
  if (running) {
    const ok = await confirmDialog(
      `Switch to ${next.label}?`,
      'The current CLI process will stop and this session will relaunch with the selected backend.',
      'Switch and relaunch'
    );
    if (!ok) return;
  }

  invalidateLaunch(s);
  if (s.ptyId) await invoke('kill_session', { id: s.ptyId }).catch(() => {});
  const droppedImageRefs = Array.isArray(s.imageRefs) ? s.imageRefs.length : 0;
  const nextMode = freshModeId(next, nextPick.mode);
  s.agentId = next.id;
  s.modelId = nextModel || nextPick.model;
  s.modeId = nextMode;
  s.effortId = nextPick.effort;
  if (nextPick.mode !== nextMode) {
    nextPick.mode = nextMode;
    savePrefs();
  }
  // A path reference was selected for the previous agent's declared route.
  // Never carry it into a different backend by accident.
  s.imageRefs = [];
  s.command = '';
  s.working = false;
  if (s.id === state.activeId) {
    renderContext();
    renderView();
  }
  if (droppedImageRefs) toast('Removed attachments after switching agents; attach them again for this one.');
  if (s.status === 'parked') {
    renderAll();
    snapshotParked();
    return;
  }

  s.term.writeln(`\r\n\x1b[38;2;106;106;112m── switching to ${next.label} ──\x1b[0m\r\n`);
  await launch(s);
}

/**
 * A CLI model is a launch-time option. Changing it must create a new process,
 * and a resume/continue mode must not pull the old provider conversation into
 * that fresh-model launch. Keep terminal scrollback as a local record, but
 * insert an unmistakable boundary before the new process starts.
 */
async function switchSessionModel(s, modelId) {
  const a = s && agent(s.agentId);
  if (!s || !a || !modelId || modelId === s.modelId) return false;
  const plan = modelSwitchPlan(a, s.modeId, modelId);
  const nextMode = plan.modeId;
  const running = s.status === 'running' || s.status === 'starting';
  const name = modelLabel(a, modelId);

  if (running) {
    const ok = await confirmDialog(
      `Switch to ${name}?`,
      `This ends the current ${a.label} conversation and starts a fresh ${name} session. Existing terminal history remains visible above the new-session marker.`,
      'Switch and start fresh'
    );
    if (!ok) return false;
  }

  invalidateLaunch(s);
  s.modelId = plan.modelId;
  s.modeId = nextMode;
  const p = pick(a);
  p.model = plan.modelId;
  if (isContinuationMode(a, p.mode)) p.mode = freshModeId(a, p.mode);
  savePrefs();

  if (s.status === 'parked') {
    renderAll();
    snapshotParked();
    return true;
  }

  if (s.ptyId) await invoke('kill_session', { id: s.ptyId }).catch(() => {});
  s.command = '';
  s.working = false;
  s.wantPcControl = false;
  s.wantStrata = false;
  s.term.writeln(`\r\n\x1b[38;2;124;255;63m── new ${name} session (previous CLI conversation ended) ──\x1b[0m\r\n`);
  const started = await launch(s);
  if (started) toast(`Started a fresh ${name} session.`);
  return started;
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

/** ezCLI drives command line tools. A provider's desktop app does not put
 * that command on PATH, which is the usual reason an agent shows as missing. */
function notInstalledToast(a) {
  const cmd = a.command ? `"${a.command}"` : 'its command';
  if (a.install) {
    toast(`${a.label} CLI not found (${cmd}). A desktop app is not the CLI. Install it with: ${a.install} — then Reload agents in Settings. Click to copy.`, 'error', () => copy(a.install));
  } else {
    toast(`${a.label} CLI not found (${cmd}). Install the CLI so ${cmd} runs in a terminal, then Reload agents in Settings.`, 'error');
  }
}

const tabCount = (n) => (n === 0 ? 'No tabs' : n === 1 ? '1 tab' : `${n} tabs`);

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

/* ------------------------------------------------- sessions and history
 * The sheet that lists saved and imported chats lives in features/sessions.js. */
function showImportSheet() {
  Sessions.open();
}

function systemProfileSummary(profile = state.systemProfile) {
  if (!profile) return 'Hardware profile unavailable';
  const cores = Number(profile.logicalCpuCores ?? profile.logical_cpu_cores);
  const memory = Number(profile.totalMemoryGib ?? profile.total_memory_gib);
  const gpu = profile.gpuName ?? profile.gpu_name;
  const vram = Number(profile.gpuVramMib ?? profile.gpu_vram_mib);
  const parts = [];
  if (Number.isFinite(cores) && cores > 0) parts.push(`${cores} CPU threads`);
  if (Number.isFinite(memory) && memory > 0) parts.push(`${memory} GiB RAM`);
  if (gpu) {
    const vramText = Number.isFinite(vram) && vram > 0 ? `, ${(Math.round(vram / 102.4) / 10).toFixed(1)} GiB VRAM` : '';
    parts.push(`${gpu}${vramText}`);
  }
  return parts.length ? parts.join(' · ') : 'Hardware profile unavailable';
}

function ollamaRouteAdvice(a) {
  if (!a || !['ollama', 'ollama-cloud'].includes(a.id)) return '';
  const profile = systemProfileSummary();
  if (a.id === 'ollama-cloud') {
    return `Ollama Cloud runs remotely. Detected: ${profile}. Your PC does not limit the cloud catalog; install Ollama and complete “ollama signin” before starting. ezCLI will not install, sign in, or download a model for you.`;
  }
  return `Ollama Local uses this PC: ${profile}. Choose Cloud for models that do not fit locally. ezCLI lists only downloaded local models and never pulls one automatically.`;
}

function backendFacts(report) {
  if (!report) return ['Could not check your installed backends. You can choose one from the home screen.'];
  const facts = [];
  if (report.claudeCli) facts.push(report.claudeSignin || report.anthropicKey ? 'Claude Code found and signed in' : 'Claude Code found, but no sign-in. It needs a Claude Pro or Max plan, or an API key.');
  if (report.codexCli) facts.push(report.codexSignin || report.openaiKey ? 'Codex found and signed in' : 'Codex found, not signed in yet');
  if (report.chatgptCli) facts.push('ChatGPT CLI found on PATH');
  for (const id of report.freeReady || []) {
    const a = agent(id);
    if (a) facts.push(`${a.label} found (free)`);
  }
  if (report.ollama) facts.push('Ollama found, so OpenCode can also use local models');
  if (state.systemProfile) facts.push(`PC profile: ${systemProfileSummary()}`);
  if (report.anthropicKey && !report.claudeCli) facts.push('Anthropic API key configured');
  if (report.openaiKey && !report.codexCli) facts.push('OpenAI API key configured');
  return facts.length ? facts : ['No supported CLI or configured sign-in was detected yet.'];
}

/** Free agents the user doesn't have yet, with the exact install command. */
function renderFreeInstalls(report) {
  const box = $('freeInstalls');
  if (!box) return;
  const missing = ((report && report.freeMissing) || []).map(agent).filter((a) => a && a.install);
  box.hidden = !missing.length;
  box.innerHTML = missing.length
    ? `<p class="note">Free agents you can add. Install one, then reopen ezCLI:</p>${missing
        .map(
          (a) => `<div class="install-row"><span class="install-name">${esc(a.label)}</span>
          <code>${esc(a.install)}</code>
          <button class="btn quiet" data-copy-install="${esc(a.install)}">Copy</button></div>`
        )
        .join('')}`
    : '';
}

/** Keep the optional first-run sheet explicit about the agent, model and
 * reasoning effort that will be used when the user starts their first tab. */
function renderOnboardingConfig() {
  const box = $('onboardingConfig');
  const geminiNotice = $('onboardingGeminiNotice');
  const ollamaNotice = $('onboardingOllamaNotice');
  const a = agent(prefs.agentId);
  if (!a || !a.available) {
    box.hidden = true;
    if (geminiNotice) geminiNotice.hidden = true;
    if (ollamaNotice) ollamaNotice.hidden = true;
    return;
  }
  const p = pick(a);
  box.hidden = false;
  $('onboardingAgentLabel').textContent = a.label;
  $('onboardingModelValue').textContent = modelLabel(a, p.model);
  const effort = $('onboardingEffort');
  effort.hidden = (a.efforts || []).length < 2;
  $('onboardingEffortValue').textContent = effortLabel(a, p.effort);
  if (geminiNotice) geminiNotice.hidden = a.id !== 'gemini';
  if (ollamaNotice) {
    const advice = ollamaRouteAdvice(a);
    ollamaNotice.hidden = !advice;
    ollamaNotice.textContent = advice;
  }
}

function renderOnboarding() {
  const report = state.backends;
  const recommended = report && agent(report.recommended);
  $('onboardingSummary').textContent = recommended && recommended.available
    ? `${recommended.label} is the recommended start. ${report.reason || ''}`.trim()
    : (report && report.reason) || 'Choose a local CLI when you are ready. You can change it for each session.';
  const facts = backendFacts(report);
  $('backendFacts').innerHTML = facts.map((fact) => `<li>${esc(fact)}</li>`).join('');
  $('backendFoundSummary').textContent = `What ezCLI found (${facts.length})`;
  renderFreeInstalls(report);
  // Installed agents first; the ones you would have to install come last.
  const ordered = [...state.agents].sort((x, y) => Number(y.available) - Number(x.available));
  $('backendChoices').innerHTML = ordered
    .map((a) => {
      const selected = a.id === prefs.agentId;
      const recommendedClass = recommended && a.id === recommended.id ? ' recommended' : '';
      return `<button class="backend-choice${selected ? ' selected' : ''}${recommendedClass}" data-onboarding-agent="${esc(a.id)}"
        role="radio" aria-checked="${selected}" ${a.available ? '' : 'disabled'}>
        <span class="backend-choice-main">${ICONS[a.icon] || ICONS.term}<span>${esc(a.label)}</span>${a.free ? '<span class="free-badge">Free</span>' : ''}</span>
        <span class="backend-choice-status">${a.available ? (recommended && a.id === recommended.id ? 'Recommended' : 'Installed') : 'Not installed'}</span>
      </button>`;
    })
    .join('');
  renderOnboardingConfig();
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
let quitting = false;
async function guardClose(event) {
  if (closing) return;
  // Close to tray: keep every session running and just hide the window.
  if (IS_MAIN_WINDOW && prefs.closeToTray && !quitting) {
    event.preventDefault();
    T.window.getCurrentWindow().hide();
    return;
  }
  // Each window owns its own tabs, so count only this window's processes.
  const live = state.sessions.filter((s) => s.status === 'running' || s.status === 'starting').length;
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
  // Closing the window ends every process; write the sessions down first so
  // they are there, with their conversation ids, the next time ezCLI opens.
  if (typeof flushMemory === 'function') {
    flushMemory();
    await sleep(300); // let the save commands reach the backend before it exits
  }
  closing = true;
  for (const s of state.sessions) {
    invalidateLaunch(s);
    if (s.ptyId) await invoke('kill_session', { id: s.ptyId }).catch(() => {});
  }
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
  return /^(Key[NWBKTPLFEDMHG]|Digit[1-9]|ArrowLeft|ArrowRight|Slash|Equal|Minus|Digit0|NumpadAdd|NumpadSubtract|Numpad0)$/.test(e.code);
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
  } else handled = hooks.shortcut.some((fn) => {
    try {
      return fn(code, e) === true;
    } catch {
      return false;
    }
  });
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

async function startFromHome() {
  const prompt = $('homeInput').value.trim();
  const a = agent(prefs.agentId);
  const p = a && pick(a);
  const chosenMode = p ? p.mode : undefined;
  const resumesLatest = Boolean(a && isContinuationMode(a, chosenMode));
  const created = await createSession(prefs.agentId, {
    prompt,
    modeId: chosenMode,
    allowContinuation: resumesLatest
  });
  // A required-model chooser can decline a launch. Keep the draft intact so
  // the user can select a model without having to rewrite their request.
  if (!created) return;
  // Resume/Continue is deliberately a one-tab action. The next New Chat will
  // start fresh unless the person explicitly selects it again.
  if (resumesLatest && a && resetContinuationPick(a)) {
    renderHome();
    renderOnboardingConfig();
    toast('This tab resumed the latest CLI conversation. New chats will start fresh.');
  }
  if (prompt) pushHistory(prompt);
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
  $('onboardingModel').addEventListener('click', (e) => modelMenu(e.currentTarget));
  $('onboardingEffort').addEventListener('click', (e) => effortMenu(e.currentTarget));
  $('freeInstalls').addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy-install]');
    if (b) copy(b.dataset.copyInstall);
  });
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

  // home
  $('homeProject').addEventListener('click', (e) => projectMenu(e.currentTarget));
  $('homeAgent').addEventListener('click', (e) => agentOnlyMenu(e.currentTarget));
  $('homeModel').addEventListener('click', (e) => modelMenu(e.currentTarget));
  $('homeEffort').addEventListener('click', (e) => effortMenu(e.currentTarget));
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
    stopSession(active());
  });
  $('actRestart').addEventListener('click', () => active() && restartSession(active()));
  $('actResume').addEventListener('click', () => {
    const s = active();
    if (s) launch(s);
  });
  $('headModel').addEventListener('click', async (e) => {
    const anchor = e.currentTarget;
    const s = active();
    if (!s) return;
    const a = agent(s.agentId);
    if (!a) return;
    if (a.dynamic_models && !state.catalogs[a.id] && (a.available || a.catalogAvailableWithoutCommand)) await fetchCatalog(a);
    const models = allModels(a);
    openMenu(anchor, {
      title: `${a.label} · Model`,
      search: models.length > 8 ? 'Search models' : '',
      items: models.map((m) => ({
        label: m.label,
        hint: m.provider || '',
        on: m.id === s.modelId,
        run: () => switchSessionModel(s, m.id)
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
          `${a.label} restarts with ezCLI's PC-control tools attached: it can see your primary screen and move the mouse, click, scroll and type on it when it decides to. Its current conversation in this tab ends. Permission lasts only for this process and ends when it exits or you turn it off.`,
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
  $('headStrata').addEventListener('click', async () => {
    const s = active();
    if (!s || !s.ptyId || s.status !== 'running') return;
    const a = agent(s.agentId);
    if (!a || !a.pc_control || !prefs.strataUrl) return;
    const enabling = !s.strataActive;
    const ok = enabling
      ? await confirmDialog(
          'Turn on Strata?',
          `${a.label} restarts with the Strata MCP server you configured in Settings attached, alongside anything else it has. Strata is a third-party tool server (Klavis AI), not ezCLI's own — review what you connected there. Its current conversation in this tab ends.`,
          'Restart with Strata'
        )
      : await confirmDialog(
          'Turn off Strata?',
          `${a.label} restarts without Strata's tools. Its current conversation in this tab ends.`,
          'Restart without it'
        );
    if (!ok) return;
    s.wantStrata = enabling;
    await restartSession(s, { keepStrata: true, keepPcControl: Boolean(s.wantPcControl) });
    toast(enabling ? 'Strata is on for this session.' : 'Strata is off.');
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
  $('btnAttachImage').addEventListener('click', chooseImageReferences);
  $('ptyInput').addEventListener('paste', pasteImages);
  wireFileDrop();
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
  // The composer grows with attachment pills and multi-line drafts, which
  // shrinks the terminal without any window resize. Refit when that happens.
  let termRaf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(termRaf);
    termRaf = requestAnimationFrame(fitActive);
  }).observe($('termHosts'));
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
