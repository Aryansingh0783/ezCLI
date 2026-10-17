'use strict';
/* Session export and searchable transcripts.
 *
 * A tab's terminal text is saved to ~/.ezcli/transcripts when its process
 * exits or the tab closes (Settings can turn this off). Search runs over
 * those files on this PC. Export writes the current tab to a Markdown or
 * HTML file you choose. Both use the plain text of the terminal buffer, so
 * colours and cursor movement are not included. */

/** The terminal buffer as plain text, trailing blank lines removed. */
function terminalText(s) {
  const b = s.term.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (!line) continue;
    // Wrapped rows continue the previous line.
    if (line.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(true);
    else lines.push(line.translateToString(true));
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

function transcriptMeta(s) {
  const a = agent(s.agentId);
  return {
    id: s.transcriptId || (s.transcriptId = `${s.id}-${Date.now().toString(36)}`),
    title: s.title,
    agentId: s.agentId,
    agentLabel: a ? a.label : s.agentId,
    model: s.modelId ? modelLabel(a, s.modelId) : 'Default',
    cwd: s.cwd || '',
    startedAt: Math.round(s.startedAt || Date.now()),
    endedAt: Date.now(),
    providerSessionId: s.providerSessionId || '',
    modelId: s.modelId || '',
    modeId: s.modeId || '',
    effortId: s.effortId || '',
    prompts: (s.prompts || []).slice(-30)
  };
}

function saveTranscript(s) {
  if (prefs.keepTranscripts === false || !s || s.status === 'parked') return;
  const text = terminalText(s);
  if (text.trim().length < 20) return;
  invoke('save_transcript', { meta: transcriptMeta(s), text }).catch(() => {});
}

hooks.exit.push((s) => saveTranscript(s));
hooks.closing.push((s) => saveTranscript(s));
// A session is saved as soon as it goes quiet after output, and again every
// 20 seconds while it is busy, so a crash or power loss costs at most a moment.
hooks.idle.push((s) => saveTranscript(s));
setInterval(() => {
  for (const s of state.sessions) if (s.status === 'running' && s.lastOutputAt > (s.savedAt || 0)) {
    s.savedAt = Date.now();
    saveTranscript(s);
  }
}, 20000);
/** Write everything to disk now: each tab's text, the parked-tab list, and the
 *  preferences (normally saved after a short delay, which an exit would skip). */
function flushMemory() {
  state.sessions.forEach(saveTranscript);
  snapshotParked();
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
}
addEventListener('beforeunload', flushMemory);

/* ------------------------------------------------------------ export */

const Export = (() => {
  function markdown(s, text) {
    const m = transcriptMeta(s);
    return `# ${s.title}\n\n- Agent: ${m.agentLabel}\n- Model: ${m.model}\n- Folder: \`${m.cwd}\`\n- Exported: ${new Date().toLocaleString()}\n\n\`\`\`text\n${text.replace(/```/g, '`​``')}\n\`\`\`\n`;
  }

  function html(s, text) {
    const m = transcriptMeta(s);
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.title)} · ezCLI</title>
<style>
  body{margin:0;background:#0e0e0e;color:#e7e7e8;font:15px/1.5 'Segoe UI',system-ui,sans-serif}
  main{max-width:1100px;margin:0 auto;padding:40px 24px}
  h1{font-size:22px;margin:0 0 6px}
  .meta{color:#9a9aa0;font-size:13px;margin:0 0 24px}
  pre{background:#111318;border:1px solid #2a2a2e;border-radius:9px;padding:18px;overflow:auto;
      font:12.5px/1.45 'JetBrains Mono','Cascadia Code',Consolas,monospace;white-space:pre-wrap;word-break:break-word}
  ::selection{background:rgb(124 255 63 / 25%)}
</style></head>
<body><main><h1>${esc(s.title)}</h1>
<p class="meta">${esc(m.agentLabel)} · ${esc(m.model)} · ${esc(m.cwd)} · exported ${esc(new Date().toLocaleString())}</p>
<pre>${esc(text)}</pre></main></body></html>`;
  }

  async function run(format = 'md') {
    const s = active();
    if (!s) return toast('Open a session to export it.');
    const text = terminalText(s);
    if (!text.trim()) return toast('This session has no output to export yet.');
    const safe = s.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'session';
    const ext = format === 'html' ? 'html' : 'md';
    let path;
    try {
      path = await invoke('plugin:dialog|save', {
        options: {
          defaultPath: `${safe}.${ext}`,
          filters: [ext === 'html' ? { name: 'HTML page', extensions: ['html'] } : { name: 'Markdown', extensions: ['md'] }]
        }
      });
    } catch (err) {
      return toast(`Couldn't open the save dialog: ${String(err)}`, 'error');
    }
    if (!path) return;
    try {
      await invoke('write_text_file', { path, contents: ext === 'html' ? html(s, text) : markdown(s, text) });
      toast(`Exported to ${basename(path)}`, 'ok', () => invoke('open_in', { target: 'files', path: path.replace(/[\\/][^\\/]+$/, '') }).catch(() => {}));
    } catch (err) {
      toast(String(err), 'error');
    }
  }

  function menu(anchor) {
    openMenu(anchor, {
      title: 'Export session',
      items: [
        { label: 'Markdown (.md)', hint: 'Plain text in a code block', run: () => run('md') },
        { label: 'HTML page (.html)', hint: 'Opens in any browser', run: () => run('html') }
      ]
    });
  }

  return { run, menu };
})();

/* ------------------------------------------------------------ search */

