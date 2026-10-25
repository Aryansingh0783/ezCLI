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
    // A team chat reopens as the same team conversation.
    if (item.agentId === 'team') {
      if (sheet && sheet.open) sheet.close();
      return Team.openSaved(item.id);
    }
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
    renderStats();
  }

  /* ---------------------------------------------------------- home: your week */

  const DAY = 86400000;
  const fmtDur = (ms) => {
    const m = Math.round(ms / 60000);
    if (m < 1) return '0m';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  };

  /** Seven-day activity from the sessions saved on this PC. Nothing leaves it. */
  function weekStats(list, now = Date.now()) {
    const startOfToday = new Date(now).setHours(0, 0, 0, 0);
    const days = Array.from({ length: 7 }, (_, i) => ({ start: startOfToday - (6 - i) * DAY, count: 0 }));
    let sessions = 0;
    let ms = 0;
    let prompts = 0;
    const byAgent = new Map();
    for (const m of list) {
      const t = m.startedAt || 0;
      // Outside the week, or dated in the future (a clock error): not this week's activity.
      if (t < days[0].start || t > now + 5 * 60000) continue;
      sessions++;
      const end = m.endedAt && m.endedAt > t ? m.endedAt : t;
      ms += Math.min(end - t, 12 * 3600000);
      prompts += (m.prompts || []).length;
      const d = days.findIndex((x, i) => t >= x.start && (i === 6 || t < days[i + 1].start));
      if (d >= 0) days[d].count++;
      const name = m.agentLabel || m.agentId || 'Unknown agent';
      byAgent.set(name, (byAgent.get(name) || 0) + 1);
    }
    const top = [...byAgent.entries()].sort((a, b) => b[1] - a[1])[0];
    return { days, sessions, ms, prompts, top: top ? { name: top[0], share: Math.round((top[1] / sessions) * 100) } : null };
  }

  function renderStats() {
    const el = $('dashStats');
    if (!el) return;
    const st = weekStats(recent);
    el.hidden = false;
    if (!st.sessions) {
      el.innerHTML = `<div class="stat-empty">Your week shows up here once you have run a session.</div>`;
      el.classList.add('is-empty');
      return;
    }
    el.classList.remove('is-empty');
    const max = Math.max(1, ...st.days.map((d) => d.count));
    const letters = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const bars = st.days
      .map((d, i) => {
        const hgt = d.count ? Math.max(14, Math.round((d.count / max) * 100)) : 6;
        const label = letters[new Date(d.start).getDay()];
        return `<span class="stat-bar${i === 6 ? ' today' : ''}${d.count ? '' : ' none'}" title="${d.count} session${d.count === 1 ? '' : 's'}"><i style="height:${hgt}%"></i><b>${label}</b></span>`;
      })
      .join('');
    el.innerHTML = `
      <div class="stat-card stat-a"><span class="stat-label">Sessions this week</span>
        <span class="stat-value">${st.sessions}</span><div class="stat-bars" role="img" aria-label="Sessions per day for the last seven days">${bars}</div></div>
      <div class="stat-card stat-b"><span class="stat-label">Time with agents</span>
        <span class="stat-value">${esc(fmtDur(st.ms))}</span><span class="stat-sub">${st.prompts} message${st.prompts === 1 ? '' : 's'} sent</span></div>
      <div class="stat-card stat-c"><span class="stat-label">Most used</span>
        <span class="stat-value stat-text">${esc(st.top ? st.top.name : '-')}</span><span class="stat-sub">${st.top ? `${st.top.share}% of your sessions` : ''}</span></div>`;
  }

  function renderContinueRow() {
    let row = $('continueRow');
    if (!row) {
      const home = $('suggested');
      if (!home) return;
      row = document.createElement('div');
      row.id = 'continueRow';
      home.before(row);
    }
    const sp = space();
    const inFolder = (m) => sp && m.cwd && m.cwd.toLowerCase().replace(/[\\/]+$/, '').startsWith(sp.path.toLowerCase().replace(/[\\/]+$/, ''));
    const here = recent.filter(inFolder);
    const pinned = new Set(prefs.pinnedSessions || []);
    const base = (here.length ? here : recent).filter((m) => m.title);
    // Pinned sessions stay at the top from any folder; the rest fill the remaining rows.
    const pins = recent.filter((m) => m.title && pinned.has(m.id));
    const rest = base.filter((m) => !pinned.has(m.id));
    const list = [...pins, ...rest].slice(0, Math.max(6, pins.length));
    row.className = 'session-table';
    row.hidden = false;
    row.innerHTML = list.length
      ? `<div class="session-thead"><span>Name</span><span>Agent</span><span>When</span><span></span></div>${list
          .map((m) => {
            const on = pinned.has(m.id);
            return `<div class="session-trow${on ? ' pinned' : ''}" role="button" tabindex="0" data-continue-id="${esc(m.id)}" title="${esc(m.cwd || '')}">
              <span class="session-name">${esc(m.title)}</span>
              <span class="session-agent">${esc(m.agentLabel || m.agentId)}</span>
              <span class="session-when">${esc(fmtAgo(m.endedAt || m.startedAt))}</span>
              <button type="button" class="pin-btn${on ? ' on' : ''}" data-pin="${esc(m.id)}" aria-pressed="${on}" aria-label="${on ? 'Unpin' : 'Pin'} ${esc(m.title)}" title="${on ? 'Unpin' : 'Pin to the top'}">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>
              </button></div>`;
          })
          .join('')}`
      : '<div class="session-empty">No saved sessions yet. Start one above and it shows up here.</div>';
  }

  /** Reopen a saved session (same agent, folder and CLI conversation). */
  function resumeSaved(id) {
    const m = recent.find((x) => x.id === id);
    if (!m) return false;
    continueItem({
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
    return true;
  }

  function togglePin(id) {
    const set = new Set(prefs.pinnedSessions || []);
    set.has(id) ? set.delete(id) : set.add(id);
    prefs.pinnedSessions = [...set];
    savePrefs();
    renderContinueRow();
    const btn = document.querySelector(`[data-pin="${CSS.escape(id)}"]`);
    if (btn) btn.focus();
  }

  /* ---------------------------------------------------------- Codex session ids */

  /** Codex chooses its own conversation id. Read it back from its rollout file
   *  so this tab can be resumed with the real conversation. */
  async function findCodexId(s) {
    const a = agent(s.agentId);
    if (!a || !a.sessionResume || a.sessionNew || s.providerSessionId || !s.ptyId) return; // Codex and OpenCode choose their own ids
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

  return { open, load, refreshHome, renderContinueRow, continueItem, findCodexId, togglePin, weekStats, resumeSaved, recentSaved: () => recent };
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
  // Rows are focusable: Up/Down move between them, Enter or Space opens one.
  $('home').addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('.session-trow');
    if (!row || e.target.closest('[data-pin]')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = [...document.querySelectorAll('#continueRow .session-trow')];
      const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      row.click();
    }
  });
  $('home').addEventListener('click', (e) => {
    if (e.target.closest('[data-continue-all]')) return Sessions.open();
    const pin = e.target.closest('[data-pin]');
    if (pin) return Sessions.togglePin(pin.dataset.pin);
    const card = e.target.closest('[data-continue-id]');
    if (!card) return;
    Sessions.resumeSaved(card.dataset.continueId);
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
