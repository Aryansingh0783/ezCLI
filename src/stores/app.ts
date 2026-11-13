/* The window's state, in one typed place.
 *
 * `state` is the object the whole app reads and writes. The fields that other parts of the screen
 * react to (which tab is active, the list of tabs, the agents, the hardware profile, the model catalogs)
 * are held in signals, and `state` exposes them through ordinary properties. So existing code keeps
 * writing `state.activeId = id`, and code that wants to react subscribes to the signal:
 *
 *   effect(() => console.log(activeSession.value?.title));
 *
 * Arrays and maps are replaced or announced, never silently mutated: `state.sessions.push(x)` does not
 * wake subscribers by itself, so use `addSession` / `removeSession` (or call `touchSessions()` after
 * changing a session's own fields that the screen shows). */
import { batch, computed, signal } from '@preact/signals-core';
import type { Agent, AppState, Session } from './types';
import type { SystemProfile } from '../core/ipc';

export type * from './types';

export const agents = signal<Agent[]>([]);
export const sessions = signal<Session[]>([]);
export const activeId = signal<string | null>(null);
export const systemProfile = signal<SystemProfile | null>(null);
export const catalogs = signal<Record<string, string[]>>({});
/** Counts changes inside sessions (status, title, working…) that do not replace the array. */
export const sessionsRevision = signal(0);

export const activeSession = computed<Session | null>(() => {
  sessionsRevision.value;
  const id = activeId.value;
  return sessions.value.find((s) => s.id === id) ?? null;
});
export const runningCount = computed(() => {
  sessionsRevision.value;
  return sessions.value.filter((s) => s.status === 'running').length;
});

const plain: Omit<AppState, 'agents' | 'sessions' | 'activeId' | 'systemProfile' | 'catalogs'> = {
  backends: null,
  homeCwd: '',
  sep: '\\',
  configPath: '',
  openTargets: [],
  activeBySpace: {},
  seq: 0,
  imports: { catalog: null, selected: null },
  git: {},
  explorer: { view: 'list', root: null, expanded: new Set(), cache: new Map(), filter: '', file: null, diff: null }
};

/** Reading `state.catalogs[id]` works as before; assigning `state.catalogs[id] = list` publishes a new map. */
function catalogsView(): Record<string, string[]> {
  return new Proxy({} as Record<string, string[]>, {
    get: (_t, key: string) => catalogs.value[key],
    has: (_t, key: string) => key in catalogs.value,
    ownKeys: () => Reflect.ownKeys(catalogs.value),
    getOwnPropertyDescriptor: (_t, key: string) => (key in catalogs.value ? { enumerable: true, configurable: true, value: catalogs.value[key] } : undefined),
    set: (_t, key: string, value: string[]) => {
      catalogs.value = { ...catalogs.value, [key]: value };
      return true;
    },
    deleteProperty: (_t, key: string) => {
      const next = { ...catalogs.value };
      delete next[key];
      catalogs.value = next;
      return true;
    }
  });
}
const catalogsProxy = catalogsView();

export const state: AppState = Object.defineProperties(plain as AppState, {
  agents: { enumerable: true, get: () => agents.value, set: (v: Agent[]) => void (agents.value = v) },
  sessions: { enumerable: true, get: () => sessions.value, set: (v: Session[]) => void (sessions.value = v) },
  activeId: { enumerable: true, get: () => activeId.value, set: (v: string | null) => void (activeId.value = v) },
  systemProfile: { enumerable: true, get: () => systemProfile.value, set: (v: SystemProfile | null) => void (systemProfile.value = v) },
  catalogs: {
    enumerable: true,
    get: () => catalogsProxy,
    set: (v: Record<string, string[]>) => void (catalogs.value = { ...v })
  }
});

/** Say that something the screen shows about a session changed (status, title, working, unseen). */
export function touchSessions(): void {
  sessionsRevision.value++;
}

export function addSession(s: Session, at?: number): void {
  const list = sessions.value.slice();
  if (at === undefined || at < 0 || at > list.length) list.push(s);
  else list.splice(at, 0, s);
  sessions.value = list;
}

/** Remove a tab. If it was the active one, the caller chooses what becomes active next. */
export function removeSession(id: string): Session | null {
  const found = sessions.value.find((s) => s.id === id) ?? null;
  if (!found) return null;
  batch(() => {
    sessions.value = sessions.value.filter((s) => s.id !== id);
    for (const [spaceId, sid] of Object.entries(state.activeBySpace)) if (sid === id) delete state.activeBySpace[spaceId];
  });
  return found;
}

/** Make a tab the active one (or none). A tab that no longer exists is ignored, so a late callback from a
 *  closed tab cannot leave the window pointing at nothing. Returns the session that is now active. */
export function setActive(id: string | null): Session | null {
  if (id !== null && !sessions.value.some((s) => s.id === id)) return activeSession.peek();
  batch(() => {
    activeId.value = id;
    const s = id === null ? null : sessions.value.find((x) => x.id === id);
    if (s) {
      s.unseen = false;
      state.activeBySpace[s.spaceId] = s.id;
      sessionsRevision.value++;
    }
  });
  return activeSession.peek();
}

/** Replace a session's agent in place (the CLI is relaunched by the caller). Clears what belonged to the
 *  old agent, so nothing from one backend is carried into another by accident. */
export function switchAgent(s: Session, next: { agentId: string; modelId: string; modeId: string; effortId: string }): void {
  batch(() => {
    s.agentId = next.agentId;
    s.modelId = next.modelId;
    s.modeId = next.modeId;
    s.effortId = next.effortId;
    s.imageRefs = [];
    s.command = '';
    s.working = false;
    sessionsRevision.value++;
  });
}

/** Tabs of one space, in order. */
export function sessionsIn(spaceId: string | null): Session[] {
  return sessions.value.filter((s) => s.spaceId === spaceId);
}
