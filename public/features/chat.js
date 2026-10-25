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
    this.apply();
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
        sinceMs: Math.round(s.startedAt || Date.now())
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
        tools.list.push({ tool: e.tool, text: e.text, done: Boolean(r), result: r ? r.text : '', error: r ? r.error : false });
        return;
      }
      tools = null;
      items.push({ k: e.kind === 'user' ? 'user' : 'assistant', key: `e${i}`, text: e.text, hard: false });
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
      items.push({ k: 'user', key: `u${i}`, text: t.text });
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
    // Until the agent has actually answered, the terminal may be holding a question; keep showing it.
    return items.some((x) => x.k === 'assistant') ? items : [];
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
        if (i % 2) return `<code>${esc(p.slice(1, -1))}</code>`;
        let t = esc(p);
        t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
        t = t.replace(/(^|[^*\w])\*([^*\s][^*\n]*)\*(?![*\w])/g, '$1<em>$2</em>');
        t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
        t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
        return t;
      })
      .join('');
  },

  code(lang, body) {
    return `<div class="cm-code"><div class="cm-code-head"><span>${esc(lang.trim() || 'text')}</span><button type="button" class="cm-copy">Copy</button></div><pre><code>${esc(body)}</code></pre></div>`;
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
    const rows = it.list
      .map(
        (t) =>
          `<div class="cm-tool${t.error ? ' err' : ''}${t.done ? '' : ' run'}"><span class="cm-tool-name">${esc(t.tool)}</span><code>${esc(t.text || '')}</code>${t.result ? `<pre>${esc(t.result)}</pre>` : ''}</div>`
      )
      .join('');
    return `<details class="cm cm-tools" data-key="${it.key}"${this.open.has(it.key) ? ' open' : ''}><summary>${running ? dotsHtml : ''}<span>${esc(label)}</span></summary>${rows}</details>`;
  },

  html(s, items) {
    let h = '';
    for (const it of items) {
      if (it.k === 'user') h += `<div class="cm cm-user"><div class="cm-bubble">${esc(it.text)}</div></div>`;
      else if (it.k === 'assistant') h += `<div class="cm cm-ai"><div class="cm-body">${this.md(it.text, it.hard)}</div></div>`;
      else if (it.k === 'tools') h += this.toolsHtml(it);
    }
    if (s.working) h += `<div class="cm cm-working" aria-label="Working">${dotsHtml}</div>`;
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
    el.innerHTML = '<div class="chat-col" id="chatCol"></div>';
    panel.append(el);
    this.el = el;
    el.addEventListener('click', (e) => {
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
        if (d.open) this.open.add(d.dataset.key);
        else this.open.delete(d.dataset.key);
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
    this.el.hidden = !on;
    if (!on) {
      this.sig = '';
      return;
    }
    const surface = getComputedStyle(document.querySelector('.main')).backgroundColor;
    if (surface && !/rgba\(.*,\s*0\)$/.test(surface) && surface !== 'transparent') this.el.style.background = surface;
    const html = this.html(s, items);
    const sig = `${s.id}|${html.length}|${html.slice(-200)}|${s.working}`;
    if (!force && sig === this.sig) return;
    this.sig = sig;
    const near = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 90;
    $('chatCol').innerHTML = html;
    if (near || force) this.el.scrollTop = this.el.scrollHeight;
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
