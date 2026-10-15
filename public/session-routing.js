/* Session-routing decisions shared by the browser UI and Node regression
 * tests. A continuation mode reopens a provider-owned conversation, so it is
 * never safe to carry one invisibly into a fresh ezCLI tab or model switch. */
(function attachSessionRouting(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ezCliSessionRouting = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function sessionRouting() {
  function selectedMode(agent, modeId) {
    return (agent && Array.isArray(agent.modes) && agent.modes.find((mode) => mode.id === modeId)) || null;
  }

  /**
   * Built-in modes declare this explicitly. The conservative fallback keeps
   * editable configs made before `resumesSession` was added safe as well.
   */
  function isContinuationMode(agent, modeId) {
    const mode = selectedMode(agent, modeId);
    if (!mode) return false;
    if (mode.resumesSession === true || mode.resumes_session === true) return true;
    const id = String(mode.id || '').toLowerCase();
    if (id === 'continue' || id === 'resume') return true;
    const args = Array.isArray(mode.args) ? mode.args.map((arg) => String(arg).toLowerCase()) : [];
    return args.some((arg) => arg === '--continue' || arg === '--resume' || arg.startsWith('--resume=') || arg === 'resume');
  }

  /**
   * Keep an ordinary mode such as Plan or Full auto, but replace Resume /
   * Continue with the agent's normal fresh-session mode.
   */
  function freshModeId(agent, currentModeId) {
    const modes = (agent && Array.isArray(agent.modes) && agent.modes) || [];
    if (currentModeId && !isContinuationMode(agent, currentModeId) && modes.some((mode) => mode.id === currentModeId)) {
      return currentModeId;
    }
    const fresh = modes.find((mode) => mode.id === 'default' && !isContinuationMode(agent, mode.id))
      || modes.find((mode) => !isContinuationMode(agent, mode.id));
    return fresh ? fresh.id : (modes[0] ? modes[0].id : 'default');
  }

  /** A model flag is applied only when the CLI starts, never in place. */
  function modelSwitchPlan(agent, currentModeId, modelId) {
    return { modelId, modeId: freshModeId(agent, currentModeId) };
  }

  return { isContinuationMode, freshModeId, modelSwitchPlan };
});
