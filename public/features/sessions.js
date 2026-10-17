'use strict';
/* Sessions: ezCLI's memory.
 *
 * Every tab is saved on this PC when it runs (see transcripts.js), and the chats
 * Claude Code and Codex already keep are listed beside them. From any entry you
 * can Continue:
 *   - Claude Code and Codex resume the real conversation by its id, with full
 *     context, exactly as `claude --resume` and `codex resume` do;
 *   - any other agent starts in the same folder with a handoff message built
 *     from the end of that conversation.
 * The home screen shows the latest sessions for the open folder as one-click
 * "Continue" cards. Nothing leaves this PC from here. */

const Sessions = (() => {
  let sheet = null;
  let items = [];
  let imports = null; // last list_imports catalog
  let selected = null;
  let filter = 'all';
  let query = '';
  let textHits = new Map(); // saved id -> {snippets, matches}
  let timer = 0;
  let loading = false;

  const NATIVE = { 'claude-code': 'claude-code', codex: 'codex' };

  /* ---------------------------------------------------------- data */

  async function load() {
    loading = true;
    const [saved, cat] = await Promise.all([
      invoke('list_saved_sessions').catch(() => []),
      invoke('list_imports').catch(() => null)
    ]);
    imports = cat;
    const nativeIds = new Set(saved.map((m) => m.providerSessionId).filter(Boolean));
    const rows = saved.map((m) => ({
      kind: 'saved',
      key: `s:${m.id}`,
      id: m.id,
      title: m.title || 'Untitled session',
      agentId: m.agentId,
      agentLabel: m.agentLabel || m.agentId,
      cwd: m.cwd || '',
      at: m.endedAt || m.startedAt || 0,
      sessionId: m.providerSessionId || '',
      model: m.model,
      meta: m
    }));
    for (const c of (cat && cat.conversations) || []) {
      // A chat ezCLI ran is already listed; show it once.
      if (nativeIds.has(c.sessionId)) continue;
      rows.push({
        kind: 'import',
        key: `i:${c.id}`,
        id: c.id,
        title: c.title,
        agentId: c.source,
        agentLabel: c.source === 'codex' ? 'Codex' : 'Claude Code',
        cwd: c.cwd || '',
        at: c.updatedAt,
        sessionId: c.sessionId,
        sizeKb: c.sizeKb,
        project: c.project
      });
    }
    rows.sort((a, b) => b.at - a.at);
    items = rows;
    loading = false;
    return rows;
  }

  const importIdFor = (sessionId) => {
    const c = imports && imports.conversations.find((x) => x.sessionId === sessionId);
    return c ? c.id : '';
  };

  /* ---------------------------------------------------------- continue */

  const tail = (text, n) => (text.length > n ? '…' + text.slice(text.length - n) : text);

  function handoffText(item, messages, savedText) {
    const where = item.cwd ? ` in ${item.cwd}` : '';
    const head = `I'm continuing earlier work from a previous session ("${item.title}") that ran with ${item.agentLabel}${where}. Read the end of that conversation below, check the current state of the files, and carry on from where it stopped.`;
    let body = '';
    if (messages && messages.length) {
      const recent = messages.slice(-10).map((m) => `${m.role === 'user' ? 'Me' : 'You'}: ${m.content.length > 1500 ? m.content.slice(0, 1500) + '…' : m.content}`);
      body = recent.join('\n\n');
    } else if (savedText) {
      body = tail(savedText.trim(), 6000);
    }
    const asked = (item.meta && item.meta.prompts ? item.meta.prompts.slice(-5) : []).map((p) => `- ${p.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
    return [head, asked ? `My recent requests:\n${asked}` : '', body ? `The end of that conversation:\n---\n${tail(body, 7000)}\n---` : ''].filter(Boolean).join('\n\n');
  }

  async function folderExists(path) {
    if (!path) return false;
    try {
      await invoke('list_dir', { path });
      return true;
    } catch {
      return false;
    }
  }

  /** Continue `item` in `agentId` (default: the agent that ran it). */
  async function continueItem(item, agentId) {
    const wanted = agentId || item.agentId;
    let a = agent(wanted);
    if (!a || !a.available) a = agent(prefs.agentId);
    if (!a) return toast('No agent is installed to continue this session.', 'error');
    const hasFolder = await folderExists(item.cwd);
    if (item.cwd && !hasFolder) toast(`The folder ${item.cwd} no longer exists, so this starts in your current folder.`);
    if (hasFolder) addSpace(item.cwd, { silent: true });
    const spaceId = hasFolder ? spaceIdFor(item.cwd) : prefs.activeSpace;
    if (hasFolder) selectSpace(spaceId);
    const title = `Continue: ${item.title}`.slice(0, 60);
    const native = a.id === item.agentId && a.sessionResume && item.sessionId && hasFolder;
    if (sheet && sheet.open) sheet.close();
    if (native) {
      const s = await createSession(a.id, { spaceId, cwd: item.cwd, resumeId: item.sessionId, title });
      if (s) toast(`Resumed ${a.label} with the full conversation.`, 'ok');
      return;
    }
    let messages = null;
    let savedText = '';
    try {
      if (item.kind === 'import') messages = (await invoke('read_imported_chat', { id: item.id })).messages;
      else {
        const nativeImport = item.sessionId && importIdFor(item.sessionId);
        if (nativeImport) messages = (await invoke('read_imported_chat', { id: nativeImport })).messages;
        else savedText = (await invoke('read_transcript', { id: item.id })).text || '';
      }
    } catch {
      /* continue with just the title and prompts */
    }
    const prompt = handoffText(item, messages, savedText);
    const s = await createSession(a.id, { spaceId, cwd: hasFolder ? item.cwd : undefined, prompt, title });
    if (s) toast(`Started ${a.label} with a summary of the earlier session.`, 'ok');
  }

  function continueMenu(anchor, item) {
    const nativeAgent = agent(item.agentId);
    const canNative = nativeAgent && nativeAgent.available && nativeAgent.sessionResume && item.sessionId;
    const others = state.agents.filter((a) => a.available && a.id !== item.agentId);
    openMenu(anchor, {
      title: 'Continue this session',
      items: [
        ...(canNative ? [{ label: `Resume in ${nativeAgent.label}`, hint: 'same conversation, full context', run: () => continueItem(item, item.agentId) }] : []),
        ...(nativeAgent && nativeAgent.available && !canNative ? [{ label: `Continue in ${nativeAgent.label}`, hint: 'with a summary', run: () => continueItem(item, item.agentId) }] : []),
        ...(others.length ? [{ sep: true }] : []),
        ...others.map((a) => ({ label: `Continue in ${a.label}`, hint: a.free ? 'Free · with a summary' : 'with a summary', run: () => continueItem(item, a.id) }))
      ]
    });
  }

  /* ---------------------------------------------------------- sheet */

  const matchesFilter = (it) => filter === 'all' || (filter === 'ezcli' ? it.kind === 'saved' : it.agentId === filter);

  function visible() {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (!matchesFilter(it)) return false;
      if (!q) return true;
      const hit = textHits.get(it.id);
      return it.kind === 'saved' && hit ? true : `${it.title} ${it.cwd} ${it.agentLabel}`.toLowerCase().includes(q);
    });
  }

  function renderList() {
    const list = sheet.querySelector('#sessionsList');
    const rows = visible();
    const hidden = imports ? imports.hiddenAutomatic : 0;
    if (!rows.length) {
      list.innerHTML = `<p class="search-empty">${loading ? 'Loading sessions…' : query ? `Nothing matches “${esc(query)}”.` : 'No sessions yet. Start a tab and it is saved here automatically.'}</p>`;
    } else {
      list.innerHTML = rows
        .map((it) => {
          const hit = textHits.get(it.id);
          const sn = hit && hit.snippets[0] ? `<span class="search-snippet">${esc(hit.snippets[0])}</span>` : '';
          const where = it.cwd ? basename(it.cwd) : it.project || '';
          return `<button type="button" class="session-row${selected && selected.key === it.key ? ' selected' : ''}" data-key="${esc(it.key)}" role="option" aria-selected="${Boolean(selected && selected.key === it.key)}">
            <span class="session-title">${esc(it.title)}</span>
            <span class="session-meta"><b>${esc(it.agentLabel)}</b>${where ? ` · ${esc(where)}` : ''} · ${esc(fmtAgo(it.at))}${it.kind === 'saved' ? '' : ' · from CLI history'}${it.sessionId && NATIVE[it.agentId] ? ' · resumable' : ''}</span>${sn}
          </button>`;
        })
        .join('');
    }
    sheet.querySelector('#sessionsCount').textContent = `${rows.length} session${rows.length === 1 ? '' : 's'}${hidden ? ` · ${hidden} automatic tool sessions hidden` : ''}`;
  }

  async function showItem(item) {
    selected = item;
    renderList();
    const pane = sheet.querySelector('#sessionsPreview');
    pane.innerHTML = '<p class="note">Loading…</p>';
    let body = '';
    let note = '';
    try {
      const nativeId = item.kind === 'import' ? item.id : item.sessionId && importIdFor(item.sessionId);
      if (nativeId) {
        const chat = await invoke('read_imported_chat', { id: nativeId });
        const shown = chat.messages;
        note = chat.truncated ? `Showing the newest ${shown.length} of ${chat.totalMessages} messages.` : `${chat.totalMessages} messages.`;
        body = shown
          .map((m) => `<article class="import-message ${m.role === 'user' ? 'user' : 'assistant'}"><h4>${m.role === 'user' ? 'You' : 'Assistant'}</h4><pre>${esc(m.content)}</pre></article>`)
          .join('');
      } else {
        const t = await invoke('read_transcript', { id: item.id });
        note = 'Terminal text saved from this tab.';
        body = `<pre class="search-text">${esc(t.text)}</pre>`;
      }
    } catch (err) {
      body = `<p class="note">${esc(String(err))}</p>`;
    }
    if (selected !== item) return;
    const resumable = agent(item.agentId) && agent(item.agentId).sessionResume && item.sessionId;
    pane.innerHTML = `<header class="import-preview-head">
        <h3>${esc(item.title)}</h3>
        <p>${esc(item.agentLabel)}${item.cwd ? ` · ${esc(item.cwd)}` : ''} · ${esc(fmtAgo(item.at))}</p>
      </header>
      <div class="row-actions session-actions">
        <button class="btn primary" data-continue>${resumable ? 'Resume' : 'Continue'}</button>
        <button class="btn" data-continue-in>Continue in…</button>
        <button class="btn quiet" data-copy-handoff>Copy handoff</button>
        <span class="grow"></span>
        ${item.kind === 'saved' ? '<button class="btn quiet danger" data-delete>Delete</button>' : ''}
      </div>
      <p class="note">${esc(note)}${resumable ? ' Resume reopens the conversation itself.' : ' Continue starts with a summary of this one.'}</p>
      <div class="import-messages">${body}</div>`;
    pane.querySelector('[data-continue]').addEventListener('click', () => continueItem(item));
    pane.querySelector('[data-continue-in]').addEventListener('click', (e) => continueMenu(e.currentTarget, item));
    pane.querySelector('[data-copy-handoff]').addEventListener('click', async () => {
      let msgs = null;
      let txt = '';
      try {
        const nativeId = item.kind === 'import' ? item.id : item.sessionId && importIdFor(item.sessionId);
        if (nativeId) msgs = (await invoke('read_imported_chat', { id: nativeId })).messages;
        else txt = (await invoke('read_transcript', { id: item.id })).text || '';
      } catch {
        /* copy what we have */
      }
      copy(handoffText(item, msgs, txt));
    });
    const del = pane.querySelector('[data-delete]');
    if (del) {
      del.addEventListener('click', async () => {
        if (!(await confirmDialog('Delete this saved session?', 'The saved copy on this PC is removed. The CLI’s own history is not touched.', 'Delete'))) return;
        await invoke('delete_transcript', { id: item.id });
        selected = null;
        pane.innerHTML = '<p class="note">Choose a session to read it or continue it.</p>';
        await load();
        renderList();
        refreshHome();
      });
    }
  }

  async function runSearch() {
    const q = query.trim();
    textHits = new Map();
    if (q.length >= 2) {
      try {
        for (const h of await invoke('search_transcripts', { query: q })) textHits.set(h.meta.id, { snippets: h.snippets, matches: h.matches });
      } catch {
        /* title search still works */
      }
    }
    renderList();
  }

  function build() {
    sheet = document.createElement('dialog');
    sheet.className = 'sheet wide sessions-sheet';
    sheet.setAttribute('aria-labelledby', 'sessionsTitle');
    sheet.innerHTML = `<h2 id="sessionsTitle">Sessions</h2>
      <p class="note">Every tab is saved on this PC, and the chats Claude Code and Codex already keep are listed too. Nothing is uploaded.</p>
      <div class="sessions-bar">
        <div class="search-box">${ICONS.search}<input id="sessionsSearch" type="search" placeholder="Search titles, folders and conversation text" aria-label="Search sessions" spellcheck="false" /></div>
        <div class="segmented" id="sessionsFilter" role="radiogroup" aria-label="Show">
          <button class="theme-option on" data-filter="all" role="radio">All</button>
          <button class="theme-option" data-filter="ezcli" role="radio">Saved by ezCLI</button>
          <button class="theme-option" data-filter="claude-code" role="radio">Claude Code</button>
          <button class="theme-option" data-filter="codex" role="radio">Codex</button>
        </div>
      </div>
      <div class="sessions-layout">
        <div class="sessions-list" id="sessionsList" role="listbox" aria-label="Sessions"></div>
        <section class="sessions-preview" id="sessionsPreview" aria-live="polite"><p class="note">Choose a session to read it or continue it.</p></section>
      </div>
      <div class="row-actions wrap">
        <span class="note" id="sessionsCount"></span>
        <span class="grow"></span>
        <button class="btn quiet" id="sessionsRefresh">Refresh</button>
        <button class="btn quiet danger" id="sessionsClear">Delete all saved sessions</button>
        <form method="dialog"><button class="btn primary">Done</button></form>
      </div>`;
    document.body.appendChild(sheet);
    sheet.querySelector('#sessionsSearch').addEventListener('input', (e) => {
      query = e.target.value;
      clearTimeout(timer);
      renderList();
      timer = setTimeout(runSearch, 200);
    });
    sheet.querySelector('#sessionsFilter').addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      filter = b.dataset.filter;
      sheet.querySelectorAll('#sessionsFilter [data-filter]').forEach((x) => {
        const on = x === b;
        x.classList.toggle('on', on);
        x.setAttribute('aria-checked', String(on));
      });
      renderList();
    });
    sheet.querySelector('#sessionsList').addEventListener('click', (e) => {
      const row = e.target.closest('[data-key]');
      const it = row && items.find((x) => x.key === row.dataset.key);
      if (it) showItem(it);
    });
    sheet.querySelector('#sessionsList').addEventListener('dblclick', (e) => {
      const row = e.target.closest('[data-key]');
      const it = row && items.find((x) => x.key === row.dataset.key);
      if (it) continueItem(it);
    });
    sheet.querySelector('#sessionsRefresh').addEventListener('click', async () => {
      await load();
      renderList();
    });
    sheet.querySelector('#sessionsClear').addEventListener('click', async () => {
      if (!(await confirmDialog('Delete all saved sessions?', 'Every session ezCLI saved on this PC is removed. Claude Code and Codex keep their own history.', 'Delete all'))) return;
      const n = await invoke('clear_transcripts');
      toast(`Deleted ${n} saved session${n === 1 ? '' : 's'}.`);
      await load();
      renderList();
      refreshHome();
    });
    sheet.addEventListener('close', refreshHome);
  }

  async function open() {
    if (!sheet) build();
    if (!sheet.open) sheet.showModal();
    renderList();
    await load();
    renderList();
    sheet.querySelector('#sessionsSearch').focus();
  }

  /* ---------------------------------------------------------- home: continue cards */

  let recent = [];

  async function refreshHome() {
    try {
      recent = await invoke('list_saved_sessions');
    } catch {
      recent = [];
    }
    renderContinueRow();
  }

  function renderContinueRow() {
    const home = $('suggested');
    if (!home) return;
    let row = $('continueRow');
    if (!row) {
      row = document.createElement('div');
      row.id = 'continueRow';
      row.className = 'continue-row';
      home.before(row);
    }
    const sp = space();
    const inFolder = (m) => sp && m.cwd && m.cwd.toLowerCase().replace(/[\\/]+$/, '').startsWith(sp.path.toLowerCase().replace(/[\\/]+$/, ''));
    const here = recent.filter(inFolder);
    const list = (here.length ? here : recent).filter((m) => m.title).slice(0, 3);
    row.hidden = !list.length;
    row.innerHTML = list.length
      ? `<span class="continue-label">${here.length ? 'Pick up where you left off' : 'Recent sessions'}</span>${list
          .map(
            (m) => `<button type="button" class="continue-card" data-continue-id="${esc(m.id)}" title="${esc(m.cwd || '')}">
              <span class="continue-title">${esc(m.title)}</span>
              <span class="continue-meta">${esc(m.agentLabel || m.agentId)} · ${esc(fmtAgo(m.endedAt || m.startedAt))}</span></button>`
          )
          .join('')}<button type="button" class="continue-more" data-continue-all>All sessions</button>`
      : '';
  }

  /* ---------------------------------------------------------- Codex session ids */

  /** Codex chooses its own conversation id. Read it back from its rollout file
   *  so this tab can be resumed with the real conversation. */
  async function findCodexId(s) {
    const a = agent(s.agentId);
    if (!a || !a.sessionResume || a.sessionNew || s.providerSessionId || !s.ptyId) return;
    try {
      const id = await invoke('find_provider_session', { agentId: s.agentId, cwd: s.cwd, sinceMs: Math.max(0, (s.startedAt || Date.now()) - 5000) });
      if (id && !s.providerSessionId) {
        s.providerSessionId = id;
        snapshotParked();
        if (typeof saveTranscript === 'function') saveTranscript(s);
      }
    } catch {
      /* try again on the next signal */
    }
  }

  return { open, load, refreshHome, renderContinueRow, continueItem, findCodexId, recentSaved: () => recent };
})();

hooks.launched.push((s) => {
  for (const ms of [5000, 15000, 45000, 120000]) setTimeout(() => Sessions.findCodexId(s), ms);
});
hooks.idle.push((s) => Sessions.findCodexId(s));
hooks.exit.push((s) => Sessions.findCodexId(s));

{
  const original = renderHome;
  // eslint-disable-next-line no-global-assign
  renderHome = function (...args) {
    const r = original(...args);
    Sessions.renderContinueRow();
    return r;
  };
}

hooks.boot.push(() => {
  Sessions.refreshHome();
  setInterval(Sessions.refreshHome, 60000);
  $('home').addEventListener('click', (e) => {
    if (e.target.closest('[data-continue-all]')) return Sessions.open();
    const card = e.target.closest('[data-continue-id]');
    if (!card) return;
    const m = Sessions.recentSaved().find((x) => x.id === card.dataset.continueId);
    if (!m) return;
    Sessions.continueItem({
      kind: 'saved',
      id: m.id,
      title: m.title,
      agentId: m.agentId,
      agentLabel: m.agentLabel || m.agentId,
      cwd: m.cwd || '',
      sessionId: m.providerSessionId || '',
      at: m.endedAt,
      meta: m
    });
  });
});
hooks.exit.push(() => setTimeout(Sessions.refreshHome, 1500));
hooks.closing.push(() => setTimeout(Sessions.refreshHome, 1500));

hooks.shortcut.push((code) => {
  if (code !== 'KeyH') return false;
  Sessions.open();
  return true;
});

registerCommand({ group: 'Sessions', label: 'Sessions and history…', keys: 'Ctrl Alt H', run: () => Sessions.open() });
