'use strict';
/* Team chat: several agents working together in ONE conversation.
 *
 * You write one message. The agents you picked (for example Claude Code, Codex
 * and OpenCode) answer in turn inside the same thread, each one reading what
 * the others said, building on it and correcting it. Every turn is a real,
 * one-shot run of that agent's own CLI, so each uses its own account and its own
 * limits; ezCLI only passes the shared conversation along and never rewrites
 * an answer. Agents work on one folder, one at a time, so edits never collide.
 *
 * Three ways of working together:
 *   round     Round table. Everyone replies in turn, for 1-3 rounds, adding to
 *             and correcting what came before. Stops early when all say DONE.
 *   review    Draft, review, revise. The first agent does the work, the others
 *             review it (read only), then the first agent revises.
 *   merge     Everyone answers on their own, then the first agent combines the
 *             answers into one final result.
 */

const Team = (() => {
  const MODES = {
    round: { label: 'Round table', hint: 'Everyone replies in turn and builds on the others.' },
    review: { label: 'Draft & review', hint: 'The first agent does the work, the rest review it, then it revises.' },
    merge: { label: 'Compare & merge', hint: 'Everyone answers alone, then the first agent combines the answers.' }
  };
  const CONTEXT_BUDGET = 22000; // characters of conversation sent to an agent
  const HUES = [152, 205, 285, 35, 340, 95]; // one per participant slot

  let chats = new Map();
  let current = null; // the chat being shown
  let view = null;
  let run = null; // { cancelled, runIds:Set } for the running chat

  const capable = () => state.agents.filter((a) => a.groupChat && a.available);
  const newId = () => `team-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /* ---------------------------------------------------------- chat model */

  function create() {
    const sp = space();
    const pool = capable();
    const want = ['claude-code', 'codex', 'opencode', 'deepseek', 'gemini'];
    const picks = want.map((id) => pool.find((a) => a.id === id)).filter(Boolean).slice(0, 3);
    const chat = {
      id: newId(),
      title: 'Team chat',
      cwd: sp ? sp.path : state.homeCwd,
      mode: 'round',
      rounds: 2,
      allowEdits: true,
      participants: picks.map((a) => ({ agentId: a.id, modelId: defaultModel(a) })),
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    chats.set(chat.id, chat);
    return chat;
  }

  function defaultModel(a) {
    if (a.requiresModelSelection) return '';
    const m = pick(a).model;
    return allModels(a).some((x) => x.id === m) ? m : (a.models[0] && a.models[0].id) || 'default';
  }

  const labelOf = (p) => {
    const a = agent(p.agentId);
    const m = p.modelId && p.modelId !== 'default' ? modelLabel(a, p.modelId) : '';
    return { name: a ? a.label : p.agentId, model: m };
  };

  async function save(chat) {
    chat.updatedAt = Date.now();
    try {
      await invoke('team_save', { id: chat.id, json: JSON.stringify(chat) });
      // Also list it under Sessions, with the text searchable.
      const text = chat.messages.map((m) => `${m.role === 'user' ? 'You' : m.name}: ${m.text}`).join('\n\n');
      const first = chat.messages.find((m) => m.role === 'user');
      await invoke('save_transcript', {
        meta: {
          id: chat.id,
          title: chat.title === 'Team chat' && first ? first.text.replace(/\s+/g, ' ').slice(0, 60) : chat.title,
          agentId: 'team',
          agentLabel: `Team · ${chat.participants.map((p) => labelOf(p).name).join(' + ')}`,
          model: MODES[chat.mode].label,
          cwd: chat.cwd,
          startedAt: chat.createdAt,
          endedAt: chat.updatedAt,
          providerSessionId: '',
          modelId: '',
          modeId: chat.mode,
          effortId: '',
          prompts: chat.messages.filter((m) => m.role === 'user').map((m) => m.text).slice(-30)
        },
        text: text || ' '
      });
      if (first && chat.title === 'Team chat') chat.title = first.text.replace(/\s+/g, ' ').slice(0, 60);
    } catch (err) {
      console.error('team save failed', err);
    }
  }

  async function openSaved(id) {
    if (chats.has(id)) return show(id);
    try {
      const chat = JSON.parse(await invoke('team_load', { id }));
      chat.messages.forEach((m) => {
        if (m.status === 'streaming') m.status = 'error';
      });
      chats.set(chat.id, chat);
      show(chat.id);
    } catch (err) {
      toast(String(err), 'error');
    }
  }

  /* ---------------------------------------------------------- prompts */

  const brief = (chat) => {
    const names = chat.participants.map((p) => labelOf(p).name);
    return `You are part of a team of AI coding agents (${names.join(', ')}) working together in one shared chat on the folder ${chat.cwd}. Each agent takes turns replying. Read what the others wrote, build on it, and correct mistakes you see. Be concrete and brief, and do not repeat what is already settled.`;
  };

  /** The shared conversation as plain text, trimmed to a budget: the first
   *  request is always kept, then as many of the newest messages as fit. */
  function transcript(chat, upTo = chat.messages.length) {
    const lines = chat.messages
      .slice(0, upTo)
      .filter((m) => m.status !== 'error' && m.text.trim())
      .map((m) => ({ role: m.role, who: m.role === 'user' ? 'User' : m.name, text: m.text.trim() }));
    const fmt = (l) => `${l.who}: ${l.text}`;
    const first = lines.find((l) => l.role === 'user');
    let used = first ? fmt(first).length : 0;
    const keep = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i] === first) continue;
      const len = fmt(lines[i]).length;
      if (used + len > CONTEXT_BUDGET) break;
      used += len;
      keep.unshift(lines[i]);
    }
    const omitted = lines.length - keep.length - (first ? 1 : 0);
    return [first ? fmt(first) : '', omitted > 0 ? `[${omitted} earlier message${omitted === 1 ? '' : 's'} omitted]` : '', ...keep.map(fmt)].filter(Boolean).join('\n\n');
  }

  function turnPrompt(chat, p, instruction, upTo) {
    const me = labelOf(p).name;
    return `${brief(chat)}\n\nYou are ${me}.\n\nThe conversation so far:\n\n${transcript(chat, upTo)}\n\n---\nYour turn, ${me}. ${instruction}\nReply with your message only, in plain language. Do not write other agents' lines.`;
  }

  /* ---------------------------------------------------------- running turns */

  function addMessage(chat, m) {
    const msg = { id: newId(), ts: Date.now(), text: '', status: 'done', ...m };
    chat.messages.push(msg);
    renderThread();
    return msg;
  }

  /** Overload and rate-limit style failures that another model may not have. */
  const TRANSIENT = /overload|temporar|unavailable|\b50[234]\b|\b529\b|rate.?limit|\b429\b|capacity|busy|try again|timed? ?out|econn|etimedout|socket hang|too many requests|usage limit|quota/i;

  /** A model of about the same quality to try instead of `p`: the neighbours of
   *  its place in the agent's fallbackModels list, preferring ones no other
   *  participant is already using so the team stays varied. */
  function nextModel(chat, p, tried) {
    const a = agent(p.agentId);
    const list = (a && a.fallbackModels) || [];
    if (!list.length) return null;
    const visible = new Set(allModels(a).map((m) => m.id));
    const others = new Set(chat.participants.filter((q) => q !== p && q.agentId === p.agentId).map((q) => q.modelId));
    const at = list.indexOf(p.modelId);
    const near = (id) => Math.abs(list.indexOf(id) - at);
    return (
      list
        .filter((id) => visible.has(id) && !tried.has(id))
        .sort((x, y) => Number(others.has(x)) - Number(others.has(y)) || near(x) - near(y) || list.indexOf(x) - list.indexOf(y))[0] || null
    );
  }

  const modelKey = (q) => `${q.agentId}|${q.modelId || 'default'}`;

  /** Run one agent turn and stream its reply into a message. If the model is
   *  overloaded or rate limited, switch to a comparable one and say so. */
  async function turn(chat, p0, instruction, { edits = false, label = '' } = {}) {
    if (run.cancelled) return null;
    const tried = new Set([p0.modelId]);
    let p = p0;
    let note = '';
    // A model that already failed this run is not tried first again.
    if (run.avoid.has(modelKey(p))) {
      const alt = nextModel(chat, p, tried);
      if (alt) {
        note = `${labelOf(p).model || labelOf(p).name} was overloaded earlier, so ${labelOf({ agentId: p.agentId, modelId: alt }).model} replied.`;
        p = { agentId: p.agentId, modelId: alt };
        tried.add(alt);
      }
    }
    const lab0 = labelOf(p);
    const msg = addMessage(chat, {
      role: 'agent', agentId: p.agentId, modelId: p.modelId, name: lab0.name, model: lab0.model, kind: label, status: 'streaming', note
    });
    const a = agent(p0.agentId);
    if (a && a.dynamic_models && !state.catalogs[a.id]) await fetchCatalog(a, { quiet: true });
    let done;
    for (let attempt = 0; attempt < 4; attempt++) {
      const runId = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      run.runIds.add(runId);
      msg.text = '';
      const unlisten = await listen(`group-out:${runId}`, (e) => {
        msg.text += e.payload;
        updateMessage(msg);
      });
      try {
        const upTo = chat.messages.indexOf(msg);
        done = await invoke('group_turn', {
          runId,
          agentId: p.agentId,
          modelId: p.modelId || 'default',
          prompt: turnPrompt(chat, p0, instruction, upTo),
          cwd: chat.cwd,
          allowEdits: Boolean(edits && chat.allowEdits)
        });
      } catch (err) {
        done = { code: null, cancelled: false, timedOut: false, stderrTail: String(err) };
      }
      safe(unlisten);
      run.runIds.delete(runId);
      const failed = done.code !== 0 || !cleanReply(msg.text);
      const reason = `${done.stderrTail || ''} ${msg.text}`;
      if (!failed || done.cancelled || run.cancelled || !TRANSIENT.test(reason)) break;
      // Overloaded: remember it and move to a comparable model.
      run.avoid.add(modelKey(p));
      const alt = nextModel(chat, p, tried);
      if (!alt) break;
      const from = labelOf(p).model || labelOf(p).name;
      p = { agentId: p.agentId, modelId: alt };
      tried.add(alt);
      const to = labelOf(p);
      msg.model = to.model;
      msg.modelId = alt;
      msg.note = `${from} was overloaded or limited, so ${to.model || to.name} replied instead.`;
      updateMessage(msg);
    }
    msg.text = cleanReply(msg.text);
    if (done.cancelled) msg.status = 'stopped';
    else if (done.timedOut) {
      msg.status = 'error';
      msg.error = 'This agent took longer than 20 minutes and was stopped.';
    } else if (done.code !== 0 || !msg.text.trim()) {
      msg.status = 'error';
      msg.error = explainFailure(p, done);
    } else msg.status = 'done';
    updateMessage(msg);
    save(chat);
    return msg;
  }
  function explainFailure(p, done) {
    const a = agent(p.agentId);
    const tail = (done.stderrTail || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ');
    if (/not signed in|log ?in|authenticat|api key|unauthorized|401/i.test(tail)) return `${a ? a.label : p.agentId} is not signed in. Open it in a normal tab first and sign in. ${tail}`.trim();
    if (/usage limit|rate limit|quota|429|credit/i.test(tail)) return `${a ? a.label : p.agentId} is out of usage right now. ${tail}`.trim();
    return `${a ? a.label : p.agentId} did not reply${done.code != null ? ` (exit ${done.code})` : ''}. ${tail}`.trim();
  }

  /** Remove terminal noise some CLIs add around a plain answer. */
  function cleanReply(text) {
    return String(text)
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '')
      .replace(/^\s*(hook:.*\n)+/gim, '')
      .trim();
  }

  const isDone = (m) => m && m.status === 'done' && /^\s*DONE\b/i.test(m.text);

  async function orchestrate(chat, userText) {
    run = { cancelled: false, runIds: new Set(), avoid: new Set() };
    chat.running = true;
    renderChrome();
    addMessage(chat, { role: 'user', text: userText, name: 'You' });
    save(chat);
    const ps = chat.participants;
    try {
      if (chat.mode === 'round') {
        for (let r = 1; r <= chat.rounds && !run.cancelled; r++) {
          const replies = [];
          for (const p of ps) {
            if (run.cancelled) break;
            const first = r === 1 && replies.length === 0 && chat.messages.filter((m) => m.role === 'agent').length === 0;
            replies.push(
              await turn(
                chat,
                p,
                first
                  ? 'Start working on the request: do it, or lay out the first steps. If you change files, say which.'
                  : 'Add what is missing, fix anything the others got wrong, and make progress on the request. If you change files, say which. If nothing more is needed, reply with one line starting with "DONE:" and why.',
                { edits: true, label: `Round ${r}` }
              )
            );
          }
          if (replies.length && replies.every(isDone)) break;
        }
      } else if (chat.mode === 'review') {
        const lead = ps[0];
        const draft = await turn(chat, lead, 'Do the work the user asked for. If you change files, say which. Then summarise what you did.', { edits: true, label: 'Draft' });
        if (draft && draft.status === 'done') {
          for (const p of ps.slice(1)) {
            if (run.cancelled) break;
            await turn(chat, p, `Review ${labelOf(lead).name}'s work against the request. Check the files if you need to. List concrete problems and the exact fix for each, or say it is correct. Do not edit files.`, { edits: false, label: 'Review' });
          }
          if (!run.cancelled) await turn(chat, lead, 'Read the reviews above. Fix every valid problem (edit the files), skip invalid ones with a short reason, and finish with a summary of the final result.', { edits: true, label: 'Revise' });
        }
      } else {
        const lead = ps[0];
        // Everyone answers alone and at the same time: nobody edits yet, so there is nothing to collide.
        const answers = ps.map((p) => turn(chat, p, 'Answer the request on your own: give your best solution or plan. Do not edit files yet.', { edits: false, label: 'Answer' }));
        await Promise.all(answers);
        if (!run.cancelled) await turn(chat, lead, 'Combine the answers above into one final result. Take the best ideas, resolve disagreements, apply the changes to the files, and summarise what you did.', { edits: true, label: 'Merge' });
      }
    } finally {
      chat.running = false;
      run = null;
      renderChrome();
      save(chat);
      if (typeof refreshGit === 'function') refreshGit();
    }
  }

  function stop() {
    if (!run) return;
    run.cancelled = true;
    for (const id of run.runIds) invoke('group_cancel', { runId: id }).catch(() => {});
  }

  /* ---------------------------------------------------------- view */

  const esc2 = esc;

  function render(text) {
    // Plain text with fenced code blocks and `inline code`; everything else escaped.
    const parts = String(text).split(/```/);
    return parts
      .map((part, i) => {
        if (i % 2 === 1) {
          const body = part.replace(/^[\w+-]*\n/, '');
          return `<pre class="team-code"><code>${esc2(body.replace(/\n$/, ''))}</code></pre>`;
        }
        return esc2(part)
          .replace(/`([^`\n]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
          .replace(/^(?:[-*] )(.+)$/gm, '• $1')
          .replace(/\n/g, '<br>');
      })
      .join('');
  }

  /** Which participant slot sent a message: the agent and model together, so
   *  three OpenCode models still look like three different people. */
  const slotOf = (chat, m) => Math.max(0, chat.participants.findIndex((p) => p.agentId === m.agentId && (p.modelId || 'default') === (m.modelId || 'default')));

  function messageHtml(chat, m) {
    if (m.role === 'user') {
      return `<article class="team-msg user" data-id="${m.id}"><div class="team-body"><div class="team-text">${render(m.text)}</div></div></article>`;
    }
    const a = agent(m.agentId);
    const hue = HUES[slotOf(chat, m) % HUES.length];
    const sameAgent = chat.participants.filter((p) => p.agentId === m.agentId).length > 1;
    const initials = (sameAgent && m.model ? m.model : a ? a.label : m.name || '?').split(/[\s.-]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    const status = m.status === 'streaming' ? '<span class="team-flag">replying…</span>' : m.status === 'stopped' ? '<span class="team-flag">stopped</span>' : '';
    const body = m.status === 'error'
      ? `<p class="team-error">${esc2(m.error || 'No reply.')}</p>`
      : m.text
        ? `<div class="team-text">${render(m.text)}</div>`
        : '';
    return `<article class="team-msg agent" data-id="${m.id}" style="--hue:${hue}">
      <span class="team-avatar" aria-hidden="true">${esc2(initials)}</span>
      <div class="team-body">
        <header><strong>${esc2(m.name)}</strong>${m.model ? `<span>${esc2(m.model)}</span>` : ''}${m.kind ? `<em>${esc2(m.kind)}</em>` : ''}${status}</header>
        ${m.note ? `<p class="team-note">${esc2(m.note)}</p>` : ''}
        ${body}
      </div>
    </article>`;
  }

  function renderThread() {
    if (!view || !current) return;
    const thread = view.querySelector('.team-thread');
    const stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
    thread.innerHTML = current.messages.length
      ? current.messages.map((m) => messageHtml(current, m)).join('')
      : `<div class="team-empty"><strong>One chat, several agents.</strong><p>${esc2(MODES[current.mode].hint)} Add agents above, then describe the task. They all work in <code>${esc2(basename(current.cwd))}</code>.</p></div>`;
    if (stick) thread.scrollTop = thread.scrollHeight;
  }

  function updateMessage(msg) {
    if (!view || !current) return;
    const el = view.querySelector(`[data-id="${msg.id}"]`);
    if (!el) return renderThread();
    const thread = view.querySelector('.team-thread');
    const stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
    el.outerHTML = messageHtml(current, msg);
    if (stick) thread.scrollTop = thread.scrollHeight;
  }

  function renderChrome() {
    if (!view || !current) return;
    const c = current;
    view.querySelector('.team-title').value = c.title;
    view.querySelector('.team-members').innerHTML =
      c.participants
        .map((p, i) => {
          const l = labelOf(p);
          return `<span class="team-chip" style="--hue:${HUES[i % HUES.length]}"><i></i><span>${esc2(l.name)}${l.model ? ` · ${esc2(l.model)}` : ''}</span><button type="button" data-remove="${i}" aria-label="Remove ${esc2(l.name)}" ${c.running ? 'disabled' : ''}>${ICONS.close}</button></span>`;
        })
        .join('') + `<button type="button" class="chip" data-add ${c.running || c.participants.length >= 5 ? 'disabled' : ''}>${ICONS.plus} Add agent</button>`;
    view.querySelectorAll('[data-mode]').forEach((b) => {
      const on = b.dataset.mode === c.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.disabled = Boolean(c.running);
    });
    const rounds = view.querySelector('[data-rounds]');
    rounds.value = String(c.rounds);
    rounds.disabled = Boolean(c.running);
    rounds.closest('label').hidden = c.mode !== 'round';
    view.querySelector('[data-edits]').checked = c.allowEdits;
    view.querySelector('[data-edits]').disabled = Boolean(c.running);
    view.querySelector('.team-folder').textContent = c.cwd;
    view.querySelector('.team-folder').title = c.cwd;
    const ready = c.participants.length >= 2;
    const send = view.querySelector('[data-send]');
    const stopBtn = view.querySelector('[data-stop]');
    send.hidden = Boolean(c.running);
    stopBtn.hidden = !c.running;
    send.disabled = !ready;
    view.querySelector('textarea').placeholder = ready
      ? c.running ? 'The team is working…' : 'Describe the task for the whole team. Enter sends, Shift+Enter adds a line.'
      : 'Add at least two agents to start.';
    view.querySelector('textarea').disabled = Boolean(c.running);
    view.querySelector('.team-mode-hint').textContent = MODES[c.mode].hint;
    renderTabs();
  }

  function build() {
    view = document.createElement('section');
    view.id = 'teamView';
    view.className = 'team-view';
    view.hidden = true;
    view.setAttribute('aria-label', 'Team chat');
    view.innerHTML = `
      <header class="team-head">
        <input class="team-title" aria-label="Chat title" maxlength="80" />
        <span class="grow"></span>
        <button class="btn quiet" data-new-team>New team chat</button>
        <button class="btn quiet danger" data-delete-team>Delete</button>
      </header>
      <div class="team-controls">
        <div class="team-members" aria-label="Agents in this chat"></div>
        <div class="team-options">
          <div class="segmented" role="radiogroup" aria-label="How the agents work together">
            ${Object.entries(MODES).map(([k, v]) => `<button class="theme-option" data-mode="${k}" role="radio">${v.label}</button>`).join('')}
          </div>
          <label class="team-rounds">Rounds <select data-rounds><option>1</option><option>2</option><option>3</option></select></label>
          <label class="toggle-row"><input type="checkbox" data-edits /> <span>Agents may edit files</span></label>
          <span class="team-folder"></span>
        </div>
        <p class="team-mode-hint note"></p>
      </div>
      <div class="team-thread" role="log" aria-live="polite"></div>
      <form class="team-composer">
        <textarea rows="2" aria-label="Message for the team"></textarea>
        <div class="team-composer-row">
          <span class="note">Agents take turns in one folder, so edits never collide.</span>
          <span class="grow"></span>
          <button type="button" class="btn" data-stop hidden>Stop</button>
          <button type="submit" class="btn primary" data-send>Send to team</button>
        </div>
      </form>`;
    $('app').querySelector('.main').appendChild(view);

    view.querySelector('.team-title').addEventListener('change', (e) => {
      current.title = e.target.value.trim() || 'Team chat';
      save(current);
      renderTabs();
    });
    view.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove]');
      if (rm && !current.running) {
        current.participants.splice(Number(rm.dataset.remove), 1);
        renderChrome();
        renderThread();
        save(current);
      } else if (e.target.closest('[data-add]')) addMenu(e.target.closest('[data-add]'));
      else if (e.target.closest('[data-mode]') && !current.running) {
        current.mode = e.target.closest('[data-mode]').dataset.mode;
        renderChrome();
        renderThread();
        save(current);
      } else if (e.target.closest('[data-stop]')) stop();
      else if (e.target.closest('[data-new-team]')) show(create().id);
      else if (e.target.closest('[data-delete-team]')) removeCurrent();
    });
    view.querySelector('[data-rounds]').addEventListener('change', (e) => {
      current.rounds = Number(e.target.value);
      save(current);
    });
    view.querySelector('[data-edits]').addEventListener('change', (e) => {
      current.allowEdits = e.target.checked;
      save(current);
    });
    const form = view.querySelector('.team-composer');
    const ta = form.querySelector('textarea');
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text || current.running || current.participants.length < 2) return;
      ta.value = '';
      orchestrate(current, text);
    });
  }

  async function addMenu(anchor) {
    const have = new Set(current.participants.map((p) => p.agentId));
    openMenu(anchor, {
      title: 'Add an agent to the chat',
      items: capable().map((a) => ({
        label: a.label,
        hint: have.has(a.id) ? 'add another model' : a.free ? 'Free' : '',
        run: async () => {
          if (a.dynamic_models && !state.catalogs[a.id]) await fetchCatalog(a, { quiet: true });
          const models = allModels(a).filter((m) => !(a.requiresModelSelection && m.id === 'default'));
          if (models.length <= 1 && !a.requiresModelSelection) {
            addParticipant(a, models[0] ? models[0].id : 'default');
          } else {
            openMenu(anchor, {
              title: `${a.label} · model`,
              search: models.length > 8 ? 'Search models' : '',
              empty: 'No models were found for this agent.',
              items: models.map((m) => ({ label: m.label, hint: modelPrice(a, m.id), run: () => addParticipant(a, m.id) }))
            });
          }
        }
      }))
    });
  }

  function addParticipant(a, modelId) {
    current.participants.push({ agentId: a.id, modelId });
    renderChrome();
    renderThread();
    save(current);
  }

  async function removeCurrent() {
    if (current.running) return toast('Stop the team first.');
    if (!(await confirmDialog('Delete this team chat?', 'The conversation is removed from this PC. Files the agents changed stay as they are.', 'Delete'))) return;
    const id = current.id;
    await invoke('team_delete', { id }).catch(() => {});
    await invoke('delete_transcript', { id }).catch(() => {});
    chats.delete(id);
    prefs.openTeams = (prefs.openTeams || []).filter((x) => x !== id);
    savePrefs();
    hide();
    selectSession(null);
  }

  /* ---------------------------------------------------------- tabs and showing */

  let keep = false;

  function show(id) {
    const chat = chats.get(id);
    if (!chat) return;
    if (!view) build();
    current = chat;
    prefs.openTeams = [...new Set([...(prefs.openTeams || []), id])];
    savePrefs();
    keep = true;
    selectSession(null);
    keep = false;
    view.hidden = false;
    document.querySelector('.main').classList.add('team-open');
    renderChrome();
    renderThread();
    view.querySelector('textarea').focus();
  }

  function hide() {
    if (view) view.hidden = true;
    document.querySelector('.main').classList.remove('team-open');
    current = null;
    renderTabs();
  }

  function renderTabs() {
    const bar = $('tabs');
    bar.querySelectorAll('.team-tab').forEach((t) => t.remove());
    for (const id of prefs.openTeams || []) {
      const c = chats.get(id);
      if (!c) continue;
      const el = document.createElement('div');
      el.className = `tab team-tab${current && current.id === id && view && !view.hidden ? ' active' : ''}`;
      el.setAttribute('role', 'tab');
      el.dataset.team = id;
      el.title = `${c.title}\nTeam chat`;
      el.innerHTML = `<div class="tab-row"><span class="tab-icon">${ICONS.team}</span><span class="tab-title">${esc2(c.title)}</span></div>
        <div class="tab-meta">${c.running ? 'working…' : `${c.participants.length} agents`}</div>
        <button class="tab-close" data-team-close="${id}" aria-label="Close ${esc2(c.title)}">${ICONS.close}</button>`;
      bar.appendChild(el);
    }
  }

  ICONS.team = svg('<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c0-3.3 2.7-6 6-6s6 2.7 6 6M15 14.2c.6-.2 1.3-.3 2-.3 2.2 0 4 1.8 4 4"/>', 13);

  async function restoreOpen() {
    for (const id of prefs.openTeams || []) {
      try {
        const chat = JSON.parse(await invoke('team_load', { id }));
        chat.messages.forEach((m) => {
          if (m.status === 'streaming') {
            m.status = 'error';
            m.error = 'ezCLI closed while this was replying.';
          }
        });
        chat.running = false;
        chats.set(chat.id, chat);
      } catch {
        prefs.openTeams = prefs.openTeams.filter((x) => x !== id);
      }
    }
    renderTabs();
  }

  return { _test: { nextModel, TRANSIENT }, current: () => current, create, show, hide, openSaved, renderTabs, restoreOpen, isOpen: () => Boolean(view && !view.hidden), keepOpen: () => keep, running: () => Boolean(run) };
})();

hooks.view.push(() => {
  if (!Team.keepOpen()) Team.hide();
});
hooks.tabs.push(() => Team.renderTabs());
hooks.boot.push(async () => {
  await Team.restoreOpen();
  $('tabs').addEventListener('click', (e) => {
    const close = e.target.closest('[data-team-close]');
    const tab = e.target.closest('[data-team]');
    if (close) {
      e.stopPropagation();
      prefs.openTeams = (prefs.openTeams || []).filter((x) => x !== close.dataset.teamClose);
      savePrefs();
      if (Team.isOpen()) Team.hide();
      Team.renderTabs();
      if (!state.activeId) selectSession(null);
    } else if (tab) Team.show(tab.dataset.team);
  }, true);
  const b = document.createElement('button');
  b.className = 'chip home-team';
  b.title = 'Several agents working together in one chat (Ctrl+Alt+G)';
  b.innerHTML = `${ICONS.team} Team chat`;
  b.addEventListener('click', () => Team.show(Team.create().id));
  $('agentStrip').after(b);
});

hooks.shortcut.push((code) => {
  if (code !== 'KeyG') return false;
  Team.show(Team.create().id);
  return true;
});

registerCommand({ group: 'Start', label: 'Team chat: several agents in one conversation', keys: 'Ctrl Alt G', run: () => Team.show(Team.create().id) });
