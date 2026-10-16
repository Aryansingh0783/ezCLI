'use strict';
/* Usage-limit router.
 *
 * When an agent's latest output says it ran out of usage, a banner offers to
 * continue the task in another installed agent, free ones first. The new
 * tab gets a hand-off prompt built from your recent messages in the old tab.
 * Nothing switches automatically, and the banner can be dismissed. */

const LIMIT_PATTERNS = [
  /\b(usage|rate|session|weekly|daily|monthly|5[- ]hour|hourly)\s+limits?\s+(reached|exceeded|hit)\b/i,
  /\byou(?:'ve| have)\s+(?:hit|reached|exceeded|used up)\s+(?:your|the)\b.{0,40}\blimit/i,
  /\b(quota|credits?)\s+(?:has been |have been |is |are )?(exceeded|exhausted|used up|depleted)\b/i,
  /\bout of (credits|quota|usage)\b/i,
  /\binsufficient (credits|quota|balance)\b/i,
  /\b429\b.{0,40}\b(too many requests|rate[- ]limit)/i,
  /\bupgrade (?:your plan|to (?:pro|plus|max))\b.{0,40}\b(continue|more usage|keep using)/i,
  /\blimit (?:will )?resets? (?:at|in)\b/i
];

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '');

const Router = (() => {
  const COOLDOWN = 5 * 60 * 1000;

  function looksLimited(text) {
    const t = stripAnsi(text);
    return LIMIT_PATTERNS.some((re) => re.test(t));
  }

  function alternatives(s) {
    const current = agent(s.agentId);
    return state.agents
      .filter((a) => a.available && a.id !== s.agentId && !(current && a.command === current.command && a.vendor === current.vendor))
      .sort((a, b) => Number(Boolean(b.free)) - Number(Boolean(a.free)))
      .slice(0, 4);
  }

  function handoffPrompt(s) {
    const a = agent(s.agentId);
    const asks = (s.prompts || []).slice(-5);
    const list = asks.length ? asks.map((p) => `- ${p.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n') : '- (no messages were typed through ezCLI in that tab)';
    return `I was working in this folder with ${a ? a.label : 'another agent'} and it hit its usage limit. Please continue the task. My recent requests there were:\n${list}\nStart by checking the current state of the files, then carry on.`;
  }

  function banner(s) {
    const notice = $('sessionAgentNotice');
    if (!notice || s.id !== state.activeId || !s.limitHit) return;
    const alts = alternatives(s);
    notice.hidden = false;
    notice.classList.add('limit-notice');
    notice.innerHTML = `<strong>${esc(s.title)} looks out of usage.</strong>
      ${alts.length
        ? `Continue this task in another agent: ${alts.map((a) => `<button class="btn quiet" data-route="${esc(a.id)}">${esc(a.label)}${a.free ? ' <span class="free-badge">Free</span>' : ''}</button>`).join(' ')}`
        : 'No other agent is installed. Open the Health check to install a free one.'}
      <button class="btn quiet limit-dismiss" data-route-dismiss aria-label="Dismiss">${ICONS.close}</button>`;
  }

  async function route(s, agentId) {
    const prompt = handoffPrompt(s);
    s.limitHit = false;
    const next = await createSession(agentId, { prompt, cwd: s.cwd, spaceId: s.spaceId });
    if (next) toast(`Continuing in ${agent(agentId).label}. It got a summary of your recent requests.`, 'ok');
  }

  return { looksLimited, banner, route };
})();

hooks.output.push((s, chunk) => {
  s.recentOut = ((s.recentOut || '') + chunk).slice(-6000);
});

hooks.idle.push((s) => {
  const text = s.recentOut || '';
  s.recentOut = '';
  if (prefs.limitRouter === false || !text) return;
  if (s.limitShownAt && Date.now() - s.limitShownAt < 5 * 60 * 1000) return;
  if (!Router.looksLimited(text)) return;
  s.limitHit = true;
  s.limitShownAt = Date.now();
  if (s.id === state.activeId) Router.banner(s);
  else toast(`${s.title} looks out of usage. Open it to continue in another agent.`, 'error', () => selectSession(s.id));
});

hooks.view.push((s) => {
  if (s && s.limitHit) Router.banner(s);
  else if ($('sessionAgentNotice')) $('sessionAgentNotice').classList.remove('limit-notice');
});

/* Remember what was typed in each tab, for the hand-off prompt. */
{
  const original = sendComposer;
  // eslint-disable-next-line no-global-assign
  sendComposer = async function () {
    const s = active();
    const typed = $('ptyInput').value.trim();
    if (s && typed) (s.prompts ||= []).push(typed);
    if (s && s.prompts && s.prompts.length > 20) s.prompts.splice(0, s.prompts.length - 20);
    return original();
  };
}
hooks.launched.push((s) => {
  if (s.pendingPrompt && !(s.prompts && s.prompts.length)) s.prompts = [s.pendingPrompt];
});

hooks.boot.push(() => {
  $('sessionAgentNotice').addEventListener('click', (e) => {
    const s = active();
    if (!s) return;
    const go = e.target.closest('[data-route]');
    if (go) return Router.route(s, go.dataset.route);
    if (e.target.closest('[data-route-dismiss]')) {
      s.limitHit = false;
      renderSessionAgentNotice(s);
      $('sessionAgentNotice').classList.remove('limit-notice');
    }
  });
});
