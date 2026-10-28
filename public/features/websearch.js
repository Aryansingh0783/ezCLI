'use strict';
/* Tools for offline models (Ollama). A local model has no web, no skills and no terminal of its own, so
 * the app gives it a tiny text protocol. The model replies with exactly one line, and the app acts:
 *
 *   SEARCH: <query>   search the web, read the top pages, give the model the text
 *   SKILL: <name>     give the model one of your skills (~/.claude/skills)
 *   RUN: <command>    run one PowerShell command on your PC, but only after you click Run on it
 *
 * The "Web" button picks auto (search when the model does not know), always, or off. The "Terminal"
 * button is off until you turn it on; even then every command waits for your click. */

const WebSearch = {
  AGENTS: new Set(['ollama', 'ollama-cloud']),
  MODES: ['auto', 'always', 'off'],
  MAX_STEPS: 4,
  /** Things a frozen model cannot know, so there is no point asking it first. */
  FRESH: /\b(latest|newest|current(ly)?|today|tonight|yesterday|this (week|month|year)|right now|news|recent(ly)?|just (released|announced)|release date|price of|stock|score|weather|who won|202[5-9]|2030)\b/i,
  REQUEST: /^\s*(SEARCH|SKILL|RUN):\s*(.+)$/im,
  skills: null,

  applies(s) {
    return Boolean(s && this.AGENTS.has(s.agentId));
  },

  mode() {
    return this.MODES.includes(prefs.webMode) ? prefs.webMode : 'auto';
  },

  terminalOn() {
    return prefs.termMode === 'ask';
  },

  STOP: new Set('a an the is are was were be been am do does did can could should would will shall may might must i me my we our you your he she it its they them their this that these those of in on at to for from with by about as and or but if so than then there here what which who whom whose when where why how not no yes please tell give show find check search look up latest new current also just more most very really some any all each other into over after before again still even only own same such too s t don now get got has have had one two like want need know think say said ask asked'.split(' ')),

  words(text) {
    return String(text).replace(/[^\p{L}\p{N}.+#-]+/gu, ' ').split(' ').filter((x) => (x.length > 1 || /\d/.test(x)) && !this.STOP.has(x.toLowerCase()));
  },

  /** What to search for: your question, plus the subject of what you were just talking about when the
   *  question alone is too short to mean anything ("is it better than you?"). */
  queryFor(s, question) {
    const own = this.words(question);
    const before = (s.chat && s.chat.turns ? s.chat.turns : []).filter((t) => !t.auto).slice(-4).map((t) => String(t.text || ''));
    if (before.length && before[before.length - 1].replace(/\s+/g, ' ').trim() === question) before.pop();
    // subject words from earlier messages, newest first, favouring names and numbers
    const subject = [];
    for (const m of before.reverse()) {
      const ws = this.words(m);
      const strong = ws.filter((x) => /^[A-Z0-9]/.test(x) || /\d/.test(x));
      for (const x of [...strong, ...ws]) if (!subject.some((y) => y.toLowerCase() === x.toLowerCase())) subject.push(x);
    }
    const room = own.length >= 6 ? 3 : Math.max(4, 12 - own.length);
    const extra = subject.filter((x) => !own.some((y) => y.toLowerCase() === x.toLowerCase())).slice(0, room);
    return [...extra, ...own].join(' ') || question;
  },

  async fetchBlock(query) {
    this.busy(true);
    try {
      return await invoke('web_context', { query: String(query).slice(0, 250), today: new Date().toISOString().slice(0, 10) });
    } catch {
      return null;
    } finally {
      this.busy(false);
    }
  },

  async loadSkills() {
    if (this.skills) return this.skills;
    try {
      this.skills = await invoke('local_skills');
    } catch {
      this.skills = [];
    }
    return this.skills;
  },

  /** The note that goes with a message: who the model is, the rules against guessing, and which one-line
   *  requests it may make. Full the first time (and after a compaction), short after. */
  async hint(s) {
    const web = this.mode() !== 'off';
    const skills = web || this.terminalOn() ? await this.loadSkills() : [];
    const parts = [];
    if (web) parts.push('SEARCH: <query> (look something up on the web when you do not know it or it may be out of date)');
    if (skills.length) parts.push(`SKILL: <name> (load one of the user's skills: ${skills.slice(0, 60).map((x) => x.name).join(', ')})`);
    if (this.terminalOn()) parts.push('RUN: <one PowerShell command> (the user approves it first; use it only when the user asks you to do something on their PC)');
    const tools = parts.map((p) => p.split(':')[0]);
    if (s.toolsIntro) {
      return { text: ` [Reminder: you are ${s.modelId || 'a local model'}, not Claude. Do not guess.${tools.length ? ` Tools as before: ${tools.join(', ')}; reply with only that one line when you use one.` : ''}]`, tools: tools.length };
    }
    s.toolsIntro = true;
    const who = `You are ${s.modelId || 'a local model'}, running on this PC through Ollama. You are not Claude, ChatGPT or any other model, even if web results or the conversation mention them.`;
    const rules = 'Do not guess. If you are not sure, say so or look it up. Never invent facts, numbers, quotes, links or file names. When you use something from web results, say which source it came from; if the results do not answer the question, say that.';
    const use = tools.length ? ` Tools: when you need one, reply with only one line and nothing else: ${parts.join(' | ')}. Otherwise just answer.` : '';
    return { text: ` [${who} ${rules}${use}]`, tools: tools.length };
  },

  /** What to send for this message: the question, with web text after it when the mode and the
   *  question call for it, plus the note that lets the model ask for a tool. */
  async augment(s, text) {
    if (!this.applies(s)) return text;
    const question = String(text).replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim();
    if (question.length < 4 || question.startsWith('/')) return text;
    const flat = text.replace(/\s*\n\s*/g, ' ');
    s.webSteps = 0;
    await this.compactIfNeeded(s);
    const mode = this.mode();
    let block = '';
    if (mode === 'always' || (mode === 'auto' && this.FRESH.test(question))) {
      block = await this.fetchBlock(this.queryFor(s, question));
      if (!block) toast('Could not reach the web, so the model answers from memory.');
      else this.remember(s, block);
    }
    const hint = await this.hint(s);
    if (hint.tools) s.webAsked = (s.chat ? s.chat.turns.length : 0) + 1;
    const out = `${flat}${hint.text}${block ? ` ${block}` : ''}`;
    s.ctxExtra = (s.ctxExtra || 0) + out.length - flat.length;
    return out;
  },

  /** Keep the text of what the web returned, to check the model's links against it later. */
  remember(s, block) {
    s.webText = `${s.webText || ''} ${block}`.slice(-80000);
    s.ctxExtra = s.ctxExtra || 0;
  },

  /* ----------------------------------------------------------- context compaction */

  /** The context size the model really runs with, from `ollama ps` (the model must be loaded). */
  async contextTokens(s) {
    try {
      const r = await invoke('run_approved_command', { command: 'ollama ps', cwd: '' });
      const lines = String(r.output || '').split('\n');
      const col = (lines[0] || '').indexOf('CONTEXT');
      const row = lines.find((l, i) => i > 0 && s.modelId && l.startsWith(String(s.modelId).split(':')[0]));
      const n = col >= 0 && row ? parseInt(row.slice(col), 10) : 0;
      if (n > 0) return n;
    } catch {
      /* use the default below */
    }
    return 8192;
  },

  /** Roughly how much of the model's context this conversation uses, in characters. */
  usedChars(s) {
    const items = ChatView.model(s);
    let n = s.ctxExtra || 0;
    for (const it of items) if (it.k === 'user' || it.k === 'assistant') n += (it.text || '').length;
    return n;
  },

  async waitForAnswer(s, turn, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await sleep(1500);
      if (s.status !== 'running') return null;
      if (s.working || (s.chat ? s.chat.turns.length : 0) !== turn) continue;
      const items = ChatView.model(s);
      const last = items[items.length - 1];
      if (last && last.k === 'assistant') return last.text;
    }
    return null;
  },

  /** When the conversation nears the model's context size, the model summarises it, the session is
   *  cleared, and the summary becomes the start of the fresh context. Nothing is lost from the chat. */
  async compactIfNeeded(s) {
    if (s.compacting || prefs.compact === false || !s.ptyId) return;
    const turns0 = s.chat ? s.chat.turns.length : 0;
    if (turns0 < 2) return;
    if (!s.ctxTokens || Date.now() - (s.ctxAt || 0) > 120000) {
      s.ctxTokens = await this.contextTokens(s);
      s.ctxAt = Date.now();
    }
    if (this.usedChars(s) < s.ctxTokens * 3.2 * 0.6) return;
    s.compacting = true;
    try {
      toast('Compacting this conversation to keep the model within its memory.');
      s.webAsked = 0;
      await this.reply(s, 'Summarize our conversation so far in under 200 words. Keep the names, numbers, decisions and what I asked for. Output only the summary.', 'Compacting the conversation');
      const summary = await this.waitForAnswer(s, s.chat.turns.length, 240000);
      if (!summary) return;
      await invoke('send_input', { id: s.ptyId, data: '/clear\r' }).catch(() => {});
      await sleep(1500);
      s.toolsIntro = false;
      s.ctxExtra = 0;
      s.webText = '';
      s.webAsked = 0;
      await this.reply(s, `Background from earlier in this chat. Do not answer it, reply only "ok". Summary: ${summary.replace(/\s*\n\s*/g, ' ')}`, 'Conversation compacted');
      s.webAsked = 0;
      await this.waitForAnswer(s, s.chat.turns.length, 120000);
      s.ctxExtra = summary.length;
    } finally {
      s.compacting = false;
    }
  },

  /* ----------------------------------------------------------- checking the answer */

  /** After an answer: links the model wrote that never appeared in anything it was given. */
  ground(s) {
    if (!this.applies(s) || s.working) return;
    const items = ChatView.model(s);
    const last = items[items.length - 1];
    if (!last || last.k !== 'assistant') return;
    const known = `${s.webText || ''} ${items.filter((x) => x.k === 'user').map((x) => x.text).join(' ')}`;
    const urls = (last.text.match(/https?:\/\/[^\s)\]>"'`]+/g) || []).map((u) => u.replace(/[.,;:!?]+$/, ''));
    const bad = urls.filter((u) => !known.includes(u));
    const key = bad.length ? `${last.key}|${bad.length}` : '';
    if ((s.unverifiedKey || '') === key) return;
    s.unverifiedKey = key;
    s.unverified = bad.slice(0, 4);
    s.unverifiedFor = last.key;
    ChatView.apply(true);
  },

  /** After the model goes quiet: did it ask for a tool? Then do it and let the model carry on. */
  async check(s) {
    if (!this.applies(s) || !s.webAsked || s.webBusy || s.runAsk) return;
    const turns = s.chat ? s.chat.turns.length : 0;
    if (turns !== s.webAsked || s.working) return;
    const items = ChatView.model(s);
    const last = items[items.length - 1];
    const m = last && last.k === 'hidden' && this.REQUEST.exec(last.text);
    if (!m) return;
    s.webBusy = true;
    s.webAsked = 0;
    const kind = m[1].toUpperCase();
    const arg = m[2].replace(/^["“”`<]+|["“”`>]+$/g, '').trim().slice(0, 400);
    try {
      s.webSteps = (s.webSteps || 0) + 1;
      if (s.webSteps > this.MAX_STEPS) return;
      if (kind === 'SEARCH') {
        const block = await this.fetchBlock(arg);
        if (block) this.remember(s, block);
        const msg = block
          ? `Here are web results for "${arg}". ${block} Now answer my earlier question using them.`
          : 'The web search found nothing. Answer my earlier question as well as you can, and say that you could not check.';
        await this.reply(s, msg, `Searched the web for “${arg}”`);
      } else if (kind === 'SKILL') {
        const got = await invoke('local_skill_text', { name: arg }).catch(() => null);
        const msg = got
          ? `Skill "${got[0]}": ${got[1].replace(/\s*\n\s*/g, ' ')} Follow this skill for my request.`
          : `There is no skill called "${arg}". Carry on without it.`;
        await this.reply(s, msg, got ? `Loaded the skill “${got[0]}”` : `No skill called “${arg}”`);
      } else if (kind === 'RUN') {
        if (!this.terminalOn()) {
          await this.reply(s, 'The terminal is turned off, so you cannot run commands. Tell me what you would have run and that I can turn the Terminal button on.', 'Terminal is off');
        } else {
          s.runAsk = { cmd: arg };
          ChatView.apply(true);
        }
      }
    } finally {
      s.webBusy = false;
    }
  },

  /** Send the model a message of the app's own making, shown in the chat as a short note. */
  async reply(s, msg, note, detail) {
    s.webAsked = (s.chat ? s.chat.turns.length : 0) + 1;
    s.ctxExtra = (s.ctxExtra || 0) + msg.length;
    await sendText(s, msg, note, { auto: true, echo: msg, detail: detail || '' });
  },

  /** You clicked Run or Skip on the command the model proposed. */
  async decide(s, ok) {
    const ask = s && s.runAsk;
    if (!ask) return;
    s.runAsk = null;
    ChatView.apply(true);
    if (!ok) {
      await this.reply(s, 'The user chose not to run that command. Do not run it. Ask what they would like instead.', 'Skipped the command');
      return;
    }
    s.webBusy = true;
    try {
      const r = await invoke('run_approved_command', { command: ask.cmd, cwd: s.cwd || '' });
      const out = r.output || '(no output)';
      const status = r.timedOut ? 'it was stopped after 60 seconds' : `exit code ${r.exit ?? '?'}`;
      await this.reply(s, `The command ran (${status}). Output: ${out.replace(/\s*\n\s*/g, ' | ')} Now continue with my request.`, `Ran: ${ask.cmd}`, out);
    } catch (e) {
      await this.reply(s, `The command could not run: ${e}`, `Could not run: ${ask.cmd}`);
    } finally {
      s.webBusy = false;
    }
  },

  busy(on) {
    const b = document.getElementById('btnWeb');
    if (b) b.classList.toggle('busy', on);
  },

  sync() {
    const s = active();
    const web = document.getElementById('btnWeb');
    const term = document.getElementById('btnTerm');
    if (!this.applies(s)) {
      if (web) web.hidden = true;
      if (term) term.hidden = true;
      return;
    }
    const grow = document.querySelector('#ptyComposer .composer-row .grow');
    if (!grow) return;
    let b = web;
    if (!b) {
      b = document.createElement('button');
      b.type = 'button';
      b.id = 'btnWeb';
      b.className = 'web-btn';
      b.addEventListener('click', () => {
        const next = this.MODES[(this.MODES.indexOf(this.mode()) + 1) % this.MODES.length];
        prefs.webMode = next;
        savePrefs();
        this.sync();
        toast(
          {
            auto: 'Web: auto. The model answers from what it knows and searches the web when it does not know.',
            always: 'Web: always. Every question is searched on the web first.',
            off: 'Web: off. The model answers only from what it was trained on.'
          }[next]
        );
      });
      grow.before(b);
    }
    const mode = this.mode();
    b.hidden = false;
    b.dataset.mode = mode;
    b.textContent = { auto: 'Web: auto', always: 'Web: always', off: 'Web: off' }[mode];
    b.title = 'Click to change: auto (search only when the model does not know), always, or off.';
    let t = term;
    if (!t) {
      t = document.createElement('button');
      t.type = 'button';
      t.id = 'btnTerm';
      t.className = 'web-btn';
      t.addEventListener('click', () => {
        prefs.termMode = this.terminalOn() ? 'off' : 'ask';
        savePrefs();
        this.sync();
        toast(this.terminalOn() ? 'Terminal: ask. The model may propose a command; nothing runs until you click Run on it.' : 'Terminal: off. The model cannot run commands.');
      });
      grow.before(t);
    }
    t.hidden = false;
    t.dataset.mode = this.terminalOn() ? 'auto' : 'off';
    t.textContent = this.terminalOn() ? 'Terminal: ask' : 'Terminal: off';
    t.title = 'When on, the model can propose a PowerShell command. You see it and click Run, or Skip.';
  }
};

hooks.tabs.push(() => WebSearch.sync());
hooks.view.push(() => WebSearch.sync());
hooks.boot.push(() => WebSearch.sync());
hooks.idle.push((s) => {
  WebSearch.check(s);
  WebSearch.ground(s);
});
