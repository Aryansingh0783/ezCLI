'use strict';
/* Desktop integration and small preferences:
 * - a system notification when a long task finishes out of view,
 * - close to tray, quit from the tray,
 * - folders handed over by a second launch (`ezcli.exe <folder>`),
 * - per-project defaults (agent, model, mode, effort per folder),
 * - accent colours,
 * - Windows voice typing in the composer. */

/* ------------------------------------------------------------ notifications */

const NOTIFY_AFTER_MS = 15000;

hooks.output.push((s) => {
  if (!s.busySince) s.busySince = Date.now();
});

hooks.idle.push((s) => {
  const busyFor = s.busySince ? Date.now() - s.busySince : 0;
  s.busySince = 0;
  if (prefs.notifications === false || busyFor < NOTIFY_AFTER_MS) return;
  if (document.hasFocus() && s.id === state.activeId) return;
  const secs = Math.round(busyFor / 1000);
  invoke('notify', { title: `${s.title} is waiting for you`, body: `It stopped writing after ${secs >= 60 ? Math.round(secs / 60) + ' min' : secs + ' s'} of work.` }).catch(() => {});
});

hooks.exit.push((s, code) => {
  if (prefs.notifications === false || document.hasFocus()) return;
  invoke('notify', { title: `${s.title} exited`, body: code === 0 ? 'The process finished normally.' : `The process exited with code ${code}.` }).catch(() => {});
});

/* ------------------------------------------------------------ tray, folders */

hooks.boot.push(() => {
  if (!IS_MAIN_WINDOW) return;
  // The tray's Quit asks the main window, which owns the running-sessions check.
  listen('tray-quit', async () => {
    quitting = true;
    T.window.getCurrentWindow().close();
  });
  // A second launch with a folder argument opens that folder here.
  listen('open-folder', (e) => {
    if (e.payload) addSpace(e.payload);
  });
  invoke('launch_folder')
    .then((folder) => folder && addSpace(folder))
    .catch(() => {});
});

/* ------------------------------------------------------------ per-project defaults */

/** Remember the configuration each folder last launched with. */
hooks.launched.push((s) => {
  const a = agent(s.agentId);
  if (!a) return;
  prefs.projectDefaults ||= {};
  prefs.projectDefaults[s.spaceId] = {
    agentId: s.agentId,
    model: s.modelId,
    // A Continue/Resume pick is a one-off; never make it a folder default.
    mode: freshModeId(a, s.modeId),
    effort: s.effortId,
    at: Date.now()
  };
  savePrefs();
});

function applyProjectDefaults(spaceId) {
  if (prefs.projectDefaultsOff) return;
  const d = prefs.projectDefaults && prefs.projectDefaults[spaceId];
  const a = d && agent(d.agentId);
  if (!a || !a.available) return;
  prefs.agentId = a.id;
  const p = pick(a);
  if (d.model) p.model = d.model;
  if (d.mode) p.mode = d.mode;
  if (d.effort) p.effort = d.effort;
  savePrefs();
}

{
  const original = selectSpace;
  // eslint-disable-next-line no-global-assign
  selectSpace = function (id) {
    if (id !== prefs.activeSpace) applyProjectDefaults(id);
    return original(id);
  };
}

/* ------------------------------------------------------------ accent colours */

const ACCENTS = {
  lime: { label: 'Lime', dark: ['#7cff3f', '#5bbf2f'], light: ['#368f06', '#2c7405'] },
  sky: { label: 'Sky', dark: ['#5cc8ff', '#3a9fd6'], light: ['#0b6fb0', '#095a8f'] },
  violet: { label: 'Violet', dark: ['#b69cff', '#9277e6'], light: ['#6a3fd0', '#5531ab'] },
  amber: { label: 'Amber', dark: ['#ffc04d', '#d99a26'], light: ['#9a6200', '#7c4f00'] },
  rose: { label: 'Rose', dark: ['#ff7aa2', '#e0577f'], light: ['#b8325c', '#962849'] },
  mint: { label: 'Mint', dark: ['#4fe3c1', '#2fbf9e'], light: ['#0f7f68', '#0b6553'] },
  indigo: { label: 'Indigo', dark: ['#8aa0ff', '#6b82ee'], light: ['#3f4fd0', '#3340ab'] },
  teal: { label: 'Teal', dark: ['#43d6d0', '#28b3ad'], light: ['#0a7c77', '#07615d'] },
  coral: { label: 'Coral', dark: ['#ff8f66', '#e06f45'], light: ['#c24a22', '#9c3a1a'] },
  slate: { label: 'Slate', dark: ['#9fb0c6', '#7d8ea6'], light: ['#4a5568', '#3a4556'] }
};

/* Full theme presets: each sets the base light/dark mode, a page/card palette
 * (data-palette, defined in reference.css) and an accent, in one tap. */
