'use strict';
/* The chat view: a session as a conversation instead of a terminal.
 *
 * Every agent keeps running in its terminal underneath; this view reads the conversation and
 * lays it out like a chat: your messages as bubbles, the agent's replies as formatted text, and
 * its tool calls folded into one line you can open. Where a CLI keeps a readable log of the
 * conversation (Claude Code and Codex), the view reads that log, so it is exact. For every other
 * agent it is built from what you sent and the text the agent printed, with the terminal's
 * borders, spinners and key hints removed. Nothing here sends anything: your message still goes
 * through the same composer. A Chat / Terminal switch in the header (Ctrl+Alt+T) shows the real
 * terminal at any time, for sign-in screens, permission questions and anything else a CLI asks. */

const ChatView = {
  el: null,
  sig: '',
  open: new Set(),
  shut: new Set(),
  cache: new Map(),
  FEED: new Set(['claude-code', 'claude-chat', 'codex', 'opencode', 'deepseek', 'freebuff']),
  /** How often each feed is read. OpenCode runs a command to export, so it is read less often. */
  every(s) {
    if (s.agentId === 'opencode' || s.agentId === 'deepseek') return s.working ? 4000 : 12000;
    return 1200;
  },

  st(s) {
    if (!s.chat) s.chat = { turns: [], events: [], results: new Map(), offset: 0, feedAt: 0, mode: null, busy: false };
    return s.chat;
  },

  /* ----------------------------------------------------------- recording */

  onSent(s, text) {
    const c = this.st(s);
    let marker = null;
    try {
      if (s.term.buffer.active.type === 'normal') marker = s.term.registerMarker(0);
    } catch {
      /* the turn is still shown; only its reply is lost */
    }
    c.turns.push({ text: String(text || ''), marker, at: Date.now() });
    while (c.turns.length > 300) {
      const old = c.turns.shift();
      if (old.marker) old.marker.dispose();
    }
    this.apply(true);
  },

  /** New events from the CLI's own conversation file, when it keeps one. */
  async feed(s) {
    const c = this.st(s);
    if (c.busy || !this.FEED.has(s.agentId) || s.status !== 'running') return;
    if (!s.providerSessionId && s.agentId !== 'freebuff') return;
    if (Date.now() - c.feedAt < this.every(s)) return;
    c.feedAt = Date.now();
    c.busy = true;
    try {
      const page = await invoke('chat_feed', {
        agentId: s.agentId,
        sessionId: s.providerSessionId || '',
        offset: c.offset,
        sinceMs: Math.round(s.startedAt || Date.now()),
        cwd: s.cwd || null
      });
      if (!page) return;
      if (page.reset) {
        c.events = [];
        c.results = new Map();
      }
      for (const e of page.events) {
        if (e.kind === 'result') c.results.set(e.id, e);
        else c.events.push(e);
      }
      if (c.events.length > 4000) c.events = c.events.slice(-3000);
      c.offset = page.offset;
    } catch {
      /* the file may not exist yet; the next poll tries again */
    } finally {
      c.busy = false;
    }
  },

  /* ----------------------------------------------------------- terminal text */

  /** The terminal's text between two buffer lines, wrapped rows joined. */
  linesBetween(s, from, to) {
    const b = s.term.buffer.active;
    const out = [];
    for (let i = Math.max(0, from); i < to; i++) {
      const l = b.getLine(i);
      if (!l) continue;
      const t = l.translateToString(true);
      if (l.isWrapped && out.length) out[out.length - 1] += t;
      else out.push(t);
    }
    return out;
  },

  /** Terminal chrome that is not part of an answer. */
  clean(lines, ask) {
    const border = /^[\s─-╿▀-▟]*$/;
    const chrome = /esc to (interrupt|cancel)|\? for shortcuts|shift\+tab|ctrl\+[a-z] to|context left|no sandbox|bypass permissions|auto-accept|accept edits|\d+% context|type your message|\/help for|tab to queue|esc again|ctrl\+c again|^\s*[▸▶▾]?\s*(thought|thinking) for \d+/i;
    const spinner = /^\s*([✢✳✻✽✶·*]\s+\S.*…|[⠀-⣿]\s)/;
    const head = String(ask || '').trim().slice(0, 18);
    const out = [];
    for (const raw of lines) {
      if (border.test(raw)) {
        if (!raw.trim() || out.length === 0 || out[out.length - 1] !== '') out.push('');
        continue;
      }
      let t = raw.replace(/^\s*[│┃║]\s?/, '').replace(/\s?[│┃║]\s*$/, '');
      if (chrome.test(t) || spinner.test(t)) continue;
      const bare = t.replace(/^\s*[>›❯!]\s*/, '');
      if (!bare.trim() && /^\s*[>›❯]/.test(t)) continue;
      if (head && /^\s*[>›❯!]/.test(t) && bare.startsWith(head)) continue;
      t = t.replace(/^(\s*)[✦⏺]\s+/, '$1').replace(/^(\s*)[●•]\s+/, '$1- ');
      out.push(t);
    }
    // the input box at the bottom of a live screen is not part of the answer
    while (out.length && (out[out.length - 1] === '' || /^\s*[>›❯]/.test(out[out.length - 1]))) out.pop();
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  },

  /* ----------------------------------------------------------- the conversation */

  model(s) {
    const c = this.st(s);
    let items = [];
    if (c.events.length) items = this.fromEvents(c);
    else if (c.turns.length) items = this.fromTurns(s, c);
    // Keys name a message across redraws; scoped to the session so open/closed groups never leak between tabs.
    for (const it of items) it.key = `${s.id}:${it.key}`;
    // A CLI that redraws its screen can hide the reply for a moment; keep showing the last good view.
    if (items.length) {
      c.last = items;
      c.shown = true;
    } else if (c.shown && c.last) return c.last;
    return items;
  },

  fromEvents(c) {
    const items = [];
    let tools = null;
    c.events.forEach((e, i) => {
      if (e.kind === 'tool') {
        if (!tools) {
          tools = { k: 'tools', key: `t${i}`, list: [] };
          items.push(tools);
        }
        const r = c.results.get(e.id);
        tools.list.push({ tool: e.tool, text: e.text, detail: e.detail || '', done: Boolean(r), result: r ? r.text : '', error: r ? r.error : false });
        return;
      }
      tools = null;
      items.push({ k: e.kind === 'user' ? 'user' : 'assistant', key: `e${i}`, text: e.text, hard: false, ts: e.ts });
    });
    return items;
  },

  fromTurns(s, c) {
    const b = s.term.buffer.active;
    // A full-screen app has no readable history in the terminal. It stays in the terminal until its own
    // log (see feed) delivers the conversation, so a question it is asking is never hidden.
    if (b.type === 'alternate') return [];
    const norm = (x) => String(x).replace(/\s+/g, ' ').trim();
    const from = Math.max(0, b.length - 4000);
    const rows = this.linesBetween(s, from, b.length);
    const flat = rows.map(norm);
    // Each turn starts where the CLI echoed what was sent, searched in order.
    let cursor = 0;
    const at = c.turns.map((t) => {
      if (t.reply != null) return -2; // finished and kept
      const head = norm(t.text).slice(0, 28);
      if (!head) return -1;
      for (let k = cursor; k < flat.length; k++) {
        if (flat[k].includes(head)) {
          cursor = k + 1;
          return k;
        }
      }
      return -1;
    });
    const items = [];
    c.turns.forEach((t, i) => {
      items.push({ k: 'user', key: `u${i}`, text: t.text, ts: t.at });
      if (t.reply != null) {
        if (t.reply) items.push({ k: 'assistant', key: `a${i}`, text: t.reply, hard: true });
        return;
      }
      if (at[i] < 0) return;
      const next = at.slice(i + 1).find((x) => x >= 0);
      const end = next === undefined ? rows.length : next;
      const text = this.clean(rows.slice(at[i] + 1, end), t.text);
      const sealed = next !== undefined && !s.working;
      if (sealed) t.reply = text;
      if (text) items.push({ k: 'assistant', key: `a${i}`, text, hard: true });
    });
    // Until the agent has answered or started working on it, the terminal may be holding a question; keep showing it.
    return items.some((x) => x.k === 'assistant') || s.working ? items : [];
  },

  /** A question the CLI is waiting on, which only the terminal can answer. */
  waiting(s) {
    if (s.working || s.status !== 'running') return false;
    const c = this.st(s);
    const last = c.events[c.events.length - 1];
    if (last && last.kind === 'tool' && !c.results.has(last.id)) return true;
    const b = s.term.buffer.active;
    const rows = [];
    for (let i = Math.max(0, b.length - 14); i < b.length; i++) {
      const l = b.getLine(i);
      if (l) rows.push(l.translateToString(true));
    }
    return /\((y\/n|yes\/no)\)|\[y\/n\]|press enter|use enter to select|do you want to|enter to confirm|allow this|❯\s*1\./i.test(rows.join('\n'));
  },

  /* ----------------------------------------------------------- markdown */

  inline(src) {
    const parts = String(src).split(/(`[^`\n]+`)/g);
    return parts
      .map((p, i) => {
        if (i % 2) return this.codeSpan(p.slice(1, -1));
        let t = esc(p);
        t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
        t = t.replace(/(^|[^*\w])\*([^*\s][^*\n]*)\*(?![*\w])/g, '$1<em>$2</em>');
        t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
        t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
        return t;
      })
      .join('');
  },

  /** Light colouring for code: comments, strings, numbers and common keywords. */
  highlight(body) {
    const re = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|(?<![^\s])#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b(const|let|var|function|return|if|else|for|while|import|from|export|default|class|new|async|await|try|catch|throw|def|fn|pub|use|impl|struct|enum|match|self|None|True|False|null|true|false|undefined|in|of|and|or|not|with|as|type|interface|extends|switch|case|break|continue|echo|git|npm|cd)\b/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(body))) {
      out += esc(body.slice(last, m.index));
      const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : 'k';
      out += `<span class="tk-${cls}">${esc(m[0])}</span>`;
      last = re.lastIndex;
    }
    return out + esc(body.slice(last));
  },

  code(lang, body) {
    const shown = body.length > 20000 ? esc(body) : this.highlight(body);
    return `<div class="cm-code"><div class="cm-code-head"><span>${esc(lang.trim() || 'text')}</span><button type="button" class="cm-copy">Copy</button></div><pre><code>${shown}</code></pre></div>`;
  },

  text(src, hard) {
    const lines = String(src).split('\n');
    let html = '';
    let para = [];
    let list = null;
    const flushP = () => {
      if (para.length) html += `<p>${para.map((l) => this.inline(l)).join(hard ? '<br>' : ' ')}</p>`;
      para = [];
    };
    const flushL = () => {
      if (list) html += `<${list.t}>${list.items.map((x) => `<li>${this.inline(x)}</li>`).join('')}</${list.t}>`;
      list = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      let m;
      if (!ln.trim()) {
        flushP();
        flushL();
      } else if ((m = /^(#{1,4})\s+(.*)$/.exec(ln))) {
        flushP();
        flushL();
        const n = m[1].length + 1;
        html += `<h${n}>${this.inline(m[2])}</h${n}>`;
      } else if (/^\s*([-*_])\1{2,}\s*$/.test(ln)) {
        flushP();
        flushL();
        html += '<hr>';
      } else if ((m = /^\s*[-*+•]\s+(.*)$/.exec(ln))) {
        flushP();
        if (!list || list.t !== 'ul') {
          flushL();
          list = { t: 'ul', items: [] };
        }
        list.items.push(m[1]);
      } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(ln))) {
        flushP();
        if (!list || list.t !== 'ol') {
          flushL();
          list = { t: 'ol', items: [] };
        }
        list.items.push(m[1]);
      } else if ((m = /^\s*>\s?(.*)$/.exec(ln))) {
        flushP();
        flushL();
        html += `<blockquote>${this.inline(m[1])}</blockquote>`;
      } else if (/^\s*\|.*\|\s*$/.test(ln)) {
        flushP();
        flushL();
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        i--;
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
        const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
        const th = cells(body[0] || '');
        html += `<div class="cm-table"><table><thead><tr>${th.map((x) => `<th>${this.inline(x)}</th>`).join('')}</tr></thead><tbody>${body
          .slice(1)
          .map((r) => `<tr>${cells(r).map((x) => `<td>${this.inline(x)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`;
      } else if (list && /^\s{2,}\S/.test(ln)) {
        list.items[list.items.length - 1] += ' ' + ln.trim();
      } else {
        flushL();
        para.push(ln.trim());
      }
    }
    flushP();
    flushL();
    return html;
  },

  md(src, hard) {
    const re = /```([^\n`]*)\n([\s\S]*?)(```|$)/g;
    let last = 0;
    let html = '';
    let m;
    while ((m = re.exec(src))) {
      html += this.text(src.slice(last, m.index), hard);
      html += this.code(m[1], m[2].replace(/\n$/, ''));
      last = re.lastIndex;
      if (!m[0].length) break;
    }
    return html + this.text(src.slice(last), hard);
  },

  /* ----------------------------------------------------------- drawing */

  toolWord(name) {
    const n = String(name).toLowerCase();
    if (/bash|shell|powershell|exec|command|cmd/.test(n)) return 'command';
    if (/read|view|cat|open/.test(n)) return 'read';
    if (/edit|write|patch|apply|replace/.test(n)) return 'edit';
    if (/grep|glob|search|find|list|ls/.test(n)) return 'search';
    return 'tool';
  },

  toolsHtml(it) {
    const done = it.list.filter((t) => t.done).length;
    const words = {};
    for (const t of it.list) words[this.toolWord(t.tool)] = (words[this.toolWord(t.tool)] || 0) + 1;
    const nouns = { command: ['Ran', 'command', 'commands'], read: ['Read', 'file', 'files'], edit: ['Edited', 'file', 'files'], search: ['Ran', 'search', 'searches'], tool: ['Used', 'tool', 'tools'] };
    const label = Object.entries(words)
      .map(([w, n]) => `${nouns[w][0]} ${n} ${n === 1 ? nouns[w][1] : nouns[w][2]}`)
      .join(', ');
    const running = done < it.list.length;
    let add = 0;
    let del = 0;
    for (const t of it.list) {
      for (const l of (t.detail || '').split('\n')) {
        if (l.startsWith('+') && !l.startsWith('+++')) add++;
        else if (l.startsWith('-') && !l.startsWith('---')) del++;
      }
    }
    const rows = it.list
      .map((t) => {
        const fileish = ['read', 'edit'].includes(this.toolWord(t.tool)) && this.looksLikePath(t.text);
        const what = fileish ? this.codeSpan(t.text) : `<code>${esc(t.text || '')}</code>`;
        // An edit shows what changed; its "file updated" result says nothing more.
        const body = t.detail ? this.diffHtml(t.detail) : t.result ? `<pre>${esc(t.result)}</pre>` : '';
        return `<div class="cm-tool${t.error ? ' err' : ''}${t.done ? '' : ' run'}"><span class="cm-tool-name">${esc(t.tool)}</span>${what}${body}${t.detail && t.error && t.result ? `<pre>${esc(t.result)}</pre>` : ''}</div>`;
      })
      .join('');
    const counts = add || del ? `<span class="cm-counts">${add ? `<b class="hc-add">+${add}</b>` : ''}${del ? `<b class="hc-del">-${del}</b>` : ''}</span>` : '';
    const forced = it.list.some((t) => t.error) && !this.shut.has(it.key);
    return `<details class="cm cm-tools" data-key="${it.key}"${this.open.has(it.key) || forced ? ' open' : ''}><summary>${running ? dotsHtml : ''}<span>${esc(label)}</span>${counts}</summary>${rows}</details>`;
  },

  /** `-`/`+` lines as a small coloured diff. */
  diffHtml(detail) {
    const rows = detail
      .split('\n')
      .map((l) => {
        const c = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') || l.startsWith('***') ? 'hunk' : 'ctx';
        return `<span class="d-${c}">${esc(l) || ' '}</span>`;
      })
      .join('');
    return `<pre class="cm-diff">${rows}</pre>`;
  },

  /** Text that names a file: a path with a folder, or a name with an extension. */
  looksLikePath(t) {
    const x = String(t || '').trim();
    if (!x || x.length > 260 || /\s/.test(x) || /^(https?:|www\.)/i.test(x) || /^v?\d+(\.\d+)+$/.test(x)) return false;
    const m = /^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]*[A-Za-z_][\w@-]*\.([A-Za-z][A-Za-z0-9]{0,5})(?::\d+(?::\d+)?)?$/.exec(x);
    if (!m) return false;
    // `src/app.js` is a file; `console.log` is code. Without a folder, only known file types count.
    return /[\\/]/.test(x) || this.EXT.test(m[1]);
  },
  EXT: /^(js|mjs|cjs|jsx|ts|tsx|json|md|mdx|css|scss|less|html|htm|vue|svelte|rs|py|go|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|toml|yaml|yml|lock|txt|sh|ps1|bat|cmd|sql|xml|ini|cfg|conf|gradle|dart|lua|zig|ex|exs|scala|dockerfile|env|csv|svg|png|jpg|gif)$/i,

  /** Inline code; a file path becomes a link that opens it in the explorer. */
  codeSpan(t) {
    if (!this.looksLikePath(t)) return `<code>${esc(t)}</code>`;
    return `<code class="cm-path" role="link" tabindex="0" data-path="${esc(t)}" title="Open in the explorer">${esc(t)}</code>`;
  },

  /** How long the agent has been on this message, from when you sent it. */
  elapsed(s) {
    const c = this.st(s);
    const last = c.turns[c.turns.length - 1];
    const from = last ? last.at : 0;
    if (!from) return '';
    const sec = Math.max(0, Math.round((Date.now() - from) / 1000));
    if (sec < 4 || sec > 6 * 3600) return '';
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  },

  /** The time a message was sent, for the row of actions under it. */
  when(ts) {
    const d = new Date(ts);
    if (!ts || Number.isNaN(d.getTime())) return '';
    return `<span class="cm-time">${esc(d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span>`;
  },

  /** Markdown is the costly part of a redraw, and finished messages do not change. */
  mdCached(s, it) {
    const key = `${s.id}|${it.key}|${it.hard ? 1 : 0}`;
    const hit = this.cache.get(key);
    if (hit && hit.text === it.text) return hit.html;
    const html = this.md(it.text, it.hard);
    this.cache.set(key, { text: it.text, html });
    if (this.cache.size > 600) this.cache.delete(this.cache.keys().next().value);
    return html;
  },

  html(s, items) {
    let h = '';
    this.cur = items;
    for (const it of items) {
      const when = this.when(it.ts);
      if (it.k === 'user') h += `<div class="cm cm-user"><div class="cm-bubble">${esc(it.text)}</div><div class="cm-acts"><button type="button" data-act="edit" data-key="${it.key}">Edit</button><button type="button" data-act="copy" data-key="${it.key}">Copy</button>${when}</div></div>`;
      else if (it.k === 'assistant' && it.text.startsWith('**Stopped:**')) h += `<div class="cm cm-stop" role="status"><div class="cm-stop-body">${esc(it.text.replace(/^\*\*Stopped:\*\*\s*/, ''))}</div><div class="cm-stop-acts"><button type="button" data-act="retry" data-key="${it.key}">Edit last message and retry</button></div></div>`;
      else if (it.k === 'assistant') h += `<div class="cm cm-ai"><div class="cm-body">${this.mdCached(s, it)}</div><div class="cm-acts"><button type="button" data-act="copy" data-key="${it.key}">Copy</button>${when}</div></div>`;
      else if (it.k === 'tools') h += this.toolsHtml(it);
    }
    if (s.working) h += `<div class="cm cm-working" aria-label="Working">${dotsHtml}<span class="cm-elapsed">${this.elapsed(s)}</span></div>`;
    else if (this.waiting(s)) h += '<div class="cm cm-wait"><b>Waiting for your answer</b><span>The agent asked something that only the terminal can take.</span><button type="button" class="cm-open-term">Open the terminal</button></div>';
    return h;
  },

  mount() {
    const panel = document.querySelector('.terminal-panel');
    if (!panel || this.el) return;
    const el = document.createElement('div');
    el.id = 'chatView';
    el.className = 'chat-view';
    el.hidden = true;
    el.setAttribute('role', 'log');
    el.setAttribute('aria-label', 'Conversation');
    el.innerHTML = '<div class="chat-col" id="chatCol"></div><button type="button" id="chatLatest" class="chat-latest" aria-label="Jump to the latest message" hidden>Latest</button>';
    el.addEventListener('scroll', () => this.syncLatest(), { passive: true });
    panel.append(el);
    this.el = el;
    el.addEventListener('click', (e) => {
      const path = e.target.closest('.cm-path');
      if (path) {
        openTerminalPath(path.dataset.path);
        return;
      }
      const act = e.target.closest('[data-act]');
      if (act) {
        if (act.dataset.act === 'retry') {
          const users = (this.cur || []).filter((x) => x.k === 'user');
          const last = users[users.length - 1];
          if (last) {
            const box = $('ptyInput');
            box.value = last.text;
            autoGrow(box);
            box.focus();
            box.setSelectionRange(box.value.length, box.value.length);
          }
          return;
        }
        const it = (this.cur || []).find((x) => x.key === act.dataset.key);
        if (!it) return;
        if (act.dataset.act === 'copy') {
          navigator.clipboard.writeText(it.text).then(() => {
            act.textContent = 'Copied';
            setTimeout(() => (act.textContent = 'Copy'), 1200);
          });
        } else {
          const box = $('ptyInput');
          box.value = it.text;
          autoGrow(box);
          box.focus();
          box.setSelectionRange(box.value.length, box.value.length);
        }
        return;
      }
      if (e.target.closest('#chatLatest')) {
        this.el.scrollTo({ top: this.el.scrollHeight, behavior: 'smooth' });
        return;
      }
      const a = e.target.closest('a[href]');
      if (a) {
        e.preventDefault();
        openUrl(a.getAttribute('href'));
        return;
      }
      const cp = e.target.closest('.cm-copy');
      if (cp) {
        const code = cp.closest('.cm-code').querySelector('code').textContent;
        navigator.clipboard.writeText(code).then(() => {
          cp.textContent = 'Copied';
          setTimeout(() => (cp.textContent = 'Copy'), 1200);
        });
        return;
      }
      if (e.target.closest('.cm-open-term')) this.setMode('terminal');
    });
    el.addEventListener('toggle', (e) => {
      const d = e.target;
      if (d.matches && d.matches('details[data-key]')) {
        if (d.open) {
          this.open.add(d.dataset.key);
          this.shut.delete(d.dataset.key);
        } else {
          this.open.delete(d.dataset.key);
          this.shut.add(d.dataset.key);
        }
      }
    }, true);
    const head = $('headTitle');
    if (head) {
      const t = document.createElement('div');
      t.id = 'headView';
      t.className = 'head-view';
      t.setAttribute('role', 'group');
      t.setAttribute('aria-label', 'View');
      t.hidden = true;
      t.innerHTML = '<button type="button" data-v="chat">Chat</button><button type="button" data-v="terminal">Terminal</button>';
      t.addEventListener('click', (e) => {
        const b = e.target.closest('[data-v]');
        if (b) this.setMode(b.dataset.v);
      });
      const after = $('headChanges') || head;
      after.after(t);
    }
  },

  setMode(mode) {
    const s = active();
    if (!s) return;
    this.st(s).mode = mode;
    this.apply(true);
    if (mode === 'terminal') setTimeout(() => s.term.focus(), 30);
    else setTimeout(() => $('ptyInput') && $('ptyInput').focus(), 30);
  },

  toggle() {
    const s = active();
    if (!s || !this.model(s).length) return;
    this.setMode(this.st(s).mode === 'terminal' ? 'chat' : 'terminal');
  },

  /** Show or hide the chat over the terminal for the active session, and redraw it. */
  apply(force) {
    if (!this.el) return;
    const s = active();
    const items = s && prefs.chatView !== false ? this.model(s) : [];
    const on = Boolean(s && items.length && this.st(s).mode !== 'terminal' && !Team.isOpen());
    const toggle = $('headView');
    if (toggle) {
      toggle.hidden = !(s && items.length && prefs.chatView !== false);
      for (const b of toggle.querySelectorAll('button')) {
        const v = b.dataset.v;
        const sel = (v === 'chat') === on;
        b.classList.toggle('on', sel);
        b.setAttribute('aria-pressed', String(sel));
      }
    }
    const panel = this.el.parentElement;
    panel.classList.toggle('chat-on', on);
    const box = $('ptyInput');
    if (box) {
      if (!box.dataset.ph) box.dataset.ph = box.placeholder;
      const a = s && agent(s.agentId);
      box.placeholder = on && a ? `Reply to ${a.label}. Enter sends, Shift+Enter adds a line.` : box.dataset.ph;
    }
    this.el.hidden = !on;
    if (!on) {
      this.sig = '';
      if (typeof ChatFind !== 'undefined' && ChatFind.isOpen()) ChatFind.close();
      return;
    }
    const surface = getComputedStyle(document.querySelector('.main')).backgroundColor;
    if (surface && !/rgba\(.*,\s*0\)$/.test(surface) && surface !== 'transparent') this.el.style.background = surface;
    const html = this.html(s, items);
    // The elapsed-time text changes every second; it is patched in place so the page is not
    // redrawn (which would clear a selection) just because a clock moved.
    const stable = html.replace(/<span class="cm-elapsed">[^<]*<\/span>/, '');
    const sig = `${s.id}|${stable.length}|${stable.slice(-200)}|${s.working}`;
    const clock = this.el.querySelector('.cm-elapsed');
    if (clock) clock.textContent = this.elapsed(s);
    if (!force && sig === this.sig) return;
    this.sig = sig;
    const near = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 90;
    $('chatCol').innerHTML = html;
    if (near || force) this.el.scrollTop = this.el.scrollHeight;
    this.syncLatest();
    if (typeof ChatFind !== 'undefined' && ChatFind.isOpen()) ChatFind.run(false);
  },

  /** A "Latest" button appears when you have scrolled up from the newest message. */
  syncLatest() {
    const b = $('chatLatest');
    if (!b || !this.el) return;
    b.hidden = this.el.hidden || this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 240;
  },

  tick() {
    const s = active();
    if (!s) return;
    this.feed(s).then(() => this.apply());
  }
};

hooks.boot.push(() => {
  ChatView.mount();
  ChatView.apply();
});
hooks.sent.push((s, text) => ChatView.onSent(s, text));
hooks.view.push(() => ChatView.apply(true));
hooks.tabs.push(() => ChatView.apply());
hooks.idle.push(() => ChatView.tick());
hooks.output.push(() => {
  if (ChatView.timer) return;
  ChatView.timer = setTimeout(() => {
    ChatView.timer = null;
    ChatView.tick();
  }, 450);
});
setInterval(() => ChatView.tick(), 1500);
registerCommand({ group: 'Session', label: 'Switch between chat and terminal', keys: 'Ctrl Alt T', run: () => ChatView.toggle() });
window.addEventListener(
  'keydown',
  (e) => {
    if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.code === 'KeyT') {
      e.preventDefault();
      e.stopPropagation();
      ChatView.toggle();
    }
  },
  true
);

// typing anywhere in the chat goes to the message box
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target && e.target.classList && e.target.classList.contains('cm-path')) {
    e.preventDefault();
    openTerminalPath(e.target.dataset.path);
    return;
  }
  if (!ChatView.el || ChatView.el.hidden || e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1) return;
  const t = e.target;
  if (t && (t.closest('input, textarea, select, [contenteditable]') || t.closest('dialog[open]'))) return;
  const box = $('ptyInput');
  if (box) box.focus();
});

