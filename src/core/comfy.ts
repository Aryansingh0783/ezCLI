/* What the Create panel shows, worked out from what the backend reports.
 *
 * Pictures and video are made by ComfyUI (github.com/comfyanonymous/ComfyUI), the most used
 * open-source generator: it runs on this computer and needs no account and no key. On Windows
 * ezCLI downloads and runs its own copy; elsewhere it uses one the user has open. The jobs
 * themselves are built in `src-tauri/src/comfy.rs`. */
import type { ModelState, StudioInfo } from './ipc.gen';

export const COMFY_DOWNLOAD = 'https://www.comfy.org/download';

export type Kind = 'image' | 'video';

export type Stage =
  /** ezCLI can install it and has not yet */
  | 'setup'
  /** ezCLI cannot install it on this system and none is open */
  | 'bring'
  /** installed, not answering yet */
  | 'start'
  /** answering, but no model for this kind */
  | 'models'
  | 'ready';

export interface View {
  stage: Stage;
  text: string;
  /** model files still to get for this kind */
  needed: ModelState[];
  /** ezCLI can download them itself (they go into its own ComfyUI) */
  canDownload: boolean;
}

export function view(info: StudioInfo, kind: Kind): View {
  const st = info.status;
  const none = { needed: [], canDownload: false };
  if (!st.running) {
    if (st.installed) return { stage: 'start', text: 'Starting the picture and video engine…', ...none };
    if (st.supported) {
      return { stage: 'setup', text: 'Pictures and video are made on this computer. ezCLI downloads the engine (ComfyUI, a few GB) once into its own folder and runs it for you in the background. No account, no key.', ...none };
    }
    return { stage: 'bring', text: 'On this system ezCLI cannot install the engine itself yet. Install ComfyUI, open it, and come back: it is free and needs no account or key.', ...none };
  }
  const ready = kind === 'image' ? info.checkpoints.length > 0 : info.videoReady;
  if (ready) return { stage: 'ready', text: '', ...none };
  const needed = st.models.filter((m) => m.kind === kind && !m.present);
  const canDownload = st.installed && st.managed;
  const what = kind === 'image' ? 'an image model' : 'the video model (three files)';
  const text = canDownload ? `One more download: ${what}.` : `The ComfyUI that is open has no ${kind === 'image' ? 'image model' : 'Wan 2.2 video model'}. Add these files to its models folder:`;
  return { stage: 'models', text, needed, canDownload };
}

export function totalGib(models: ModelState[]): string {
  return `${models.reduce((n, m) => n + m.gib, 0).toFixed(1)} GB`;
}

/** "3.2 GB" or "410 MB", for a download in progress. */
export function bytesText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** What a local model is told after it asked for a picture or a clip. */
export function chatReply(kind: Kind, result: { state: string; path?: string; why?: string }): { ok: boolean; text: string } {
  if (result.state === 'done') {
    return { ok: true, text: `The picture was made and saved to ${result.path}. The user can already see it in the Create panel. Tell them it is ready and where it was saved, in one or two sentences. Do not describe what it looks like: you have not seen it.` };
  }
  if (result.state === 'working') {
    return { ok: true, text: `The ${kind} is being made now. It takes several minutes and will appear in the Create panel when it is done. Tell the user that, in one sentence.` };
  }
  return { ok: false, text: `The ${kind} could not be made: ${result.why || 'no reason was given'} Tell the user that plainly.` };
}
