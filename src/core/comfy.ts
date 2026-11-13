/* Pictures and video from ComfyUI (github.com/comfyanonymous/ComfyUI), the most used open-source
 * generator: it runs on this computer, needs no account and no key, and has an HTTP API.
 *
 * Everything here is plain data in, plain data out, so it can be tested without ComfyUI:
 * which installed model files can be used, the job to queue for a request, and how to read
 * ComfyUI's replies. The jobs use only nodes that ship with ComfyUI itself. */

export const COMFY_HOME = 'https://github.com/comfyanonymous/ComfyUI';
export const COMFY_DOWNLOAD = 'https://www.comfy.org/download';
/** ComfyUI's own default, then ComfyUI Desktop's. */
export const COMFY_PORTS = [8188, 8000];

export type Kind = 'image' | 'video';
export type Shape = 'square' | 'wide' | 'tall';

export interface Installed {
  checkpoints: string[];
  diffusion: string[];
  encoders: string[];
  vaes: string[];
}

export interface Needed {
  /** file name to look for */
  name: string;
  /** folder inside ComfyUI's `models` folder */
  folder: string;
  size: string;
  url: string;
}

/** Was that reply from ComfyUI, and not some other program on the port? */
export function isComfy(body: string | null | undefined): boolean {
  return !!body && body.includes('comfyui_version');
}

export function parseList(body: string | null | undefined): string[] {
  try {
    const v = JSON.parse(body || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------- pictures */

export interface ImageSettings {
  base: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  /** some models are trained without a negative prompt */
  negative: boolean;
}

/** Settings that suit a checkpoint, read from its file name. Unknown names get Stable Diffusion 1.5's. */
export function imageSettings(ckpt: string): ImageSettings {
  const n = ckpt.toLowerCase();
  if (/flux/.test(n)) return { base: 1024, steps: /schnell/.test(n) ? 4 : 20, cfg: 1, sampler: 'euler', scheduler: 'simple', negative: false };
  const big = /xl|pony|illustrious|noobai|sd3|playground/.test(n);
  if (/turbo|lightning|hyper|lcm|dmd/.test(n)) return { base: big ? 1024 : 512, steps: 6, cfg: 1.5, sampler: 'euler_ancestral', scheduler: 'sgm_uniform', negative: false };
  if (big) return { base: 1024, steps: 26, cfg: 6.5, sampler: 'dpmpp_2m', scheduler: 'karras', negative: true };
  return { base: 512, steps: 25, cfg: 7, sampler: 'dpmpp_2m', scheduler: 'karras', negative: true };
}

/** Width and height for a shape, in the multiples of 64 these models expect. */
export function imageSize(base: number, shape: Shape): [number, number] {
  if (shape === 'square') return [base, base];
  const long = Math.round((base * 1.25) / 64) * 64;
  const short = Math.round((base * 0.75) / 64) * 64;
  return shape === 'wide' ? [long, short] : [short, long];
}

export const STARTER_CHECKPOINT: Needed = {
  name: 'sd_xl_base_1.0.safetensors',
  folder: 'checkpoints',
  size: '6.9 GB',
  url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
};

const NEGATIVE = 'blurry, low quality, distorted, watermark, text';

export function imageWorkflow(o: { ckpt: string; prompt: string; shape: Shape; seed: number }) {
  const s = imageSettings(o.ckpt);
  const [width, height] = imageSize(s.base, o.shape);
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: o.ckpt } },
    '2': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: o.prompt } },
    '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: s.negative ? NEGATIVE : '' } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: o.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, denoise: 1 },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'ezCLI' } },
  };
}

/* ------------------------------------------------------------------- video
 * Wan 2.2 (text to video, the 5B model): the open video model that fits a 12 GB card. */

export const VIDEO_FILES: (Needed & { match: RegExp; from: keyof Installed })[] = [
  {
    name: 'wan2.2_ti2v_5B_fp16.safetensors',
    folder: 'diffusion_models',
    size: '10 GB',
    url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/tree/main/split_files/diffusion_models',
    match: /wan.?2\.2.*ti2v.*5b/i,
    from: 'diffusion',
  },
  {
    name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    folder: 'text_encoders',
    size: '6.7 GB',
    url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    match: /umt5.?xxl/i,
    from: 'encoders',
  },
  {
    name: 'wan2.2_vae.safetensors',
    folder: 'vae',
    size: '1.4 GB',
    url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/tree/main/split_files/vae',
    match: /wan.?2\.2.*vae/i,
    from: 'vaes',
  },
];

export interface VideoModel {
  unet: string;
  clip: string;
  vae: string;
}

/** The video model's three files if all are installed, otherwise the ones still needed. */
export function videoModel(inst: Installed): { model: VideoModel | null; missing: Needed[] } {
  const found = VIDEO_FILES.map((f) => inst[f.from].find((n) => f.match.test(n)) || '');
  const missing = VIDEO_FILES.filter((_, i) => !found[i]).map(({ name, folder, size, url }) => ({ name, folder, size, url }));
  const [unet = '', clip = '', vae = ''] = found;
  return { model: missing.length ? null : { unet, clip, vae }, missing };
}

