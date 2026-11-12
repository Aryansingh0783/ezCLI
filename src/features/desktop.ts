import { $, ICONS, IS_MAIN_WINDOW, T, TERM_FONTS, TERM_THEMES, __set_applyTheme, __set_quitting, __set_selectSpace, active, addSpace, agent, applyTermPrefs, applyTheme, freshModeId, hooks, invoke, listen, pick, prefs, remeasureTerminals, renderHome, resolvedTheme, savePrefs, selectSpace, setGpu, state, svg, syncGpu, toast } from '../app';
import { late } from '../late';
import { registerCommand } from './palette';
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
    __set_quitting(true);
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
  __set_selectSpace(function (id) {
    if (id !== prefs.activeSpace) applyProjectDefaults(id);
    return original(id);
  });
}

/* ------------------------------------------------------------ terminal cursor */

/** The cursor takes the one accent colour of the theme (theme.css, --accent). */
function applyCursorColour() {
  const cursor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c9d1d9';
  for (const s of state.sessions) s.term.options.theme = { ...TERM_THEMES.dark, cursor };
}

{
  const original = applyTheme;
  __set_applyTheme(function () {
    original();
    applyCursorColour();
  });
}

hooks.launched.push(() => applyCursorColour());

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

  // Terminal typography: the bundled web font must be loaded before the terminal
  // measures its character cells, and measured again if it arrives late.
  if (document.fonts && document.fonts.load) {
    Promise.all([document.fonts.load("400 14px 'JetBrains Mono'"), document.fonts.load("600 14px 'JetBrains Mono'")])
      .then(() => document.fonts.ready)
      .then(remeasureTerminals)
      .catch(() => {});
  }

  const fontSel = $('termFont');
  if (fontSel) {
    fontSel.innerHTML = Object.entries(TERM_FONTS)
      .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
      .join('');
    const syncTermUi = () => {
      fontSel.value = TERM_FONTS[prefs.termFont] ? prefs.termFont : 'jetbrains';
      document.querySelectorAll('[data-term-line]').forEach((b) => {
        const on = b.dataset.termLine === (prefs.termLine || 'comfortable');
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      });
      document.querySelectorAll('[data-term-cursor]').forEach((b) => {
        const on = b.dataset.termCursor === (prefs.termCursor || 'bar');
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      });
      $('termBlink').checked = prefs.termBlink !== false;
      $('termGpu').checked = prefs.gpu === true;
    };
    const change = (key, value) => {
      prefs[key] = value;
      savePrefs();
      applyTermPrefs();
      syncTermUi();
    };
    fontSel.addEventListener('change', () => change('termFont', fontSel.value));
    $('termLineSeg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-term-line]');
      if (b) change('termLine', b.dataset.termLine);
    });
    $('termCursorSeg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-term-cursor]');
      if (b) change('termCursor', b.dataset.termCursor);
    });
    $('termBlink').addEventListener('change', (e) => change('termBlink', e.target.checked));
    $('termGpu').addEventListener('change', (e) => {
      prefs.gpu = e.target.checked;
      savePrefs();
      for (const s of state.sessions) setGpu(s, false);
      syncGpu();
      applyTermPrefs();
      syncTermUi();
    });
    syncTermUi();
  }

  const toggles = {
    prefNotifications: ['notifications', true],
    prefCloseToTray: ['closeToTray', false],
    prefTranscripts: ['keepTranscripts', true],
    prefProjectDefaults: ['projectDefaultsOff', false, true],
    prefShowPaid: ['showPaidModels', false],
    prefChat: ['chatView', true]
  };
  for (const [id, [key, fallback, inverted]] of Object.entries(toggles) as [string, [string, boolean, boolean?]][]) {
    const box = $(id);
    if (!box) continue;
    const value = prefs[key] ?? fallback;
    box.checked = inverted ? !value : value;
    box.addEventListener('change', () => {
      prefs[key] = inverted ? !box.checked : box.checked;
      savePrefs();
      if (key === 'chatView' && typeof late.ChatView !== 'undefined') late.ChatView.apply(true);
    });
  }
  const nameBox = $('prefName');
  if (nameBox) {
    nameBox.value = prefs.displayName || '';
    nameBox.addEventListener('input', () => {
      prefs.displayName = nameBox.value.trim();
      savePrefs();
      renderHome();
    });
  }
  applyCursorColour();
});

registerCommand({ group: 'Session', label: 'Voice typing', keys: 'Ctrl Alt D', run: () => dictate() });
