/* What to do when a local model's runner dies instead of exiting.
 *
 * llama.cpp crashing while it loads a model shows up as an exit code, never as text: 0xC0000005 on
 * Windows (an access violation), 139 or 134 elsewhere (segfault, abort). Most such crashes come from
 * the GPU path (driver, VRAM, an offloaded layer type the build mishandles), so the first one in a
 * GPU mode is answered by starting the same model again on the CPU, once. A crash on the CPU has
 * nothing left to fall back to and gets advice instead. */

/** 0xC0000005 as Windows reports it (unsigned and signed), SIGSEGV, SIGABRT. */
export const CRASH_CODES: readonly number[] = [3221225477, -1073741819, 139, 134];

export interface CrashContext {
  agentId: string;
  /** The mode the crashed process ran in. */
  modeId: string | null | undefined;
  exitCode: unknown;
  /** Mode ids this agent offers. */
  modes: readonly string[];
  /** True once this session has already been moved to the CPU after a crash. */
  alreadyFailedOver: boolean;
}

export type CrashPlan =
  | { kind: 'none' }
  | { kind: 'failover'; toMode: 'cpu'; notice: string }
  | { kind: 'advise'; notice: string };

export function isCrash(exitCode: unknown): boolean {
  return CRASH_CODES.includes(Number(exitCode));
}

export function hex(exitCode: unknown): string {
  const n = Number(exitCode);
  return n < 0 || n > 255 ? '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0') : String(n);
}

export function crashPlan(c: CrashContext): CrashPlan {
  if (c.agentId !== 'gguf' || !isCrash(c.exitCode)) return { kind: 'none' };
  const code = hex(c.exitCode);
  if (c.modeId !== 'cpu' && c.modes.includes('cpu') && !c.alreadyFailedOver) {
    return {
      kind: 'failover',
      toMode: 'cpu',
      notice:
        `llama.cpp crashed (${code}) while running this model on the GPU. The crash is inside llama.cpp, not ezCLI.\n` +
        'Starting the same model again on the CPU (-ngl 0). It will be slower. ' +
        'To go back, choose "GPU (all layers)" under the message box.'
    };
  }
  if (c.modeId === 'cpu') {
    return {
      kind: 'advise',
      notice:
        `llama.cpp crashed (${code}) on the CPU as well, so this is not a GPU problem. Try, in this order:\n` +
        '  1. Models > llama.cpp > "Check for update" or "Update": this model\'s architecture may need a newer build.\n' +
        '  2. A different model file, for example one from "Recommended for this PC".'
    };
  }
  return {
    kind: 'advise',
    notice:
      `llama.cpp crashed (${code}) while running this model. The crash is inside llama.cpp, not ezCLI. Try, in this order:\n` +
      '  1. Change "GPU (all layers)" to CPU (the button under the message box) and start a new chat.\n' +
      '  2. Models > llama.cpp > "CPU-only build" (a GPU driver problem crashes the GPU build).\n' +
      '  3. Update llama.cpp (Models > llama.cpp) or try a different model file.'
  };
}
