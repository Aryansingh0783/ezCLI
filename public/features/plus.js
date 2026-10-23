'use strict';
/* The composer's "+" menu: add files or a folder, insert a slash command,
 * switch connectors, and reach ezCLI's tools, from one place in both the home
 * and the session composer. */

/* Slash commands each CLI documents for its own interactive prompt. Picking
 * one only types it into the composer; nothing is sent until you press Enter. */
const SLASH_COMMANDS = {
  claude: [
    ['/help', 'List every command'],
    ['/clear', 'Start the conversation over'],
    ['/compact', 'Summarize the conversation to free up context'],
    ['/model', 'Switch model'],
    ['/resume', 'Resume an earlier conversation'],
    ['/init', 'Write a CLAUDE.md for this project'],
    ['/review', 'Review a pull request'],
    ['/memory', 'Edit memory files'],
    ['/mcp', 'Manage MCP servers'],
    ['/cost', 'Show this session’s usage']
  ],
  codex: [
    ['/model', 'Switch model and reasoning effort'],
    ['/approvals', 'Change what Codex may do without asking'],
    ['/new', 'Start a new conversation'],
    ['/compact', 'Summarize the conversation to free up context'],
    ['/diff', 'Show the changes Codex made'],
    ['/init', 'Write an AGENTS.md for this project'],
    ['/status', 'Show session settings and usage'],
    ['/mcp', 'List MCP tools']
  ],
  opencode: [
    ['/help', 'List every command'],
    ['/new', 'Start a new session'],
    ['/models', 'Switch model'],
    ['/sessions', 'Switch session'],
    ['/compact', 'Summarize the session'],
    ['/undo', 'Undo the last change'],
    ['/redo', 'Redo the last undone change'],
    ['/init', 'Write an AGENTS.md for this project']
  ],
  gemini: [
    ['/help', 'List every command'],
    ['/clear', 'Clear the screen and context'],
    ['/compress', 'Summarize the conversation to free up context'],
    ['/memory', 'Show or add to memory'],
    ['/mcp', 'List MCP servers and tools'],
    ['/stats', 'Show session statistics'],
    ['/tools', 'List available tools']
  ]
};

