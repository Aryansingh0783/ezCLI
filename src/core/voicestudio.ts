/* VoiceStudio as a one-click connector: what Settings says and offers for each state. */

export interface Connector {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}
export interface VoiceStudioView {
  text: string;
  /** The buttons to show, in order. */
  actions: ('connect' | 'disconnect' | 'check' | 'get')[];
  tone: 'ok' | 'warn' | 'plain';
}

export const VOICESTUDIO_NAME = 'VoiceStudio';
export const VOICESTUDIO_HOME = 'https://github.com/debpalash/voicestudio';

const local = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/mcp\/?$/i.test(String(url || '').trim());

/** The connector that points at VoiceStudio on this computer, whatever the user has named it. */
export function findConnector(connectors: readonly Connector[], mcpUrl: string): Connector | undefined {
  const want = mcpUrl.replace(/\/$/, '').toLowerCase().replace('localhost', '127.0.0.1');
  return connectors.find((c) => local(c.url) && c.url.trim().replace(/\/$/, '').toLowerCase().replace('localhost', '127.0.0.1') === want);
}

export function view(running: boolean, connector: Connector | undefined): VoiceStudioView {
  const on = Boolean(connector && connector.enabled);
  if (running && on) {
    return {
      text: 'Connected. New Claude Code, Codex, OpenCode and Gemini sessions can speak text, transcribe audio and clone or design voices. Restart a session that is already open to give it these tools. Local models cannot use connectors.',
      actions: ['disconnect'],
      tone: 'ok'
    };
  }
  if (running) return { text: 'VoiceStudio is open on this computer.', actions: ['connect'], tone: 'plain' };
  if (on) return { text: 'Connected, but VoiceStudio is not open, so agents cannot reach it. Open VoiceStudio, then check again.', actions: ['check', 'disconnect'], tone: 'warn' };
  return { text: 'VoiceStudio is not open. Open it and check again, or install it first.', actions: ['check', 'get'], tone: 'plain' };
}

/** The connector list with VoiceStudio added or switched on. */
export function connect(connectors: readonly Connector[], mcpUrl: string, newId: () => string): Connector[] {
  const have = findConnector(connectors, mcpUrl);
  if (have) return connectors.map((c) => (c === have ? { ...c, enabled: true } : c));
  return [...connectors, { id: newId(), name: VOICESTUDIO_NAME, url: mcpUrl, enabled: true }];
}

/** The connector list without it. */
export function disconnect(connectors: readonly Connector[], mcpUrl: string): Connector[] {
  const have = findConnector(connectors, mcpUrl);
  return have ? connectors.filter((c) => c !== have) : [...connectors];
}
