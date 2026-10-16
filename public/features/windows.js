'use strict';
/* Multiple windows.
 *
 * "New window" opens another ezCLI window with its own tabs. "Move to new
 * window" hands a running tab over without restarting it: the process keeps
 * running in the backend, the new window replays its recent output and
 * subscribes to it, and the old window lets go without killing it. */

const Windows = (() => {
  async function openNew() {
    try {
      await invoke('open_window', { handoff: null });
    } catch (err) {
      toast(String(err), 'error');
    }
  }

  /** Detach a tab from this window without stopping its process. */
  function release(s) {
    invalidateLaunch(s);
    for (const un of s.unlisten.splice(0)) safe(un);
    s.term.dispose();
    s.host.remove();
    const i = state.sessions.indexOf(s);
    if (i >= 0) state.sessions.splice(i, 1);
    if (state.activeId === s.id) {
      const next = spaceSessions(s.spaceId)[0];
      selectSession(next ? next.id : null);
    } else {
      renderTabs();
      renderSpaces();
    }
  }

  async function moveToNewWindow(s = active()) {
    if (!s) return;
    if (!s.ptyId || s.status !== 'running') {
      // Nothing live to hand over: just open the same configuration there.
      return toast('Only a running session can move. Start it first, or use New window.');
    }
    const sp = space(s.spaceId);
    const handoff = {
      ptyId: s.ptyId,
      agentId: s.agentId,
      modelId: s.modelId,
      modeId: s.modeId,
      effortId: s.effortId,
      cwd: s.cwd,
      title: s.title,
      command: s.command,
      startedAt: s.startedAt,
      spacePath: sp ? sp.path : s.cwd,
      prompts: s.prompts || []
    };
    try {
      const id = await invoke('stash_handoff', { json: JSON.stringify(handoff) });
      release(s);
      await invoke('open_window', { handoff: id });
    } catch (err) {
      toast(String(err), 'error');
    }
  }

  /** In a new window: take over the PTY named by ?handoff=. */
  async function adopt() {
    const id = WINDOW_PARAMS.get('handoff');
    if (!id) return;
    let h;
    try {
      const json = await invoke('take_handoff', { id });
      h = json && JSON.parse(json);
    } catch {
      h = null;
    }
    if (!h || !agent(h.agentId)) return;
    if (h.spacePath) addSpace(h.spacePath, { silent: true });
    selectSpace(spaceIdFor(h.spacePath));

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
      allowTransparency: (prefs.style || 'glass') === 'glass',
      theme: TERM_THEMES[resolvedTheme()],
      scrollback: 10000
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.attachCustomKeyEventHandler((e) => !isAppShortcut(e));
    const s = {
      id: `t${++state.seq}`,
      ptyId: h.ptyId,
      launchEpoch: 1,
      spaceId: prefs.activeSpace,
      agentId: h.agentId,
      modelId: h.modelId,
      modeId: h.modeId,
      effortId: h.effortId,
      cwd: h.cwd,
      title: h.title,
      status: 'running',
      exitCode: null,
      startedAt: h.startedAt || Date.now(),
      lastOutputAt: Date.now(),
      working: false,
      unseen: false,
      command: h.command,
      pendingPrompt: '',
      draft: '',
      context: [],
      imageRefs: [],
      prompts: h.prompts || [],
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
    // Subscribe first, then replay what was already printed.
    await attachPty(s, h.ptyId, () => s.launchEpoch === 1);
    try {
      const tail = await invoke('pty_tail', { id: h.ptyId, since: 0 });
      term.write(tail.data);
    } catch {
      term.writeln('\x1b[38;2;106;106;112m(earlier output is not available)\x1b[0m');
    }
    selectSession(s.id);
    requestAnimationFrame(() => fitSession(s));
  }

  return { openNew, moveToNewWindow, adopt };
})();

hooks.boot.push(() => {
  Windows.adopt();
  if (!IS_MAIN_WINDOW) document.title = 'ezCLI · window ' + WINDOW_PARAMS.get('window');
});

/* Tab right-click menu entries. */
tabMenuItems.push((s) => [
  { label: 'Move to new window', hint: s.status === 'running' ? 'Keeps it running' : 'Running tabs only', disabled: s.status !== 'running', run: () => Windows.moveToNewWindow(s) },
  { label: 'Export as Markdown', run: () => { selectSession(s.id); Export.run('md'); } }
]);

registerCommand({ group: 'Window', label: 'New window', run: () => Windows.openNew() });
registerCommand({ group: 'Window', label: 'Move this tab to a new window', when: () => Boolean(active() && active().status === 'running'), run: () => Windows.moveToNewWindow() });
