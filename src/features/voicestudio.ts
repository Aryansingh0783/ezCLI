import { $, hooks, invoke, openUrl, prefs, savePrefs, toast } from '../app';
import { renderConnectors } from './connectors';
import { VOICESTUDIO_HOME, connect, disconnect, findConnector, view } from '../core/voicestudio';
/* VoiceStudio (speech, transcription, voice cloning; a separate local app) as a one-click connector.
 *
 * While VoiceStudio is open it serves an MCP endpoint on this computer. Connecting adds that address
 * to the connector list, which is what attaches it to Claude Code, Codex, OpenCode and Gemini
 * sessions. ezCLI does not install or start VoiceStudio; "Get VoiceStudio" opens its page. */

const LABELS = { connect: 'Connect to my agents', disconnect: 'Disconnect', check: 'Check again', get: 'Get VoiceStudio' };
let status = { running: false, port: 3900, mcpUrl: 'http://127.0.0.1:3900/mcp/' };

function render() {
  const box = $('vsState');
  const acts = $('vsActions');
  if (!box || !acts) return;
  const v = view(status.running, findConnector(prefs.connectors || [], status.mcpUrl));
  box.textContent = v.text;
  box.dataset.tone = v.tone;
  acts.innerHTML = v.actions.map((a, k) => `<button type="button" class="btn ${k === 0 && a === 'connect' ? 'primary' : 'quiet'}" data-vs="${a}">${LABELS[a]}</button>`).join('');
}

async function check() {
  const box = $('vsState');
  if (box) box.textContent = 'Looking for VoiceStudio on this computer…';
  try {
    const r = (await invoke('voicestudio_status', {})) as typeof status | null;
    status = r && typeof r.running === 'boolean' && r.mcpUrl ? r : { ...status, running: false };
  } catch {
    status = { ...status, running: false };
  }
  render();
}

function act(what: string) {
  if (what === 'check') return void check();
  if (what === 'get') return openUrl(VOICESTUDIO_HOME);
  const list = prefs.connectors || [];
  if (what === 'connect') {
    prefs.connectors = connect(list, status.mcpUrl, () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    toast('VoiceStudio is connected. New sessions get its tools; restart open ones to use it.', 'ok');
  } else if (what === 'disconnect') {
    prefs.connectors = disconnect(list, status.mcpUrl);
  }
  savePrefs();
  renderConnectors();
  render();
}

hooks.boot.push(() => {
  const acts = $('vsActions');
  if (!acts) return;
  acts.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-vs]') as HTMLElement | null;
    if (b) act(b.dataset.vs || '');
  });
  // look when Settings is opened, not on a timer
  const open = $('settingsBtn');
  if (open) open.addEventListener('click', () => void check());
  render();
});
