'use strict';
/* Status-bar usage for every agent.
 *
 * Precedence, most trustworthy first:
 *   1. numbers read from the CLI's own files (Claude Code, Codex, OpenCode,
 *      DeepSeek via OpenCode): context size, session totals, cost, and Codex's
 *      plan limits with reset times;
 *   2. usage lines the CLI printed on screen (the parser in usage-parser.js);
 *   3. an estimate from the conversation text, marked with "≈", for CLIs that
 *      keep nothing readable (Gemini, Ollama, Freebuff, Antigravity).
 * ezCLI makes no network request for any of this. */

const Usage2 = (() => {
  const FILE_BACKED = new Set(['claude-code', 'claude-chat', 'codex', 'opencode', 'deepseek']);
  // OpenCode answers through a short-lived process, so ask it less often.
  const EVERY_MS = { opencode: 20000, deepseek: 20000 };

  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
  const until = (secs) => {
    const d = secs * 1000 - Date.now();
    if (d <= 0) return 'resets now';
    const h = Math.floor(d / 3.6e6);
    const m = Math.floor((d % 3.6e6) / 6e4);
    return h >= 24 ? `resets in ${Math.floor(h / 24)}d ${h % 24}h` : h ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
  };

  function item(label, value, { title = '', hot = false } = {}) {
    return `<span class="live-usage-item${hot ? ' hot' : ''}"${title ? ` title="${esc(title)}"` : ''}><b>${esc(label)}</b>${esc(value)}</span>`;
  }

  function strip() {
    return { box: $('liveUsage'), metrics: $('liveUsageMetrics') };
  }

  function drawReal(s) {
    const u = s.liveUsage;
    const { box, metrics } = strip();
    const parts = [];
    if (u.contextWindow) {
      const pct = Math.min(100, Math.round((u.contextTokens / u.contextWindow) * 100));
      parts.push(item('Context', `${pct}% · ${fmt(u.contextTokens)} of ${fmt(u.contextWindow)}`, { title: 'Tokens in the conversation right now', hot: pct >= 85 }));
    } else if (u.contextTokens) {
      parts.push(item('Context', fmt(u.contextTokens), { title: 'Tokens in the conversation right now' }));
    }
    parts.push(item('Session', `${fmt(u.inputTokens)} in · ${fmt(u.outputTokens)} out`, { title: `${fmt(u.cachedTokens)} of the input was served from cache` }));
    if (u.cost != null && u.cost > 0) parts.push(item('Cost', `$${u.cost.toFixed(u.cost < 1 ? 3 : 2)}`));
    for (const l of u.limits || []) {
      const pct = Math.round(l.usedPercent);
      parts.push(item(l.label, `${pct}% used`, { title: l.resetsAt ? `${l.label} limit ${until(l.resetsAt)}` : `${l.label} limit`, hot: pct >= 85 }));
    }
    if (u.credits) parts.push(item('Credits', u.credits, { title: 'Remaining balance reported by Codex' }));
    box.hidden = false;
    box.classList.remove('unavailable');
    box.title = `${(agent(s.agentId) || {}).label || ''}${u.model ? ` · ${u.model}` : ''}${u.plan ? ` · ${u.plan} plan` : ''}. Read from the CLI's own session file.`;
    metrics.innerHTML = parts.join('');
  }

  /** ≈ tokens in the conversation, from what is on screen plus what was typed. */
  function estimate(s) {
    const text = typeof terminalText === 'function' ? terminalText(s) : '';
    const typed = (s.prompts || []).join(' ').length;
    return Math.round((text.length + typed) / 4);
  }

  function drawEstimate(s) {
    const { box, metrics } = strip();
    const tokens = estimate(s);
    const mins = Math.max(0, Math.round((Date.now() - (s.startedAt || Date.now())) / 60000));
    const msgs = (s.prompts || []).length;
    box.hidden = false;
    box.classList.remove('unavailable');
    box.title = `${(agent(s.agentId) || {}).label || 'This CLI'} does not keep readable usage, so this is estimated from the conversation (about four characters per token).`;
    metrics.innerHTML = [
      item('Chat', `≈ ${fmt(tokens)} tokens`, { title: 'Estimated from the conversation text' }),
      item('Messages', String(msgs)),
      item('Open', mins < 1 ? 'just now' : `${mins} min`)
    ].join('');
  }

  async function refresh(s) {
    if (!s || s.status !== 'running') return;
    const a = agent(s.agentId);
    const gap = EVERY_MS[s.agentId] || 5000;
    if (a && FILE_BACKED.has(a.id) && s.providerSessionId && Date.now() - (s.usageAt || 0) >= gap) {
      s.usageAt = Date.now();
      try {
        const u = await invoke('session_usage', { agentId: s.agentId, sessionId: s.providerSessionId });
        if (u) s.liveUsage = u;
      } catch {
        /* keep the last reading */
      }
    }
    if (s.id === state.activeId) renderLiveUsage(s);
  }

  return { refresh, drawReal, drawEstimate };
})();

{
  const original = renderLiveUsage;
  // eslint-disable-next-line no-global-assign
  renderLiveUsage = function (s) {
    if (s && s.status === 'running') {
      if (s.liveUsage) return Usage2.drawReal(s);
      original(s);
      // Nothing reported on screen either: fall back to the clearly marked estimate.
      if (s.usage && !s.usage.observed) Usage2.drawEstimate(s);
      return;
    }
    original(s);
  };
}

setInterval(() => Usage2.refresh(active()), 5000);
hooks.idle.push((s) => Usage2.refresh(s));
hooks.view.push((s) => Usage2.refresh(s));
hooks.launched.push((s) => {
  s.liveUsage = null;
  s.usageAt = 0;
});