const THEME_PRESETS = {
  daylight: { label: 'Daylight', theme: 'light', palette: 'daylight', accent: 'lime', swatch: '#e7edfa' },
  mist: { label: 'Mist', theme: 'light', palette: 'mist', accent: 'sky', swatch: '#eceff4' },
  grape: { label: 'Grape', theme: 'light', palette: 'grape', accent: 'violet', swatch: '#efeafb' },
  sunset: { label: 'Sunset', theme: 'light', palette: 'sunset', accent: 'coral', swatch: '#fdeadf' },
  forest: { label: 'Forest', theme: 'light', palette: 'forest', accent: 'mint', swatch: '#e7f1e9' },
  midnight: { label: 'Midnight', theme: 'dark', palette: 'midnight', accent: 'lime', swatch: '#15171d' },
  nebula: { label: 'Nebula', theme: 'dark', palette: 'nebula', accent: 'violet', swatch: '#1a1630' },
  ocean: { label: 'Ocean', theme: 'dark', palette: 'ocean', accent: 'teal', swatch: '#0d1f26' }
};

function applyPreset(key) {
  const p = THEME_PRESETS[key];
  if (!p) return;
  prefs.theme = p.theme;
  prefs.palette = p.palette;
  prefs.accent = p.accent;
  savePrefs();
  applyTheme();
  renderThemePresets();
}

function renderThemePresets() {
  const seg = $('themePresets');
  if (!seg) return;
  seg.innerHTML = Object.entries(THEME_PRESETS)
    .map(
      ([k, v]) => `<button class="theme-preset ${prefs.palette === v.palette ? 'on' : ''}" data-preset="${k}"
        role="radio" aria-checked="${prefs.palette === v.palette}" title="${v.label}">
        <span class="theme-preset-chip" style="--chip:${v.swatch}"></span><span>${v.label}</span></button>`
    )
    .join('');
}

function applyAccent() {
  const key = ACCENTS[prefs.accent] ? prefs.accent : 'lime';
  const [brand, dim] = ACCENTS[key][resolvedTheme()];
  const root = document.documentElement.style;
  root.setProperty('--brand', brand);
  root.setProperty('--brand-dim', dim);
  const base = typeof Glass !== 'undefined' ? Glass.terminalTheme() : TERM_THEMES[resolvedTheme()];
  for (const s of state.sessions) s.term.options.theme = { ...base, cursor: brand };
  document.querySelectorAll('[data-accent]').forEach((b) => {
    const on = b.dataset.accent === key;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
}

{
  const original = applyTheme;
  // eslint-disable-next-line no-global-assign
  applyTheme = function () {
    original();
    applyAccent();
  };
}

hooks.launched.push(() => applyAccent());

/* ------------------------------------------------------------ voice typing */

ICONS.mic = svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>', 13);

async function dictate() {
  const el = active() ? $('ptyInput') : $('homeInput');
  el.focus();
  try {
    await invoke('dictate');
  } catch (err) {
    toast(String(err), 'error');
  }
}

hooks.shortcut.push((code) => {
  if (code !== 'KeyD') return false;
  dictate();
  return true;
});

/* ------------------------------------------------------------ settings wiring */

hooks.boot.push(() => {
  const mic = document.createElement('button');
  mic.className = 'chip icon-chip';
  mic.id = 'btnDictate';
  mic.title = 'Voice typing (Ctrl+Alt+D). Uses Windows speech recognition.';
  mic.setAttribute('aria-label', 'Voice typing');
  mic.innerHTML = ICONS.mic;
  mic.addEventListener('click', dictate);
  $('btnAttachImage').after(mic);

  const homeMic = mic.cloneNode(true);
  homeMic.id = 'homeDictate';
  homeMic.addEventListener('click', dictate);
  document.querySelector('#homeComposer .send-key').before(homeMic);

  const presets = $('themePresets');
  if (presets) {
    renderThemePresets();
    presets.addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]');
      if (b) applyPreset(b.dataset.preset);
    });
  }

  const seg = $('accentSeg');
  if (seg) {
    seg.innerHTML = Object.entries(ACCENTS)
      .map(([k, v]) => `<button class="accent-swatch" data-accent="${k}" role="radio" aria-label="${v.label}" title="${v.label}" style="--swatch:${v[resolvedTheme()][0]}"></button>`)
      .join('');
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-accent]');
      if (!b) return;
      prefs.accent = b.dataset.accent;
      savePrefs();
      applyAccent();
    });
  }
  const toggles = {
    prefNotifications: ['notifications', true],
    prefCloseToTray: ['closeToTray', false],
    prefTranscripts: ['keepTranscripts', true],
    prefProjectDefaults: ['projectDefaultsOff', false, true],
    prefShowPaid: ['showPaidModels', false]
  };
  for (const [id, [key, fallback, inverted]] of Object.entries(toggles)) {
    const box = $(id);
    if (!box) continue;
    const value = prefs[key] ?? fallback;
    box.checked = inverted ? !value : value;
    box.addEventListener('change', () => {
      prefs[key] = inverted ? !box.checked : box.checked;
      savePrefs();
    });
  }
  applyAccent();
});

registerCommand({ group: 'Session', label: 'Voice typing', keys: 'Ctrl Alt D', run: () => dictate() });