export const VIDEO_FPS = 24;
/** Frame counts Wan accepts are 4n+1. */
export function videoFrames(seconds: number): number {
  const n = Math.max(1, Math.round((seconds * VIDEO_FPS) / 4));
  return n * 4 + 1;
}

export function videoSize(shape: Shape): [number, number] {
  return shape === 'wide' ? [1280, 704] : shape === 'tall' ? [704, 1280] : [960, 960];
}

export function videoWorkflow(o: { model: VideoModel; prompt: string; shape: Shape; seconds: number; seed: number }) {
  const [width, height] = videoSize(o.shape);
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: o.model.unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: o.model.clip, type: 'wan' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: o.model.vae } },
    '4': { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 8 } },
    '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: o.prompt } },
    '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: 'blurry, low quality, static, distorted, watermark, subtitles' } },
    '7': { class_type: 'Wan22ImageToVideoLatent', inputs: { vae: ['3', 0], width, height, length: videoFrames(o.seconds), batch_size: 1 } },
    '8': {
      class_type: 'KSampler',
      inputs: { model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0], seed: o.seed, steps: 20, cfg: 5, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1 },
    },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': { class_type: 'SaveWEBM', inputs: { images: ['9', 0], filename_prefix: 'ezCLI', codec: 'vp9', fps: VIDEO_FPS, crf: 24 } },
  };
}

/* ----------------------------------------------------------------- replies */

/** ComfyUI's reply to a queued job: its id, or why it was refused, in words. */
export function parseQueued(body: string): { id: string } | { error: string } {
  let v: any;
  try {
    v = JSON.parse(body);
  } catch {
    return { error: 'ComfyUI sent a reply ezCLI could not read.' };
  }
  if (v && typeof v.prompt_id === 'string' && !v.error) return { id: v.prompt_id };
  const reasons: string[] = [];
  for (const node of Object.values((v && v.node_errors) || {}) as any[]) {
    for (const e of (node && node.errors) || []) {
      const detail = [e.message, e.details].filter(Boolean).join(': ');
      if (detail) reasons.push(`${node.class_type || 'A step'}: ${detail}`);
    }
  }
  if (reasons.some((r) => /not found|missing_node_type/i.test(r)) || /missing_node_type/.test(v?.error?.type || '')) {
    return { error: 'This ComfyUI is too old for this job. Update ComfyUI and try again.' };
  }
  const head = (v && v.error && (v.error.message || v.error.type)) || 'ComfyUI refused the job';
  return { error: reasons.length ? `${head}. ${reasons.slice(0, 3).join(' ')}` : `${head}.` };
}

export interface OutFile {
  filename: string;
  subfolder: string;
}

export type JobState = { state: 'waiting' } | { state: 'done'; files: OutFile[] } | { state: 'failed'; why: string };

/** ComfyUI's history entry for a job. Nothing there yet means it is still queued or running. */
export function parseHistory(body: string | null | undefined, id: string): JobState {
  let v: any;
  try {
    v = JSON.parse(body || '{}');
  } catch {
    return { state: 'waiting' };
  }
  const job = v && v[id];
  if (!job) return { state: 'waiting' };
  const files: OutFile[] = [];
  for (const out of Object.values(job.outputs || {}) as any[]) {
    for (const f of (out && out.images) || []) {
      if (f && typeof f.filename === 'string' && (f.type || 'output') === 'output') files.push({ filename: f.filename, subfolder: f.subfolder || '' });
    }
  }
  if (files.length) return { state: 'done', files };
  const status = job.status || {};
  if (status.status_str === 'error' || status.completed) {
    let why = '';
    for (const m of status.messages || []) {
      if (Array.isArray(m) && m[0] === 'execution_error' && m[1]) why = String(m[1].exception_message || '').trim();
    }
    if (/out of memory|allocation/i.test(why)) why = 'The graphics card ran out of memory. Close other programs that use it, or pick a smaller shape or a shorter clip.';
    return { state: 'failed', why: why || 'ComfyUI stopped without making a file.' };
  }
  return { state: 'waiting' };
}

/** How many jobs are ahead of or including ours, from `/queue`. */
export function queueDepth(body: string | null | undefined): number {
  try {
    const v = JSON.parse(body || '{}');
    return (v.queue_running || []).length + (v.queue_pending || []).length;
  } catch {
    return 0;
  }
}

/** What the panel shows before anything can be made. */
export function readiness(running: boolean, inst: Installed, kind: Kind): { ready: boolean; text: string; needed: Needed[] } {
  if (!running) {
    return { ready: false, text: 'ComfyUI is not running on this computer. Install it once, open it, and come back: it is free and needs no account or key.', needed: [] };
  }
  if (kind === 'image') {
    if (inst.checkpoints.length) return { ready: true, text: '', needed: [] };
    return { ready: false, text: 'ComfyUI is running but has no image model yet. Put one in its models folder; this one is a good start:', needed: [STARTER_CHECKPOINT] };
  }
  const { model, missing } = videoModel(inst);
  if (model) return { ready: true, text: '', needed: [] };
  return { ready: false, text: 'Video uses the Wan 2.2 model. ComfyUI still needs these files in its models folder:', needed: missing };
}
