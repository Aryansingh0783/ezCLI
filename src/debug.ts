/* A handle on the running app for the developer console and the UI smoke test: `window.ezcli`.
 * The old script files put every one of these on the global scope; modules do not, so the ones worth
 * reaching from outside are listed here on purpose. Nothing in the app reads this object. */
import { agent, createSession, modelLabel, prefs } from './app';
import { state } from './stores/app';
import { ChatView } from './features/chat';
import { Models } from './features/models';
import { WebSearch } from './features/websearch';

const handle = { state, prefs, agent, createSession, modelLabel, ChatView, Models, WebSearch };
declare global {
  interface Window {
    ezcli: typeof handle;
  }
}
window.ezcli = handle;