/* ------------------------------------------------ export the conversation */
ChatView.exportable = function (s) {
  if (prefs.chatView === false) return null;
  const items = this.model(s);
  return items.length ? items : null;
};

ChatView.markdown = function (items, who) {
  const fence = (t) => String(t).replace(/```/g, "'''");
  return items
    .map((it) => {
      if (it.k === 'user') return `## You\n\n${it.text}\n`;
      if (it.k === 'assistant') return `## ${who || 'Assistant'}\n\n${it.text}\n`;
      const rows = it.list.map((t) => `- ${t.tool}${t.text ? `: \`${fence(t.text).replace(/`/g, "'")}\`` : ''}${t.error ? ' (failed)' : ''}`);
      return `<details><summary>${rows.length} tool call${rows.length === 1 ? '' : 's'}</summary>\n\n${rows.join('\n')}\n\n</details>\n`;
    })
    .join('\n');
};

ChatView.exportHtml = function (items, who) {
  return items
    .map((it) => {
      if (it.k === 'user') return `<div class="u">${esc(it.text)}</div>`;
      if (it.k === 'assistant') return `<div class="a"><b>${esc(who || 'Assistant')}</b>${this.md(it.text, it.hard)}</div>`;
      return `<details class="t"><summary>${it.list.length} tool call${it.list.length === 1 ? '' : 's'}</summary>${it.list
        .map((t) => `<div><b>${esc(t.tool)}</b> <code>${esc(t.text || '')}</code></div>`)
        .join('')}</details>`;
    })
    .join('\n');
};

/* ------------------------------------------------ find in the conversation */
ChatView.visible = function () {
  return Boolean(this.el && !this.el.hidden);
};

const ChatFind = {
  bar: null,
  ranges: [],
  at: -1,

  isOpen() {
    return Boolean(this.bar && this.bar.classList.contains('open'));
  },

  build() {
    const b = document.createElement('div');
    b.className = 'find-bar chat-find';
    b.setAttribute('role', 'search');
    b.innerHTML = `<input type="text" class="find-input" placeholder="Find in conversation" aria-label="Find in conversation" spellcheck="false" autocomplete="off" /><span class="find-count" aria-live="polite"></span>
      <button type="button" class="find-btn" data-f="prev" aria-label="Previous match" title="Previous (Shift+Enter)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 15 6-6 6 6" /></svg></button>
      <button type="button" class="find-btn" data-f="next" aria-label="Next match" title="Next (Enter)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6" /></svg></button>
      <button type="button" class="find-btn" data-f="close" aria-label="Close find" title="Close (Esc)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" /></svg></button>`;
    const input = b.querySelector('input');
    let timer = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.run(true), 80);
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    b.addEventListener('click', (e) => {
      const x = e.target.closest('[data-f]');
      if (!x) return;
      if (x.dataset.f === 'close') this.close();
      else this.step(x.dataset.f === 'next' ? 1 : -1);
    });
    document.querySelector('.terminal-panel').appendChild(b);
    this.bar = b;
  },

  open() {
    if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return toast('Search in the chat is not available in this window.');
    if (!this.bar) this.build();
    this.bar.classList.add('open');
    const input = this.bar.querySelector('input');
    const sel = String(getSelection() || '').trim();
    if (sel && !sel.includes('\n') && sel.length < 120) input.value = sel;
    input.focus();
    input.select();
    this.run(true);
  },

  /** Find every match; `go` also moves to the nearest one to the bottom. */
  run(go) {
    if (!this.bar) return;
    const q = this.bar.querySelector('input').value.trim().toLowerCase();
    const col = $('chatCol');
    this.ranges = [];
    if (q && col) {
      const walker = document.createTreeWalker(col, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode()) && this.ranges.length < 1000) {
        const t = n.nodeValue.toLowerCase();
        let i = 0;
        while ((i = t.indexOf(q, i)) !== -1) {
          const r = new Range();
          r.setStart(n, i);
          r.setEnd(n, i + q.length);
          this.ranges.push(r);
          i += q.length;
        }
      }
    }
    CSS.highlights.set('chat-find', new Highlight(...this.ranges));
    const count = this.bar.querySelector('.find-count');
    this.bar.classList.toggle('none', Boolean(q) && !this.ranges.length);
    if (!this.ranges.length) {
      CSS.highlights.delete('chat-find-now');
      count.textContent = q ? 'No results' : '';
      this.at = -1;
      return;
    }
    if (go || this.at < 0 || this.at >= this.ranges.length) this.show(this.ranges.length - 1, go);
    else this.show(this.at, false);
  },

  show(i, scroll = true) {
    this.at = ((i % this.ranges.length) + this.ranges.length) % this.ranges.length;
    const r = this.ranges[this.at];
    CSS.highlights.set('chat-find-now', new Highlight(r));
    this.bar.querySelector('.find-count').textContent = `${this.at + 1} of ${this.ranges.length}${this.ranges.length >= 1000 ? '+' : ''}`;
    if (!scroll) return;
    const el = r.startContainer.parentElement;
    const d = el && el.closest('details');
    if (d && !d.open) d.open = true;
    if (el) el.scrollIntoView({ block: 'center' });
  },

  step(dir) {
    if (!this.ranges.length) return this.run(true);
    this.show(this.at + dir);
  },

  close() {
    if (!this.bar) return;
    this.bar.classList.remove('open');
    this.ranges = [];
    this.at = -1;
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete('chat-find');
      CSS.highlights.delete('chat-find-now');
    }
    if (ChatView.visible()) $('ptyInput') && $('ptyInput').focus();
  }
};
