import { codeSpan, inline, looksLikePath, renderMarkdown } from '../core/markdown';
import { StreamView } from '../core/stream-view';
import { splitThinking } from '../core/thinking';

/** One thing in the chat column. Either a piece of HTML, or a message that may still be arriving. */
interface ChatSeg {
  key: string;
  html?: string;
  stream?: 'ai' | 'think';
  text?: string;
  hard?: boolean;
  streaming?: boolean;
  live?: boolean;
  /** The row of actions under a finished reply. */
  foot?: string;
  /** A Thinking block the reader left open. */
  open?: boolean;
}
/** The element a segment is drawn in, kept for as long as the segment is on screen. */
interface ChatNode {
  el: HTMLElement;
  kind: 'html' | 'ai' | 'think';
  html?: string | null;
  view?: StreamView;
  foot?: string;
}
import { $, active, agent, autoGrow, esc, hooks, invoke, openTerminalPath, openUrl, prefs, savePrefs, sendPlain, toast } from '../app';
import { WebSearch } from './websearch';
import { dotsHtml } from './calm';
import { MessageQueue } from './queue';
import { late } from '../late';
import { registerCommand } from './palette';
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

export const ChatView = {
  el: null,
  sig: '',
  open: new Set(),
  shut: new Set(),
  expanded: new Set(),
  cache: new Map(),
  FEED: new Set(['claude-code', 'claude-chat', 'codex', 'opencode', 'deepseek', 'freebuff', 'gemini']),
  /** How often each feed is read. OpenCode runs a command to export, so it is read less often. */
  every(s) {
    if (s.agentId === 'opencode' || s.agentId === 'deepseek') return s.working ? 4000 : 12000;
    // Reading the tail of one log file is cheap, so while an answer is on its way look every 100 ms.
    // The other agents scan their data folders for the session, so they are read a little less often.
    if (['claude-code', 'claude-chat', 'codex'].includes(s.agentId)) return s.working ? 100 : 1000;
    return s.working ? 350 : 1500;
  },

  st(s) {
    if (!s.chat) s.chat = { turns: [], events: [], results: new Map(), offset: 0, feedAt: 0, mode: null, busy: false };
    return s.chat;
  },

  /* ----------------------------------------------------------- recording */

  onSent(s, text, opts) {
    const c = this.st(s);
    let marker = null;
    try {
      if (s.term.buffer.active.type === 'normal') marker = s.term.registerMarker(0);
    } catch {
      /* the turn is still shown; only its reply is lost */
    }
    c.turns.push({ text: String(text || ''), marker, at: Date.now(), auto: Boolean(opts && opts.auto), echo: opts && opts.echo ? String(opts.echo) : '', detail: opts && opts.detail ? String(opts.detail) : '' });
    while (c.turns.length > 300) {
      const old = c.turns.shift();
      if (old.marker) old.marker.dispose();
    }
    this.apply(true);
  },

  /** New events from the CLI's own conversation file, when it keeps one. */
  async feed(s) {
    const c = this.st(s);
    // A parked or finished session still has its conversation on disk; show it without restarting the CLI.
    if (c.busy || !this.FEED.has(s.agentId) || !['running', 'parked', 'exited'].includes(s.status)) return;
    // Only the live session's log keeps changing; read others once.
    if (s.status !== 'running' && c.offset > 0) return;
    if (!s.providerSessionId && !['freebuff', 'gemini'].includes(s.agentId)) return;
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
      c.ver = (c.ver || 0) + 1;
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
    const chrome = /previous cli conversation ended|^\s*(\.\.\.\s*)?press enter to send\s*$|^\s*>>>\s*(send a message.*|\/\w+.*)?$|^\s*set parameter .*$|^\s*set '?(no)?think'? mode.*$|^\s*cleared session context\s*$|use ctrl \+ d or \/bye|esc to (interrupt|cancel)|\? for shortcuts|shift\+tab|ctrl\+[a-z] to|context left|no sandbox|bypass permissions|auto-accept|accept edits|\d+% context|type your message|\/help for|tab to queue|esc again|ctrl\+c again|^\s*[▸▶▾]?\s*(thought|thinking) for \d+/i;
    const spinner = /^\s*([✢✳✻✽✶·*]\s+\S.*…|[⠀-⣿](\s|$))/;
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
    // The conversation log only changes when the feed brings new events, so the (large) item list is
    // rebuilt then and not on every redraw, queue check and tick.
    if (c.events.length && c.memo && c.memo.ver === c.ver) return c.memo.items;
    let items = [];
    if (c.events.length) items = this.fromEvents(c);
    else if (c.turns.length && this.FEED.has(s.agentId)) {
      // The CLI keeps its own log, which is the only trustworthy source of the reply. Until it
      // arrives, show what you sent (never terminal text, which is mostly menus and status lines).
      items = c.turns.map((t, i) => ({ k: 'user', key: `u${i}`, text: t.text, ts: t.at }));
    } else if (c.turns.length) items = this.fromTurns(s, c);
    else if (this.ready(s)) items = [{ k: 'empty', key: 'empty' }];
    // Keys name a message across redraws; scoped to the session so open/closed groups never leak between tabs.
    for (const it of items) it.key = `${s.id}:${it.key}`;
    // A CLI that redraws its screen can hide the reply for a moment; keep showing the last good view.
    if (items.length) {
      if (c.events.length) c.memo = { ver: c.ver, items };
      c.last = items;
      c.shown = true;
    } else if (c.shown && c.last) return c.last;
    return items;
  },

  /** The reply as the terminal is drawing it right now, until the CLI's own log has it. The log only
   *  gets a message once it is finished, so without this the chat waits for a whole answer while the
   *  terminal shows it word by word. Shown only for an inline (non-full-screen) terminal, and dropped
   *  the moment the log delivers the real message. */
  live(s) {
    const c = this.st(s);
    const t = c.turns[c.turns.length - 1];
    if (!t || !s.working || prefs.chatLive === false || !this.FEED.has(s.agentId)) return '';
    let b;
    try {
      b = s.term.buffer.active;
    } catch {
      return '';
    }
    if (!b || b.type === 'alternate') return '';
    const now = Date.now();
    if (c.liveAt && now - c.liveAt < 60) return c.liveText || '';
    c.liveAt = now;
    const norm = (x) => String(x).replace(/\s+/g, ' ').trim();
    const rows = this.linesBetween(s, Math.max(0, b.length - 500), b.length);
    const flat = rows.map(norm);
    const head = norm(t.echo || t.text).slice(0, 28);
    let at = -1;
    if (head) for (let k = flat.length - 1; k >= 0; k--) if (flat[k].includes(head)) { at = k; break; }
    if (at < 0) return (c.liveText = '');
    let start = at + 1;
    while (start < rows.length && (/^\.\.\.(\s|$)/.test(rows[start]) || !rows[start].trim())) start++;
    // tool lines ("Bash(git status)", "⎿ result") come from the log as tool rows; leave them out here
    const text = this.clean(rows.slice(start), t.echo || t.text)
      .split('\n')
      .filter((l) => !/^\s*[A-Z][A-Za-z]*\(.*\)\s*$/.test(l) && !/^\s*⎿/.test(l))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return (c.liveText = text);
  },

  /** The conversation plus, while a reply is being written, the live text of it. */
  withLive(s, items) {
    const last = items[items.length - 1];
    if (!last || !(last.k === 'user' || last.k === 'tools') || !s.working) return items;
    const text = this.live(s);
    return text ? [...items, { k: 'assistant', key: `${s.id}:live`, text, hard: true, live: true }] : items;
  },

  /** A CLI sitting at its normal prompt with nothing sent yet: show an empty chat, not its start screen. */
  ready(s) {
    if (!this.FEED.has(s.agentId) || s.status !== 'running' || s.working) return false;
    if (Date.now() - (s.startedAt || Date.now()) < 3500) return false;
    if (this.waiting(s)) return false;
    // sign-in, trust and setup screens are for the terminal
    const b = s.term.buffer.active;
    const rows = [];
    for (let i = Math.max(0, b.length - 30); i < b.length; i++) {
      const l = b.getLine(i);
      if (l) rows.push(l.translateToString(true));
    }
    return !/sign in|log in|login|authentication required|waiting for auth|api key|trust this|do you trust|press enter to|choose (a|the) |select (a|the) |paste (the )?code|oauth|device code/i.test(rows.join(String.fromCharCode(10)));
  },

  /** No reply log after a while: the terminal is the honest view. */
  stale(s) {
    const c = this.st(s);
    if (!this.FEED.has(s.agentId) || c.events.length || !c.turns.length) return false;
    return Date.now() - c.turns[c.turns.length - 1].at > 25000;
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
    // Each turn starts where the CLI echoed what was sent. Search from the newest turn backwards, so
    // a message you send twice is matched to its own echo and not to the earlier one.
    const at = c.turns.map(() => -1);
    let limit = flat.length;
    for (let i = c.turns.length - 1; i >= 0; i--) {
      const t = c.turns[i];
      if (t.reply != null) {
        at[i] = -2; // finished and kept
        continue;
      }
      const head = norm(t.echo || t.text).slice(0, 28);
      if (!head) continue;
      for (let k = limit - 1; k >= 0; k--) {
        if (flat[k].includes(head)) {
          at[i] = k;
          limit = k;
          break;
        }
      }
    }
    const items = [];
    c.turns.forEach((t, i) => {
      if (t.auto) items.push({ k: 'note', key: `n${i}`, text: t.text, detail: t.detail || '' });
      else items.push({ k: 'user', key: `u${i}`, text: t.text, ts: t.at });
      if (t.reply != null) {
        if (t.reply) this.pushReply(items, i, t.reply);
        return;
      }
      if (at[i] < 0) return;
      const next = at.slice(i + 1).find((x) => x >= 0);
      const end = next === undefined ? rows.length : next;
      // the CLI echoes a long input on several rows, each starting "... "; they are not part of the reply
      let start = at[i] + 1;
      while (start < end && (/^\.\.\.(\s|$)/.test(rows[start]) || !rows[start].trim())) start++;
      const text = this.clean(rows.slice(start, end), t.echo || t.text);
      const sealed = next !== undefined && !s.working;
      if (sealed) t.reply = text;
      if (text) this.pushReply(items, i, text, !sealed);
    });
    // Until the agent has answered or started working on it, the terminal may be holding a question; keep showing it.
    return items.some((x) => x.k === 'assistant' || x.k === 'thinking') || s.working ? items : [];
  },

  /** Local models print their reasoning inside markers; see core/thinking.ts. While the reply is still
   *  arriving, half a marker at the end of the text is held back instead of being shown. */
  splitThinking(text, streaming?) {
    return splitThinking(text, Boolean(streaming));
  },

  pushReply(items, key, text, streaming?) {
    const { think, answer, open } = this.splitThinking(text, streaming);
    if (think || open) items.push({ k: 'thinking', key: 'k' + key, text: think, live: Boolean(open), hard: true });
    // A reply that is one tool line (SEARCH, BROWSE, SKILL, RUN, KNOW) is acted on by websearch.ts, not shown.
    if (WebSearch.request(answer)) items.push({ k: 'hidden', key: 'h' + key, text: answer });
    else if (answer) items.push({ k: 'assistant', key: 'a' + key, text: answer, hard: true });
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

  /* The markdown itself lives in core/markdown.ts (one parser for the live view, exports and tests). */
  inline(src) {
    return inline(src);
  },

  /** A whole message as HTML, in one go. The chat on screen does not use this; see `patch`. */
  md(src, hard?) {
    return renderMarkdown(src, Boolean(hard));
  },

  text(src, hard?) {
    return renderMarkdown(src, Boolean(hard));
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

  looksLikePath(t) {
    return looksLikePath(t);
  },

  codeSpan(t) {
    return codeSpan(t);
  },

  /** How long the agent has been on this message, from when you sent it. */
  /** Is the chat waiting on the agent's answer right now (your message, a tool or its thinking is last)? */
  pendingNow(s) {
    const items = this.model(s);
    const last = items[items.length - 1];
    return Boolean(last && (['user', 'note', 'hidden', 'tools'].includes(last.k) || (last.k === 'thinking' && last.live)));
  },

  /** A reply that has been pending for a long time. */
  slow(s) {
    const last = this.st(s).turns.slice(-1)[0];
    return Boolean(last && Date.now() - last.at > 45000);
  },

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

  ICONS: {
    copy: ['Copy', '<rect x="9" y="9" width="11" height="11" rx="2.500"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>'],
    edit: ['Edit', '<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M14 7l3 3"/>'],
    up: ['Good response', '<path d="M7 11v9H4v-9h3z"/><path d="M7 11l4-7c1.500 0 2.500 1 2.500 2.500V9H19a2 2 0 0 1 2 2.300l-1 6.500a2 2 0 0 1-2 1.700H7"/>'],
    down: ['Bad response', '<path d="M7 13V4H4v9h3z"/><path d="M7 13l4 7c1.500 0 2.500-1 2.500-2.500V15H19a2 2 0 0 0 2-2.300L20 6.200A2 2 0 0 0 18 4.500H7"/>'],
    regen: ['Retry', '<path d="M20 12a8 8 0 1 1-2.500-5.800"/><path d="M20 4v5h-5"/>']
  },

  /** One icon button in the row under a message. */
  act(name, key) {
    const [label, path] = this.ICONS[name];
    const on = (name === 'up' || name === 'down') && this.rating(key) === name ? ' on' : '';
    return `<button type="button" class="cm-act${on}" data-act="${name}" data-key="${key}" title="${label}" aria-label="${label}"${on ? ' aria-pressed="true"' : ''}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg></button>`;
  },

  /** Thumbs are a private mark on this PC; nothing is sent anywhere. */
  rating(key) {
    return (prefs.chatRatings || {})[key] || '';
  },

  rate(key, value) {
    const r = (prefs.chatRatings = prefs.chatRatings || {});
    if (r[key] === value) delete r[key];
    else r[key] = value;
    const keys = Object.keys(r);
    for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete r[k];
    savePrefs();
  },

  PAGE: 60,
  lim: new Map(),

  /** What the column should show, as an ordered list of segments. A segment is either a piece of HTML
   *  (your message, a tool group, a note) or a message that may still be arriving (`stream`), which is
   *  drawn block by block by a StreamView and never redrawn whole. */
  segments(s, items) {
    this.cur = items;
    // Only the newest messages are drawn; older ones come back with one click.
    const n = this.lim.get(s.id) || this.PAGE;
    const hidden = Math.max(0, items.length - n);
    const shown = hidden ? items.slice(hidden) : items;
    const segs: ChatSeg[] = [];
    const add = (key: string, html: string) => segs.push({ key, html });
    if (hidden) add(`${s.id}:earlier`, `<button type="button" class="cm-earlier" data-act="earlier">Show ${hidden} earlier message${hidden === 1 ? '' : 's'}</button>`);
    shown.forEach((it, idx) => {
      const when = this.when(it.ts);
      if (it.k === 'user') {
        // A long paste (a log, a file) folds to a preview instead of filling the screen.
        const lines = it.text.split('\n').length;
        const long = lines > 14 || it.text.length > 1400;
        const open = this.expanded.has(it.key);
        const more = long ? `<button type="button" class="cm-more" data-act="more" data-key="${it.key}">${open ? 'Show less' : `Show all ${lines} lines`}</button>` : '';
        add(it.key, `<div class="cm cm-user"><div class="cm-bubble${long && !open ? ' folded' : ''}">${esc(it.text)}</div>${more}<div class="cm-acts">${this.act('edit', it.key)}${this.act('copy', it.key)}${when}</div></div>`);
      } else if (it.k === 'assistant' && it.text.startsWith('**Stopped:**')) {
        add(it.key, `<div class="cm cm-stop" role="status"><div class="cm-stop-body">${esc(it.text.replace(/^\*\*Stopped:\*\*\s*/, ''))}</div><div class="cm-stop-acts"><button type="button" data-act="retry">Try again</button><button type="button" class="cm-open-term">Open the terminal</button></div></div>`);
      } else if (it.k === 'assistant') {
        // Still arriving: the live copy read from the terminal, or the newest reply of a working session.
        const streaming = Boolean(it.live) || (s.working && idx === shown.length - 1);
        segs.push({
          key: it.key,
          stream: 'ai',
          text: it.text,
          hard: Boolean(it.hard) || Boolean(it.live),
          streaming,
          live: Boolean(it.live),
          foot: streaming ? '' : `<div class="cm-acts">${this.act('copy', it.key)}${this.act('up', it.key)}${this.act('down', it.key)}${this.act('regen', it.key)}${when}</div>`
        });
        // links the model wrote that were in nothing it was given: likely made up
        if (s.unverifiedFor === it.key && s.unverified && s.unverified.length) add(`${it.key}:warn`, `<div class="cm cm-warn" role="note"><b>Check these links.</b> They were not in anything the model was given, so it may have made them up: ${s.unverified.map((u) => `<code>${esc(u)}</code>`).join(' ')}</div>`);
      } else if (it.k === 'tools') add(it.key, this.toolsHtml(it));
      else if (it.k === 'thinking') segs.push({ key: it.key, stream: 'think', text: it.text, hard: Boolean(it.hard), streaming: Boolean(it.live), live: Boolean(it.live), open: this.open.has(it.key) });
      else if (it.k === 'note') add(it.key, it.detail ? `<details class="cm cm-note cm-note-out"><summary>${esc(it.text)}</summary><pre>${esc(it.detail)}</pre></details>` : `<div class="cm cm-note">${esc(it.text)}</div>`);
      else if (it.k === 'empty') add(it.key, `<div class="cm cm-empty"><b>${esc((agent(s.agentId) || { label: '' }).label || 'Agent')} is ready</b><span>Type below to start. Use Terminal above for its own screen.</span></div>`);
    });
    // A CLI repaints its screen when you switch to it, which reads as "working"; only show the
    // indicator while a reply is actually pending (your message or a tool is the last thing).
    const last = items[items.length - 1];
    const pending = last && (last.k === 'user' || last.k === 'note' || last.k === 'hidden' || last.k === 'tools' || (last.k === 'thinking' && last.live));
    const label = esc((agent(s.agentId) || { label: '' }).label || 'the agent');
    if (s.runAsk) add(`${s.id}:ask`, `<div class="cm cm-ask" role="alertdialog" aria-label="Run this command?"><b>The model wants to run this on your PC</b><pre>${esc(s.runAsk.cmd)}</pre><div class="cm-ask-acts"><button type="button" data-act="run-ok" class="primary">Run</button><button type="button" data-act="run-no">Skip</button></div></div>`);
    else if (s.working && pending) add(`${s.id}:working`, `<div class="cm cm-working" role="status" aria-label="Working"><span class="cm-state">WORKING</span><span class="cm-elapsed">${this.elapsed(s)}</span></div>`);
    if (last && last.k === 'user' && this.slow(s)) add(`${s.id}:wait`, `<div class="cm cm-wait"><b>Still waiting on ${label}</b><span>It has not answered yet. Its own screen may show why (a limit, a sign-in, a question).</span><button type="button" class="cm-open-term">Open the terminal</button></div>`);
    else if (!(s.working && pending) && this.waiting(s)) add(`${s.id}:wait`, '<div class="cm cm-wait"><b>Waiting for your answer</b><span>The agent asked something that only the terminal can take.</span><button type="button" class="cm-open-term">Open the terminal</button></div>');
    return segs;
  },

  /** The changing clock is left out when two versions of a segment are compared, so a second ticking
   *  by does not count as a change. */
  stable(html: string) {
    return html.replace(/<span class="cm-elapsed">[^<]*<\/span>/, '<span class="cm-elapsed"></span>');
  },

  /** Bring the column in line with `segs`, touching only what differs.
   *
   *  Every segment keeps its element for as long as its key is on screen. A piece of HTML is rewritten only
   *  when that piece changed. A message that is arriving is handed to its StreamView, which appends to
   *  the block being written and leaves finished blocks alone. Nothing is removed and put back, so there
   *  is no flash, a text selection survives, and an open Thinking block stays open. */
  patch(segs: ChatSeg[]) {
    const col = $('chatCol');
    const nodes: Map<string, ChatNode> = this.nodes;
    const wanted = new Set(segs.map((g) => g.key));
    segs.forEach((seg, i) => {
      let node = nodes.get(seg.key);
      if (!node && seg.stream === 'ai') {
        // The reply was being shown live from the terminal; the CLI's log has now delivered it under its
        // real key. Same message: keep its element and let the view settle the differences in place.
        for (const [key, old] of nodes) {
          if (key.endsWith(':live') && !wanted.has(key) && old.kind === 'ai') {
            nodes.delete(key);
            nodes.set(seg.key, old);
            node = old;
            break;
          }
        }
      }
      const kind = seg.stream || 'html';
      if (node && node.kind !== kind) {
        node.el.remove();
        nodes.delete(seg.key);
        node = undefined;
      }
      if (!node) {
        node = this.makeNode(seg);
        nodes.set(seg.key, node);
      }
      this.updateNode(node, seg);
      if (col.children[i] !== node.el) col.insertBefore(node.el, col.children[i] || null);
    });
    for (const [key, node] of nodes) {
      if (wanted.has(key)) continue;
      node.el.remove();
      nodes.delete(key);
    }
  },

  makeNode(seg: ChatSeg): ChatNode {
    const el = document.createElement('div');
    el.className = 'seg';
    if (seg.stream === 'ai') {
      el.innerHTML = '<div class="cm cm-ai"><div class="cm-body"></div></div>';
      return { el, kind: 'ai', view: new StreamView(el.querySelector('.cm-body') as HTMLElement), foot: '' };
    }
    if (seg.stream === 'think') {
      el.innerHTML = `<details class="cm cm-think" data-key="${esc(seg.key)}"${seg.open ? ' open' : ''}><summary></summary><div class="cm-think-body"></div></details>`;
      return { el, kind: 'think', view: new StreamView(el.querySelector('.cm-think-body') as HTMLElement) };
    }
    return { el, kind: 'html', html: null };
  },

  updateNode(node: ChatNode, seg: ChatSeg) {
    if (node.kind === 'html') {
      const stable = this.stable(seg.html);
      if (node.html !== stable) {
        node.el.innerHTML = seg.html;
        node.html = stable;
      }
      return;
    }
    node.view.update(seg.text, { hard: seg.hard, streaming: seg.streaming });
    if (node.kind === 'think') {
      const summary = node.el.querySelector('summary');
      const label = seg.live ? 'Thinking' : 'Thought';
      if (summary.textContent !== label) summary.textContent = label;
      return;
    }
    const wrap = node.el.firstElementChild;
    wrap.classList.toggle('cm-live', Boolean(seg.live));
    if (node.foot !== seg.foot) {
      const old = wrap.querySelector(':scope > .cm-acts');
      if (old) old.remove();
      if (seg.foot) wrap.insertAdjacentHTML('beforeend', seg.foot);
      node.foot = seg.foot;
    }
  },

  visible() {
    return Boolean(this.el && !this.el.hidden);
  },

  /** Whether the view follows new text. True until you scroll up; true again once you are back at the end. */
  pinned: true,
  pinFrame: 0,
  nodes: new Map(),
  timer: null,
  cur: [],
  segSession: '',
  keepTop: false,

  /** Stay at the newest text. One write per frame, however many updates arrived in it, so the view
   *  does not jitter while a fast model is writing. */
  pinToBottom() {
    if (this.pinFrame) return;
    this.pinFrame = requestAnimationFrame(() => {
      this.pinFrame = 0;
      if (this.el && this.pinned) this.el.scrollTop = this.el.scrollHeight;
    });
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
    el.addEventListener(
      'scroll',
      () => {
        // only the reader moves this: text arriving does not fire a scroll event
        this.pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
        this.syncLatest();
      },
      { passive: true }
    );
    // remember which Thinking blocks are open, so a redraw does not close them
    el.addEventListener('toggle', (e) => {
      const d = e.target as HTMLDetailsElement;
      if (!d || !d.classList || !d.classList.contains('cm-think')) return;
      if (d.open) this.open.add(d.dataset.key);
      else this.open.delete(d.dataset.key);
    }, true);
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
        if (act.dataset.act === 'run-ok' || act.dataset.act === 'run-no') {
          const cur = active();
          if (cur && typeof WebSearch !== 'undefined') WebSearch.decide(cur, act.dataset.act === 'run-ok');
          return;
        }
        if (act.dataset.act === 'more') {
          if (this.expanded.has(act.dataset.key)) this.expanded.delete(act.dataset.key);
          else this.expanded.add(act.dataset.key);
          // redraw, but stay where you were reading instead of jumping to the newest message
          const top = this.el.scrollTop;
          this.sig = '';
          this.apply(false);
          this.el.scrollTop = top;
          this.syncLatest();
          return;
        }
        if (act.dataset.act === 'earlier') {
          const cur = active();
          if (cur) {
            this.lim.set(cur.id, (this.lim.get(cur.id) || this.PAGE) + this.PAGE);
            this.keepTop = true;
            this.sig = '';
            this.apply(false);
          }
          return;
        }
        if (act.dataset.act === 'up' || act.dataset.act === 'down') {
          const was = this.rating(act.dataset.key);
          this.rate(act.dataset.key, act.dataset.act);
          this.sig = '';
          this.apply(false);
          // A thumbs-down is only useful if the agent hears about it: start a correction in the message
          // box (never sent for you, and never over something you were already typing).
          if (act.dataset.act === 'down' && was !== 'down') {
            const box = $('ptyInput');
            if (box && !box.value.trim()) {
              box.value = "That wasn't right. ";
              autoGrow(box);
              const cur = active();
              if (cur) cur.draft = box.value;
            }
            if (box) {
              box.focus();
              box.setSelectionRange(box.value.length, box.value.length);
            }
          }
          return;
        }
        if (act.dataset.act === 'regen') {
          const cur = active();
          const users = (this.cur || []).filter((x) => x.k === 'user');
          const last = users[users.length - 1];
          if (!cur || !last) return;
          if (typeof MessageQueue !== 'undefined' && MessageQueue.busy(cur)) return toast('Wait for the current reply to finish, then retry.');
          sendPlain(cur, last.text);
          return;
        }
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
            act.classList.add('done');
            act.title = 'Copied';
            setTimeout(() => {
              act.classList.remove('done');
              act.title = 'Copy';
            }, 1200);
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
        this.pinned = true;
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
      const d = e.target as HTMLDetailsElement;
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
  apply(force?) {
    if (!this.el) return;
    const s = active();
    const items = s && prefs.chatView !== false ? this.withLive(s, this.model(s)) : [];
    const on = Boolean(s && items.length && this.st(s).mode !== 'terminal' && !late.Team.isOpen() && !this.stale(s));
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
      box.placeholder = on && a ? `Reply to ${a.label}…` : box.dataset.ph;
    }
    this.el.hidden = !on;
    if (!on) {
      this.sig = '';
      if (typeof ChatFind !== 'undefined' && ChatFind.isOpen()) ChatFind.close();
      return;
    }
    const surface = getComputedStyle(document.querySelector('.main')).backgroundColor;
    if (surface && !/rgba\(.*,\s*0\)$/.test(surface) && surface !== 'transparent') this.el.style.background = surface;
    const segs = this.segments(s, items);
    if (this.segSession !== s.id) {
      this.segSession = s.id;
      this.nodes = new Map();
      this.pinned = true;
      $('chatCol').textContent = '';
    }
    // A cheap fingerprint of what is shown, so an idle tick does no work at all.
    const sig = `${s.id}|${s.working}|${segs
      .map((g) => (g.stream ? `${g.key}~${g.text.length}~${g.text.slice(-60)}~${g.streaming}~${(g.foot || '').length}` : `${g.key}~${g.html.length}~${this.stable(g.html).slice(-60)}`))
      .join('|')}`;
    const clock = this.el.querySelector('.cm-elapsed');
    if (clock) clock.textContent = this.elapsed(s);
    if (!force && sig === this.sig) return;
    this.sig = sig;
    if (force) this.pinned = true;
    const before = this.keepTop ? this.el.scrollHeight : 0;
    this.patch(segs);
    // You scrolled up to read: the view stays where you put it. At the end: it follows the new text.
    if (this.keepTop) this.el.scrollTop += this.el.scrollHeight - before;
    else if (this.pinned) this.pinToBottom();
    this.keepTop = false;
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
hooks.sent.push((s, text, opts) => ChatView.onSent(s, text, opts));
hooks.view.push(() => ChatView.apply(true));
hooks.tabs.push(() => ChatView.apply());
hooks.idle.push(() => ChatView.tick());
hooks.output.push(() => {
  if (ChatView.timer) return;
  ChatView.timer = setTimeout(() => {
    ChatView.timer = null;
    ChatView.tick();
  }, 50);
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
export function chatExportable(s) {
  const self = ChatView;
  if (prefs.chatView === false) return null;
  const items = self.model(s);
  return items.length ? items : null;
}

export function chatMarkdown(items, who?) {
  const fence = (t) => String(t).replace(/```/g, "'''");
  return items
    .map((it) => {
      if (it.k === 'user') return `## You\n\n${it.text}\n`;
      if (it.k === 'assistant') return `## ${who || 'Assistant'}\n\n${it.text}\n`;
      const rows = it.list.map((t) => `- ${t.tool}${t.text ? `: \`${fence(t.text).replace(/`/g, "'")}\`` : ''}${t.error ? ' (failed)' : ''}`);
      return `<details><summary>${rows.length} tool call${rows.length === 1 ? '' : 's'}</summary>\n\n${rows.join('\n')}\n\n</details>\n`;
    })
    .join('\n');
}

export function chatExportHtml(items, who?) {
  return items
    .map((it) => {
      if (it.k === 'user') return `<div class="u">${esc(it.text)}</div>`;
      if (it.k === 'assistant') return `<div class="a"><b>${esc(who || 'Assistant')}</b>${renderMarkdown(it.text, Boolean(it.hard))}</div>`;
      return `<details class="t"><summary>${it.list.length} tool call${it.list.length === 1 ? '' : 's'}</summary>${it.list
        .map((t) => `<div><b>${esc(t.tool)}</b> <code>${esc(t.text || '')}</code></div>`)
        .join('')}</details>`;
    })
    .join('\n');
}

/* ------------------------------------------------ find in the conversation */

export const ChatFind = {
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

Object.assign(late, { ChatFind, ChatView });
