import { $, hooks, invoke, openUrl, prefs, savePrefs, toast } from '../app';
import { registerCommand } from './palette';
import { esc } from '../core/html';
import {
  COMFY_DOWNLOAD,
  COMFY_PORTS,
  imageWorkflow,
  isComfy,
  parseHistory,
  parseList,
  parseQueued,
  queueDepth,
  readiness,
  videoModel,
  videoWorkflow,
  type Installed,
  type Kind,
  type Shape,
} from '../core/comfy';
/* Create: pictures and video, made on this computer by ComfyUI.
 *
 * ezCLI does not install ComfyUI or download models. It finds a ComfyUI that is open, reads which
 * model files it has, queues one job built from ComfyUI's own nodes, waits for the file and copies
 * it to the Pictures or Videos folder. */

const EMPTY: Installed = { checkpoints: [], diffusion: [], encoders: [], vaes: [] };
let port = 0;
let installed: Installed = EMPTY;
let kind: Kind = 'image';
let busy = false;
let stopAsked = false;
const recent: { url: string; mime: string; path: string; prompt: string }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = (path: string) => invoke('comfy_get', { port, path }).catch(() => null) as Promise<string | null>;

async function find(): Promise<boolean> {
  for (const p of [prefs.comfyPort, ...COMFY_PORTS].filter((x, i, a) => x && a.indexOf(x) === i)) {
    port = p;
    if (isComfy(await get('/system_stats'))) {
      if (prefs.comfyPort !== p) {
        prefs.comfyPort = p;
        savePrefs();
      }
      return true;
    }
  }
  port = 0;
  return false;
}

async function readModels(): Promise<Installed> {
  const [checkpoints, diffusion, encoders, vaes] = await Promise.all(['checkpoints', 'diffusion_models', 'text_encoders', 'vae'].map((f) => get(`/models/${f}`).then(parseList)));
  return { checkpoints, diffusion, encoders, vaes };
}

