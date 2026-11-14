/* Names a module needs from a module that loads after it (for example app.ts calling ChatView).
 *
 * A static import there would make a cycle that runs the later module first, before the things it
 * depends on exist. So the later module registers itself here once it has loaded, and callers read it at
 * call time. The imports below are types only: they cost nothing at run time and create no cycle. */
export interface Late {
  ChatFind: typeof import('./features/chat').ChatFind;
  ChatView: typeof import('./features/chat').ChatView;
  Create: typeof import('./features/create').Create;
  Glass: typeof import('./features/glass').Glass;
  GeminiSetup: typeof import('./features/gemini').GeminiSetup;
  Graphify: typeof import('./features/graphify').Graphify;
  Installer: typeof import('./features/installer').Installer;
  Knowledge: typeof import('./features/knowledge').Knowledge;
  MessageQueue: typeof import('./features/queue').MessageQueue;
  Models: typeof import('./features/models').Models;
  Sessions: typeof import('./features/sessions').Sessions;
  Team: typeof import('./features/team').Team;
  TranscriptSearch: typeof import('./features/transcripts').TranscriptSearch;
  WebSearch: typeof import('./features/websearch').WebSearch;
  flushMemory: typeof import('./features/transcripts').flushMemory;
  terminalText: typeof import('./features/transcripts').terminalText;
}

/** Empty until each module has loaded; every reader runs after start-up, from an event or a hook. */
export const late = {} as Late;
