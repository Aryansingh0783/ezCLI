/* The bridge to the Rust side. Every call names a command from `Commands` (generated from the Rust
 * sources), so a misspelt command, a missing argument or a wrong assumption about the reply is a compile
 * error instead of a rejected promise at run time. */
import type { Commands as AppCommands } from './ipc.gen';

export type * from './ipc.gen';

/** Options for the system file dialogs (tauri-plugin-dialog). Only the fields this app passes. */
export interface DialogOptions {
  title?: string;
  defaultPath?: string;
  directory?: boolean;
  multiple?: boolean;
  filters?: { name: string; extensions: string[] }[];
}

/** Commands that belong to Tauri plugins, not to src-tauri/src, so the generator does not see them. */
interface PluginCommands {
  'plugin:dialog|open': { args: { options: DialogOptions }; result: string | string[] | null };
  'plugin:dialog|save': { args: { options: DialogOptions }; result: string | null };
  'plugin:opener|open_url': { args: { url: string }; result: void };
}

export type Commands = AppCommands & PluginCommands;
export type CommandName = keyof Commands;
export type Args<K extends CommandName> = Commands[K]['args'];
export type Result<K extends CommandName> = Commands[K]['result'];

/** Commands whose arguments are all optional (or absent) may be called with no second argument. */
type ArgsTuple<K extends CommandName> = Record<string, never> extends Args<K> ? [args?: Args<K>] : Partial<Args<K>> extends Args<K> ? [args?: Args<K>] : [args: Args<K>];

/** Events the Rust side emits. Those with a session id in the name are listed by their prefix. */
export interface Events {
  [event: `pty-data:${string}`]: string;
  [event: `pty-exit:${string}`]: number;
  [event: string]: unknown;
}

function tauri(): Window['__TAURI__'] {
  const t = window.__TAURI__;
  if (!t) throw new Error('The Tauri bridge is not available in this window.');
  return t;
}

export function invoke<K extends CommandName>(name: K, ...rest: ArgsTuple<K>): Promise<Result<K>> {
  return tauri().core.invoke<Result<K>>(name, rest[0] as Record<string, unknown> | undefined);
}

export function listen<E extends keyof Events & string>(event: E, handler: (event: { payload: Events[E] }) => void): Promise<() => void> {
  return tauri().event.listen<Events[E]>(event, handler);
}