const Plus = {
  /** Which composer the menu belongs to, decided by where it was opened. */
  target: 'pty',

  input() {
    return $(this.target === 'home' ? 'homeInput' : 'ptyInput');
  },

  /** The agent the composer talks to: the session's, or the one picked on home. */
  agent() {
    const s = this.target === 'pty' ? active() : null;
    return agent(s ? s.agentId : prefs.agentId);
  },

  insert(text) {
    const el = this.input();
    if (!el) return;
    const at = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, at);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    el.value = `${before}${pad}${text}${el.value.slice(el.selectionEnd ?? at)}`;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    const end = before.length + pad.length + text.length;
    el.setSelectionRange(end, end);
  },

  async pick(options) {
    try {
      const chosen = T.dialog && T.dialog.open ? await T.dialog.open(options) : await invoke('plugin:dialog|open', { options });
      return Array.isArray(chosen) ? chosen : chosen ? [chosen] : [];
    } catch (e) {
      toast(`Couldn’t open the picker: ${e}`, 'error');
      return [];
    }
  },

  /** In a session, files become attachments (images/videos) or context the
   *  CLI reads by path. On home there is no session yet, so the paths go into
   *  the first message itself. */
  async addFiles() {
    const s = this.target === 'pty' ? active() : null;
    const paths = await this.pick({ multiple: true, defaultPath: (s && s.cwd) || space()?.path || state.homeCwd });
    if (!paths.length) return;
    if (s) return addAttachments(paths, s);
    this.insert(paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' '));
  },

  async addFolder() {
    const s = this.target === 'pty' ? active() : null;
    const [dir] = await this.pick({ directory: true, multiple: false, defaultPath: (s && s.cwd) || space()?.path || state.homeCwd });
    if (!dir) return;
    if (s) return addToChat(dir);
    this.insert(/\s/.test(dir) ? `"${dir}"` : dir);
  },

  slash(anchor) {
    const a = this.agent();
    const family = a ? (a.mcp && a.mcp !== 'none' ? a.mcp : String(a.command || '').toLowerCase()) : '';
    const list = SLASH_COMMANDS[family] || SLASH_COMMANDS[a && a.id] || [['/help', 'List every command']];
    openMenu(anchor, {
      title: `${a ? a.label : 'Agent'} · slash commands`,
      search: 'Filter commands',
      items: list.map(([cmd, hint]) => ({ label: cmd, hint, run: () => this.insert(cmd + ' ') }))
    });
  },

  connectors(anchor) {
    const list = prefs.connectors || [];
    const items = list.map((c) => ({
      label: c.name || 'Connector',
      hint: c.url ? (c.enabled ? 'on' : 'off') : 'no URL yet',
      on: Boolean(c.enabled && c.url),
      disabled: !c.url,
      run: () => {
        c.enabled = !c.enabled;
        savePrefs();
        if (typeof renderConnectors === 'function') renderConnectors();
        renderHead();
        toast(`${c.name || 'Connector'} ${c.enabled ? 'on' : 'off'} for new sessions. Restart a running session to apply it there.`);
      }
    }));
    if (items.length) items.push({ sep: true });
    items.push({ label: 'Manage connectors…', run: () => Plus.openSettings('connectorList') });
    openMenu(anchor, { title: 'Connectors', items });
  },

  tools(anchor) {
    const s = active();
    const a = s && agent(s.agentId);
    const pc = $('headControl');
    const items = [
      {
        label: s && s.pcControl ? 'PC control: on' : 'PC control',
        hint: !s ? 'start a session first' : !(a && a.pc_control) ? `not available for ${a ? a.label : 'this agent'}` : 'let the agent see and use this PC',
        on: Boolean(s && s.pcControl),
        disabled: !s || !(a && a.pc_control) || !pc,
        run: () => pc && pc.click()
      },
      { label: 'Agent browser', hint: 'the browser agents drive', run: () => $('browserBtn') && $('browserBtn').click() },
      { label: 'Second brain', hint: 'map of all your projects', run: () => $('brainBtn') && $('brainBtn').click() },
      { label: 'Knowledge graph settings…', run: () => Plus.openSettings('graphifyStatus') }
    ];
    openMenu(anchor, { title: 'Tools', items });
  },

  openSettings(scrollToId) {
    $('settingsBtn').click();
    requestAnimationFrame(() => $(scrollToId) && $(scrollToId).scrollIntoView({ block: 'center' }));
  },

  open(anchor, target) {
    this.target = target;
    const enabled = (prefs.connectors || []).filter((c) => c.enabled && c.url).length;
    openMenu(anchor, {
      items: [
        { label: 'Add files or photos', hint: 'Ctrl+U', run: () => this.addFiles() },
        { label: 'Add folder', run: () => this.addFolder() },
        { label: 'Slash commands', hint: '›', run: () => this.slash(anchor) },
        { label: 'Connectors', hint: (prefs.connectors || []).length ? `${enabled} on ›` : 'none yet ›', run: () => this.connectors(anchor) },
        { label: 'Tools', hint: '›', run: () => this.tools(anchor) }
      ]
    });
  }
};

function plusButton(target) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'plus-btn';
  b.title = 'Add files, a folder, slash commands, connectors and tools';
  b.setAttribute('aria-label', 'Add to message');
  b.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    Plus.open(b, target);
  });
  return b;
}

hooks.boot.push(() => {
  const pty = document.querySelector('#ptyComposer .composer-row');
  if (pty) pty.prepend(plusButton('pty'));
  const home = document.querySelector('#homeComposer .pill-group');
  if (home) home.before(plusButton('home'));
  // "Add files or photos" covers what the separate Attach chip did.
  const attach = $('btnAttachImage');
  if (attach) attach.classList.add('superseded');

  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || e.key.toLowerCase() !== 'u') return;
    const id = document.activeElement && document.activeElement.id;
    if (id !== 'ptyInput' && id !== 'homeInput') return;
    e.preventDefault();
    Plus.target = id === 'homeInput' ? 'home' : 'pty';
    Plus.addFiles();
  });
});
