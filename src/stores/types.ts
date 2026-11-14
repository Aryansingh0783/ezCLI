/* The shapes of the window's state. The Rust side's own types come from core/ipc.gen.ts. */
import type { AgentOut, BackendReport, OpenTarget, SystemProfile } from '../core/ipc';

/** An agent as the window uses it: what the Rust side reports. */
export type Agent = AgentOut;

export type SessionStatus = 'starting' | 'running' | 'parked' | 'exited' | 'error';

/** Token and cost figures a CLI printed about itself. Null means it never reported that figure. */
export interface UsageMetrics {
  input: number | null;
  output: number | null;
  cached: number | null;
  cost: number | null;
}
/** What lib/usage-parser.ts keeps per session while it reads the terminal output. */
export interface UsageState {
  buffer: string;
  textBlock: unknown;
  observed: boolean;
  total: UsageMetrics;
  turn: UsageMetrics;
  updatedAt: number;
  lastFingerprint: string;
  lastFingerprintAt: number;
}

/** One tab: a CLI in a pseudo-terminal, or the saved description of one that is parked. */
/** A picture or clip made for a session, shown in its chat after the reply to the message that asked. */
export interface SessionMedia {
  key: string;
  path: string;
  mime: string;
  prompt: string;
  /** a short blob: address for the file, so the chat's HTML stays small */
  url: string;
  /** how many of your messages had been sent when it was made */
  after: number;
}

export interface Session {
  id: string;
  /** Pictures and clips made for this session (Create's tools), shown in its chat. */
  media?: SessionMedia[];
  /** The Rust-side terminal id while the process is alive. */
  ptyId: string | null;
  /** Bumped whenever the process is replaced, so a slow launch can tell it has been superseded. */
  launchEpoch: number;
  spaceId: string;
  agentId: string;
  modelId: string;
  modeId: string;
  effortId: string;
  cwd: string;
  title: string;
  status: SessionStatus;
  exitCode?: number | null;
  startedAt: number;
  lastOutputAt: number;
  /** The CLI is producing output for a request (as opposed to idling at its prompt). */
  working: boolean;
  unseen: boolean;
  command: string;
  pendingPrompt: string;
  draft: string;
  context: unknown[];
  imageRefs: unknown[];
  providerSessionId: string;
  resumeNext: boolean;
  transcriptId: string;
  prompts: string[];
  usage: UsageState;
  pcControl: boolean;
  term: Terminal;
  fit: { fit(): void; proposeDimensions(): { cols: number; rows: number } | undefined };
  host: HTMLElement;
  unlisten: Array<() => void>;
  /** Fields a feature module keeps on the session (chat model, web-tool bookkeeping, compare group…).
   *  Each belongs to the module that writes it; see that module for its meaning. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [feature: string]: any;
}

export interface ExplorerState {
  view: string;
  root: string | null;
  expanded: Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cache: Map<string, any>;
  filter: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  file: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  diff: any;
}

export interface AppState {
  agents: Agent[];
  backends: BackendReport | null;
  homeCwd: string;
  sep: string;
  configPath: string;
  openTargets: OpenTarget[];
  sessions: Session[];
  activeId: string | null;
  /** The tab that was last active in each space, so switching space returns to it. */
  activeBySpace: Record<string, string>;
  seq: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  imports: { catalog: any; selected: any };
  /** Space path -> last `git_status` result. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  git: Record<string, any>;
  /** Agent id -> the model ids its own catalog reported. */
  catalogs: Record<string, string[]>;
  /** Coarse hardware facts, used for model advice. */
  systemProfile: SystemProfile | null;
  explorer: ExplorerState;
  /** features/compare.ts: send the composer to every session of the active comparison. */
  compareSendAll?: boolean;
  /** features/git-actions.ts: the commit message being typed. */
  commitDraft?: string;
}
