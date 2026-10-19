'use strict';
/* The agent browser: the same window agents drive through PC control's
 * browser_* tools. Opening it here lets you watch what the agent does there,
 * or browse in it yourself; the page it loads has no access to ezCLI. */

async function openAgentBrowser(url) {
  try {
    await invoke('open_agent_browser', { url: url || null });
  } catch (e) {
    toast(`Couldn't open the browser: ${e}`, 'error');
  }
}

hooks.boot.push(() => {
  $('browserBtn')?.addEventListener('click', () => openAgentBrowser());
});

registerCommand({
  group: 'App',
  label: 'Browser: open the agent browser',
  run: () => openAgentBrowser()
});