function status(text: string, tone = '') {
  const el = $('createStatus');
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

function render() {
  const r = readiness(port > 0, installed, kind);
  for (const b of (document.querySelectorAll('#createKind [data-kind]') as NodeListOf<HTMLElement>)) {
    const on = b.dataset.kind === kind;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  $('createSetup').hidden = r.ready;
  $('createForm').hidden = !r.ready;
  $('createSetupText').textContent = r.text;
  $('createNeeded').innerHTML = r.needed
    .map((n) => `<li><a href="${esc(n.url)}" data-ext>${esc(n.name)}</a><span>${esc(n.size)}, goes in <code>models/${esc(n.folder)}</code></span></li>`)
    .join('');
  $('createSetupActions').innerHTML =
    (port > 0 ? '' : '<button type="button" class="btn primary" data-create="get">Get ComfyUI</button>') + '<button type="button" class="btn quiet" data-create="check">Check again</button>';
  $('createModelWrap').hidden = kind !== 'image';
  $('createLengthWrap').hidden = kind !== 'video';
  const sel = $('createModel') as HTMLSelectElement;
  const want = prefs.comfyCheckpoint && installed.checkpoints.includes(prefs.comfyCheckpoint) ? prefs.comfyCheckpoint : installed.checkpoints[0] || '';
  sel.innerHTML = installed.checkpoints.map((c) => `<option value="${esc(c)}">${esc(c.replace(/\.(safetensors|ckpt)$/i, ''))}</option>`).join('');
  sel.value = want;
  ($('createGo') as HTMLButtonElement).disabled = busy;
  $('createStop').hidden = !busy;
  $('createRecent').innerHTML = recent
    .slice(1)
    .map((f, i) => `<button type="button" class="create-thumb" data-recent="${i + 1}" title="${esc(f.prompt)}">${f.mime.startsWith('video/') ? `<video src="${f.url}" muted></video>` : `<img src="${f.url}" alt="" />`}</button>`)
    .join('');
}

function show(i: number) {
  const f = recent[i];
  const box = $('createResult');
  if (!f || !box) return;
  box.innerHTML = (f.mime.startsWith('video/') ? `<video src="${f.url}" controls autoplay loop muted></video>` : `<img src="${f.url}" alt="" />`) + `<p class="create-saved">Saved to <code>${esc(f.path)}</code></p>`;
  (box.querySelector('img,video') as HTMLElement).setAttribute('aria-label', f.prompt);
}

async function check() {
  status('Looking for ComfyUI on this computer…');
  installed = (await find()) ? await readModels() : EMPTY;
  status('');
  render();
}

async function make() {
  const prompt = ($('createPrompt') as HTMLTextAreaElement).value.trim();
  if (busy) return;
  if (!prompt) {
    status('Describe what you want first.', 'warn');
    $('createPrompt').focus();
    return;
  }
  const shape = ($('createShape') as HTMLSelectElement).value as Shape;
  const seed = Math.floor(Math.random() * 2 ** 32);
  let job: object;
  if (kind === 'image') {
    const ckpt = ($('createModel') as HTMLSelectElement).value;
    prefs.comfyCheckpoint = ckpt;
    savePrefs();
    job = imageWorkflow({ ckpt, prompt, shape, seed });
  } else {
    const { model } = videoModel(installed);
    if (!model) return render();
    job = videoWorkflow({ model, prompt, shape, seconds: Number(($('createLength') as HTMLSelectElement).value) || 3, seed });
  }
  busy = true;
  stopAsked = false;
  render();
  status('Sending to ComfyUI…');
  try {
    const queued = parseQueued((await invoke('comfy_queue', { port, workflow: JSON.stringify(job) })) as string);
    if ('error' in queued) throw new Error(queued.error);
    const started = Date.now();
    // A picture takes seconds to minutes and a clip can take many minutes on a 12 GB card; the first run also loads the model.
    const limit = (kind === 'video' ? 60 : 15) * 60 * 1000;
    for (;;) {
      await sleep(1500);
      const state = parseHistory(await get(`/history/${queued.id}`), queued.id);
      if (state.state === 'failed') throw new Error(stopAsked ? 'Stopped.' : state.why);
      if (state.state === 'done') {
        status('Copying the file…');
        const f = state.files[0];
        const file = (await invoke('comfy_fetch', { port, filename: f.filename, subfolder: f.subfolder })) as { path: string; mime: string; dataUrl: string };
        recent.unshift({ url: file.dataUrl, mime: file.mime, path: file.path, prompt });
        recent.length = Math.min(recent.length, 9);
        status('');
        show(0);
        break;
      }
      if (Date.now() - started > limit) throw new Error('ComfyUI is still working after a long time. Look at its own window to see what it is doing.');
      const secs = Math.round((Date.now() - started) / 1000);
      const ahead = queueDepth(await get('/queue')) - 1;
      status(`${kind === 'video' ? 'Making the video' : 'Making the picture'}… ${secs}s${ahead > 0 ? `, ${ahead} job${ahead > 1 ? 's' : ''} ahead in ComfyUI` : ''}`);
    }
  } catch (e) {
    const msg = String((e && (e as Error).message) || e);
    status(/did not answer/.test(msg) ? 'ComfyUI stopped answering. Is it still open?' : msg, msg === 'Stopped.' ? '' : 'err');
    if (/did not answer/.test(msg)) await check();
  } finally {
    busy = false;
    render();
  }
}

function open() {
  const sheet = $('createSheet') as HTMLDialogElement;
  if (!sheet) return;
  if (!sheet.open) sheet.showModal();
  render();
  void check();
}

hooks.boot.push(() => {
  const anchor = $('browserBtn');
  if (anchor && !$('createBtn')) {
    const b = document.createElement('button');
    b.className = 'rail-btn';
    b.id = 'createBtn';
    b.title = 'Create: pictures and video, made on this computer';
    b.setAttribute('aria-label', 'Create pictures and video');
    b.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l4.5-4.5 3.5 3.5 3-3 5 5"/></svg><span class="rail-label">Create</span>';
    anchor.before(b);
    b.addEventListener('click', open);
  }
  $('createKind')?.addEventListener('click', (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>('[data-kind]')?.dataset.kind as Kind | undefined;
    if (!k || busy) return;
    kind = k;
    status('');
    render();
  });
  $('createSetup')?.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const link = t.closest<HTMLAnchorElement>('a[data-ext]');
    if (link) {
      e.preventDefault();
      openUrl(link.href);
      return;
    }
    const act = t.closest<HTMLElement>('[data-create]')?.dataset.create;
    if (act === 'get') openUrl(COMFY_DOWNLOAD);
    if (act === 'check') void check();
  });
  $('createGo')?.addEventListener('click', () => void make());
  $('createPrompt')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter' && ((e as KeyboardEvent).ctrlKey || (e as KeyboardEvent).metaKey)) void make();
  });
  $('createStop')?.addEventListener('click', () => {
    stopAsked = true;
    invoke('comfy_interrupt', { port }).catch(() => toast('Could not reach ComfyUI to stop it.', 'error'));
  });
  $('createRecent')?.addEventListener('click', (e) => {
    const i = Number((e.target as HTMLElement).closest<HTMLElement>('[data-recent]')?.dataset.recent);
    if (i) show(i);
  });
});

registerCommand({ group: 'App', label: 'Create a picture or video', run: open });
