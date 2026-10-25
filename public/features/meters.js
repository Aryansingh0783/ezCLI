'use strict';
/* Usage meters in the style of the Claude desktop app: a small context ring in the session's
 * message box, a popover with the context window and plan usage limits as thin bars, and an
 * all-agents view in the Usage dialog.
 *
 * The numbers are the ones ezCLI already reads from each CLI's own files (usage.js): context
 * size for Claude Code, Codex and OpenCode, plus Codex's plan limits with reset times. A CLI
 * that reports nothing shows a clearly marked estimate instead of a made-up percentage. The
 * last reading per agent is remembered so the all-agents view still has something to show
 * when an agent isn't running. Nothing here makes a network request. */

const Meters = (() => {
  const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n || 0)));

  /** "2 hr 4 min", the way Claude words a reset. */
  function resetsIn(secs) {
    const d = secs * 1000 - Date.now();
    if (d <= 0) return 'Resets now';
    const mins = Math.round(d / 60000);
    const days = Math.floor(mins / 1440);
    const hrs = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (days) return `Resets in ${days} day${days > 1 ? 's' : ''} ${hrs} hr`;
    if (hrs) return `Resets in ${hrs} hr ${m} min`;
    return `Resets in ${Math.max(1, m)} min`;
  }

  const ago = (ms) => {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} hr ago` : `${Math.round(h / 24)} day${Math.round(h / 24) > 1 ? 's' : ''} ago`;
  };

  const bar = (pct, label, sub) => {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    return `<div class="meter">
      <div class="meter-top"><span class="meter-label">${esc(label)}</span>${sub ? `<span class="meter-sub">${esc(sub)}</span>` : ''}</div>
      <div class="meter-row"><div class="meter-track" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(label)}"><i class="${p >= 85 ? 'hot' : ''}" style="width:${p}%"></i></div><span class="meter-pct">${p}% used</span></div>
    </div>`;
  };

  /** What we know about a session right now: real numbers, or a labelled estimate. */
  function read(s) {
    const a = agent(s.agentId) || {};
    const u = s.liveUsage;
    if (u) {
      const ctxPct = u.contextWindow ? Math.min(100, (u.contextTokens / u.contextWindow) * 100) : null;
      return { real: true, agent: a.label || s.agentId, model: u.model || '', ctxPct, ctx: u.contextTokens, window: u.contextWindow, limits: u.limits || [], plan: u.plan, credits: u.credits, input: u.inputTokens, output: u.outputTokens, cached: u.cachedTokens, turns: u.turns, cost: u.cost };
    }
    const text = typeof terminalText === 'function' ? terminalText(s) : '';
    const tokens = Math.round((text.length + (s.prompts || []).join(' ').length) / 4);
    return { real: false, agent: a.label || s.agentId, model: '', ctxPct: null, ctx: tokens, window: 0, limits: [], messages: (s.prompts || []).length };
  }

  /** Remember the latest real reading for each agent, for the all-agents view. */
  function remember(s) {
    if (!s || !s.liveUsage) return;
    const u = s.liveUsage;
    prefs.usageSeen = prefs.usageSeen || {};
    prefs.usageSeen[s.agentId] = {
      at: Date.now(), model: u.model || '', plan: u.plan || '', ctx: u.contextTokens, window: u.contextWindow,
      limits: (u.limits || []).map((l) => ({ label: l.label, usedPercent: l.usedPercent, resetsAt: l.resetsAt || 0 })), credits: u.credits || ''
    };
    clearTimeout(remember.t);
    remember.t = setTimeout(() => savePrefs(), 1500);
  }

  /* ---------------------------------------------------------------- the ring */
  const R = 7.5;
  const C = 2 * Math.PI * R;
  const ring = (pct, estimated) => `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><circle class="ring-track" cx="10" cy="10" r="${R}"/>${pct == null ? '' : `<circle class="ring-fill${pct >= 85 ? ' hot' : ''}" cx="10" cy="10" r="${R}" stroke-dasharray="${((Math.max(2, pct) / 100) * C).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 10 10)"/>`}${estimated ? '<circle class="ring-est" cx="10" cy="10" r="1.6"/>' : ''}</svg>`;

  let btn = null;
  function mountButton() {
    const row = document.querySelector('#ptyComposer .composer-row');
    if (!row || btn) return;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'ptyUsage';
    btn.className = 'usage-ring';
    btn.hidden = true;
    btn.addEventListener('click', () => togglePopover());
    const stack = $('ptyRight');
    if (stack) stack.append(btn);
    else row.insertBefore(btn, row.querySelector('.send-btn') || null);
  }

  function renderButton() {
    if (!btn) return;
    const s = active();
    if (!s || s.status !== 'running') {
      btn.hidden = true;
      closePopover();
      return;
    }
    const d = read(s);
    btn.hidden = false;
    const word = d.real ? (d.ctxPct == null ? 'usage' : `${Math.round(d.ctxPct)}% context`) : 'estimated';
    btn.innerHTML = `${ring(d.ctxPct, !d.real)}<span>${word}</span>`;
    btn.title = d.real ? (d.ctxPct == null ? 'Usage' : `Context ${Math.round(d.ctxPct)}% used`) : 'Usage (estimated)';
    btn.setAttribute('aria-label', btn.title);
    if (pop) drawPopover();
  }

  /* ------------------------------------------------------------- the popover */
  let pop = null;
  function closePopover() {
    if (pop) pop.remove();
    pop = null;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function limitsHtml(limits, agentLabel, emptyNote) {
    if (limits.length) return limits.map((l) => bar(l.usedPercent, l.label, l.resetsAt ? resetsIn(l.resetsAt) : '')).join('');
    return `<p class="meter-note">${esc(emptyNote || `${agentLabel} doesn't report plan limits to ezCLI. Use its own usage command to see them.`)}</p>`;
  }

  function drawPopover() {
    const s = active();
    if (!s || !pop) return;
    const d = read(s);
    const parts = [];
    parts.push(`<div class="pop-title"><b>${esc(d.agent)}</b>${d.model ? `<span>${esc(d.model)}</span>` : ''}${d.plan ? `<span class="pop-plan">${esc(d.plan)}</span>` : ''}</div>`);
    if (d.real && d.ctxPct != null) parts.push(`<h4>Context window</h4>${bar(d.ctxPct, 'Used in this conversation', `${fmtTok(d.ctx)} of ${fmtTok(d.window)} tokens`)}`);
    else if (d.real && d.ctx) parts.push(`<h4>Context window</h4><p class="meter-note">${fmtTok(d.ctx)} tokens in this conversation.</p>`);
    else parts.push(`<h4>Context window</h4><p class="meter-note">${esc(d.agent)} keeps no readable usage, so this is an estimate: about ${fmtTok(d.ctx)} tokens so far, from the text on screen.</p>`);
    parts.push(`<h4>Plan usage limits</h4>${limitsHtml(d.limits, d.agent)}`);
    if (d.credits) parts.push(`<p class="meter-note">Credits: ${esc(d.credits)}</p>`);
    if (d.real) {
      const stats = [['Input', fmtTok(d.input)], ['Output', fmtTok(d.output)], ['Cached', fmtTok(d.cached)], ['Turns', String(d.turns || 0)]];
      if (d.cost != null && d.cost > 0) stats.push(['Cost', `$${d.cost.toFixed(d.cost < 1 ? 3 : 2)}`]);
      parts.push(`<h4>This session</h4><dl class="pop-stats">${stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`);
    } else {
      parts.push(`<h4>This session</h4><dl class="pop-stats"><div><dt>Messages</dt><dd>${d.messages}</dd></div><div><dt>Open</dt><dd>${Math.max(0, Math.round((Date.now() - (s.startedAt || Date.now())) / 60000))} min</dd></div></dl>`);
    }
    parts.push(`<button type="button" class="pop-link" data-all>All agents</button>`);
    pop.innerHTML = parts.join('');
  }

  function togglePopover() {
    if (pop) return closePopover();
    pop = document.createElement('div');
    pop.className = 'usage-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Usage');
    document.body.append(pop);
    drawPopover();
    const r = btn.getBoundingClientRect();
    const w = 340;
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max(12, Math.min(innerWidth - w - 12, r.right - w + 40))}px`;
    pop.style.bottom = `${innerHeight - r.top + 10}px`;
    btn.setAttribute('aria-expanded', 'true');
    pop.addEventListener('click', (e) => {
      if (e.target.closest('[data-all]')) {
        closePopover();
        openAll();
      }
    });
  }

  document.addEventListener('mousedown', (e) => {
    if (pop && !pop.contains(e.target) && !(btn && btn.contains(e.target))) closePopover();
  });
  // capture phase: the terminal would otherwise take the key and send it to the CLI
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && pop) {
        e.stopPropagation();
        closePopover();
      }
    },
    true
  );

  /* ------------------------------------------------------ all agents (dialog) */
  function agentCards() {
    const seen = prefs.usageSeen || {};
    const live = new Map();
    for (const s of state.sessions) if (s.liveUsage && s.status === 'running') live.set(s.agentId, s);
    const rows = [];
    const quiet = [];
    for (const a of state.agents) {
      const l = live.get(a.id);
      const snap = l ? null : seen[a.id];
      let body = '';
      let sub = '';
      if (l) {
        const d = read(l);
        sub = d.plan ? `${d.plan} · live` : 'live';
        if (d.ctxPct != null) body += bar(d.ctxPct, 'Context window', `${fmtTok(d.ctx)} of ${fmtTok(d.window)}`);
        body += d.limits.length ? limitsHtml(d.limits, a.label) : '';
        if (!d.limits.length && d.ctxPct == null) body += `<p class="meter-note">${fmtTok(d.ctx)} tokens in the open conversation.</p>`;
      } else if (snap) {
        sub = `${snap.plan ? snap.plan + ' · ' : ''}last seen ${ago(snap.at)}`;
        if (snap.window) body += bar(Math.min(100, (snap.ctx / snap.window) * 100), 'Context window (last session)', `${fmtTok(snap.ctx)} of ${fmtTok(snap.window)}`);
        body += snap.limits.length ? snap.limits.map((x) => bar(x.usedPercent, x.label, x.resetsAt ? resetsIn(x.resetsAt) : '')).join('') : '';
      } else {
        quiet.push(a);
        continue;
      }
      rows.push(`<section class="agent-meter${l ? ' is-live' : ''}"><header><b>${esc(a.label)}</b><span>${esc(sub)}</span></header>${body}</section>`);
    }
    if (quiet.length) {
      const ready = quiet.filter((a) => a.available).map((a) => a.label);
      const missing = quiet.filter((a) => !a.available).map((a) => a.label);
      rows.push(`<p class="meter-note meter-quiet">${ready.length ? `No readings yet from ${esc(ready.join(', '))}. Start a session and the meters fill in; CLIs that keep no readable usage show an estimate instead.` : ''}${missing.length ? ` Not installed: ${esc(missing.join(', '))}.` : ''}</p>`);
    }
    if (!rows.length) rows.push('<p class="meter-note">Start a session and its meters appear here.</p>');
    return rows.join('');
  }

  function openAll() {
    const dlg = $('usageSheet');
    if (!dlg) return;
    let host = $('usageMeters');
    if (!host) {
      host = document.createElement('div');
      host.id = 'usageMeters';
      const note = dlg.querySelector('.note');
      (note || dlg.querySelector('h2')).after(host);
    }
    host.innerHTML = `<h3 class="usage-h">Plan usage limits</h3><div class="agent-meters">${agentCards()}</div>`;
    if (!dlg.open) dlg.showModal();
    dlg.scrollTop = 0;
    host.scrollIntoView({ block: 'start' });
  }

  return { mountButton, renderButton, remember, openAll, closePopover };
})();

hooks.boot.push(() => {
  Meters.mountButton();
  Meters.renderButton();
  const original = $('openUsage');
  if (original) original.addEventListener('click', () => setTimeout(() => Meters.openAll(), 0));
});
hooks.view.push(() => Meters.renderButton());
hooks.tabs.push(() => Meters.renderButton());
hooks.idle.push((s) => {
  Meters.remember(s);
  Meters.renderButton();
});
hooks.launched.push(() => Meters.renderButton());
setInterval(() => {
  const s = active();
  if (s) Meters.remember(s);
  Meters.renderButton();
}, 5000);

registerCommand({ group: 'App', label: 'Usage meters: all agents', hint: 'context and plan limits', run: () => Meters.openAll() });