const TranscriptSearch = (() => {
  let sheet = null;
  let timer = 0;
  let seq = 0;

  function fmtDate(ms) {
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function mark(snippet, q) {
    const safe = esc(snippet);
    if (!q) return safe;
    const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return safe.replace(re, (m) => `<mark>${m}</mark>`);
  }

  async function search() {
    const q = sheet.querySelector('input').value.trim();
    const mine = ++seq;
    const box = sheet.querySelector('.search-results');
    let hits;
    try {
      hits = await invoke('search_transcripts', { query: q });
    } catch (err) {
      box.innerHTML = `<p class="note">${esc(String(err))}</p>`;
      return;
    }
    if (mine !== seq) return;
    if (!hits.length) {
      box.innerHTML = q
        ? `<p class="search-empty">Nothing in your saved sessions mentions “${esc(q)}”.</p>`
        : `<p class="search-empty">No saved sessions yet. ezCLI saves a tab's text when it exits or closes${prefs.keepTranscripts === false ? ' (turned off in Settings)' : ''}.</p>`;
      return;
    }
    box.innerHTML = hits
      .map(
        (h) => `<button class="search-hit" data-id="${esc(h.meta.id)}">
          <span class="search-hit-head"><strong>${esc(h.meta.title)}</strong><span>${esc(h.meta.agentLabel)} · ${esc(basename(h.meta.cwd))} · ${esc(fmtDate(h.meta.endedAt))}</span>${h.matches ? `<span class="search-count">${h.matches} match${h.matches > 1 ? 'es' : ''}</span>` : ''}</span>
          ${h.snippets.map((sn) => `<span class="search-snippet">${mark(sn, q)}</span>`).join('')}
        </button>`
      )
      .join('');
  }

  async function show(id) {
    let t;
    try {
      t = await invoke('read_transcript', { id });
    } catch (err) {
      return toast(String(err), 'error');
    }
    const view = sheet.querySelector('.search-view');
    const q = sheet.querySelector('input').value.trim();
    view.hidden = false;
    sheet.querySelector('.search-results').hidden = true;
    view.innerHTML = `<div class="search-view-head">
        <button class="btn quiet" data-back>${ICONS.back} Results</button>
        <div><strong>${esc(t.meta.title)}</strong><span>${esc(t.meta.agentLabel)} · ${esc(t.meta.model)} · ${esc(t.meta.cwd)}</span></div>
        <span class="grow"></span>
        <button class="btn quiet" data-copytext>Copy text</button>
        <button class="btn danger quiet" data-del>Delete</button>
      </div>
      <pre class="search-text">${mark(t.text, q)}</pre>`;
    view.querySelector('[data-back]').addEventListener('click', back);
    view.querySelector('[data-copytext]').addEventListener('click', () => copy(t.text));
    view.querySelector('[data-del]').addEventListener('click', async () => {
      await invoke('delete_transcript', { id });
      back();
      search();
    });
    const first = view.querySelector('mark');
    if (first) first.scrollIntoView({ block: 'center' });
  }

  function back() {
    sheet.querySelector('.search-view').hidden = true;
    sheet.querySelector('.search-results').hidden = false;
  }

  function open() {
    if (!sheet) {
      sheet = document.createElement('dialog');
      sheet.className = 'sheet wide search-sheet';
      sheet.setAttribute('aria-labelledby', 'searchTitle');
      sheet.innerHTML = `<h2 id="searchTitle">Search sessions</h2>
        <div class="search-box">${ICONS.search}<input type="search" placeholder="Search the text of past sessions" aria-label="Search past sessions" spellcheck="false" /></div>
        <div class="search-results" aria-live="polite"></div>
        <div class="search-view" hidden></div>
        <p class="note">Saved on this PC in ~/.ezcli/transcripts for 30 days. Nothing is uploaded.</p>
        <div class="row-actions"><button class="btn quiet danger" data-clear>Delete all saved sessions</button><span class="grow"></span><form method="dialog"><button class="btn primary">Done</button></form></div>`;
      document.body.appendChild(sheet);
      sheet.querySelector('input').addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(search, 180);
      });
      sheet.querySelector('.search-results').addEventListener('click', (e) => {
        const b = e.target.closest('[data-id]');
        if (b) show(b.dataset.id);
      });
      sheet.querySelector('[data-clear]').addEventListener('click', async () => {
        if (!(await confirmDialog('Delete all saved sessions?', 'Every saved transcript on this PC is removed. Open tabs are not affected.', 'Delete all'))) return;
        const n = await invoke('clear_transcripts');
        toast(`Deleted ${n} saved session${n === 1 ? '' : 's'}.`);
        search();
      });
    }
    back();
    if (!sheet.open) sheet.showModal();
    sheet.querySelector('input').focus();
    search();
  }

  return { open };
})();

hooks.shortcut.push((code) => {
  if (code === 'KeyF') {
    TranscriptSearch.open();
    return true;
  }
  if (code === 'KeyE') {
    Export.run('md');
    return true;
  }
  return false;
});

hooks.boot.push(() => {
  const b = document.createElement('button');
  b.className = 'btn quiet';
  b.id = 'actExport';
  b.title = 'Export this session as Markdown or HTML (Ctrl+Alt+E)';
  b.textContent = 'Export';
  b.addEventListener('click', (e) => Export.menu(e.currentTarget));
  $('actStop').after(b);
  const s = $('openSearch');
  if (s) s.addEventListener('click', () => TranscriptSearch.open());
});

registerCommand({ group: 'Sessions', label: 'Search past sessions…', keys: 'Ctrl Alt F', run: () => TranscriptSearch.open() });
registerCommand({ group: 'Session', label: 'Export session as Markdown', keys: 'Ctrl Alt E', when: () => Boolean(active()), run: () => Export.run('md') });
registerCommand({ group: 'Session', label: 'Export session as HTML', when: () => Boolean(active()), run: () => Export.run('html') });
