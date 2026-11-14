import { $, hooks, invoke, listen, openUrl, prefs, savePrefs, state, toast } from '../app';
import { registerCommand } from './palette';
import { late } from '../late';
import { esc } from '../core/html';
import { COMFY_DOWNLOAD, bytesText, chatReply, totalGib, view, type Kind } from '../core/comfy';
import type { MediaFile, MediaJob, StudioInfo } from '../core/ipc.gen';
/* Create: pictures and video, made on this computer.
 *
 * On Windows ezCLI sets the engine (ComfyUI) up itself: one download, started in the background when
 * it is needed, stopped when ezCLI quits. Model files are downloaded from the panel. The same engine
 * serves this panel, the create_image / create_video tools every agent is given, and the IMAGE: and
 * VIDEO: requests of local-model chats. */

const NONE: StudioInfo = { status: { supported: false, installed: false, running: false, port: 0, managed: false, models: [], folder: '' }, checkpoints: [], videoReady: false };
let info: StudioInfo = NONE;
let known = false;
let kind: Kind = 'image';
let job = '';
let starting = false;
/** downloads in progress, by key: what to show */
const downloads = new Map<string, string>();
const recent: { url: string; mime: string; path: string; prompt: string }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sheet = () => $('createSheet') as HTMLDialogElement | null;

function status(text: string, tone = '') {
  const el = $('createStatus');
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

async function refresh() {
  try {
    info = ((await invoke('studio_info', {})) as StudioInfo | null) || NONE;
  } catch {
    info = NONE;
  }
  known = true;
  render();
}

function render() {
  if (!sheet()) return;
  const v = view(info, kind);
  for (const b of document.querySelectorAll('#createKind [data-kind]') as NodeListOf<HTMLElement>) {
    const on = b.dataset.kind === kind;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  const busy = Boolean(job);
  $('createSetup').hidden = v.stage === 'ready';
  $('createForm').hidden = v.stage !== 'ready';
  $('createSetupText').textContent = known ? v.text : 'Looking for the picture and video engine…';
  $('createNeeded').innerHTML = v.needed
    .map((m) => `<li><b>${esc(m.label)}</b><span>${downloads.has(`studio-model:${m.id}`) ? esc(downloads.get(`studio-model:${m.id}`)) : `${m.gib} GB`}${v.canDownload ? '' : `, file <code>${esc(m.name)}</code>`}</span></li>`)
    .join('');
  const acts: string[] = [];
  const loading = downloads.size > 0;
  if (!known) {
    /* nothing to press yet */
  } else if (v.stage === 'setup') {
    acts.push(downloads.has('studio') ? `<span class="create-progress">${esc(downloads.get('studio'))}</span><button type="button" class="btn quiet" data-create="cancel">Cancel</button>` : '<button type="button" class="btn primary" data-create="setup">Set up</button>');
  } else if (v.stage === 'bring') {
    acts.push('<button type="button" class="btn primary" data-create="get">Get ComfyUI</button><button type="button" class="btn quiet" data-create="check">Check again</button>');
  } else if (v.stage === 'models') {
    if (v.canDownload) acts.push(loading ? '<button type="button" class="btn quiet" data-create="cancel">Cancel</button>' : `<button type="button" class="btn primary" data-create="models">Download (${totalGib(v.needed)})</button>`);
    else acts.push('<button type="button" class="btn quiet" data-create="check">Check again</button>');
  }
  $('createSetupActions').innerHTML = acts.join('');
  $('createModelWrap').hidden = kind !== 'image' || info.checkpoints.length < 2;
  $('createLengthWrap').hidden = kind !== 'video';
  const sel = $('createModel') as HTMLSelectElement;
  sel.innerHTML = info.checkpoints.map((c) => `<option value="${esc(c)}">${esc(c.replace(/\.(safetensors|ckpt)$/i, ''))}</option>`).join('');
  sel.value = prefs.comfyCheckpoint && info.checkpoints.includes(prefs.comfyCheckpoint) ? prefs.comfyCheckpoint : info.checkpoints[0] || '';
  ($('createGo') as HTMLButtonElement).disabled = busy;
  $('createStop').hidden = !busy;
  $('createRecent').innerHTML = recent
    .slice(1)
    .map((f, i) => `<button type="button" class="create-thumb" data-recent="${i + 1}" title="${esc(f.prompt)}">${f.mime.startsWith('video/') ? `<video src="${f.url}" muted></video>` : `<img src="${f.url}" alt="" />`}</button>`)
    .join('');
  if (v.stage === 'start' && !starting) void start();
}

async function start() {
  starting = true;
  try {
    await invoke('studio_start', {});
    status('');
  } catch (e) {
    status(String(e), 'err');
  }
  await refresh();
  // leave the flag set after a failure, so a broken engine is not restarted in a loop; "Check again" clears it
  if (info.status.running) starting = false;
}

function show(i: number) {
  const f = recent[i];
  const box = $('createResult');
  if (!f || !box) return;
  box.innerHTML = (f.mime.startsWith('video/') ? `<video src="${f.url}" controls autoplay loop muted></video>` : `<img src="${f.url}" alt="" />`) + `<p class="create-saved">Saved to <code>${esc(f.path)}</code></p>`;
  (box.querySelector('img,video') as HTMLElement).setAttribute('aria-label', f.prompt);
}

/** Put a finished file at the front of the panel's list. */
async function keep(path: string, prompt: string) {
  if (recent.some((r) => r.path === path)) return;
  try {
    const f = (await invoke('media_read', { path })) as MediaFile;
    recent.unshift({ url: f.dataUrl, mime: f.mime, path: f.path, prompt });
    recent.length = Math.min(recent.length, 9);
    show(0);
    render();
  } catch {
    /* the file is still on disk; the panel just cannot show it */
  }
}

/** Show a finished picture or clip in a session's chat, after the reply to the message that asked for it. */
async function attach(s, path: string, prompt: string, after?: number) {
  if (!s || !path || (s.media || []).some((m) => m.path === path)) return false;
  try {
    const f = (await invoke('media_read', { path })) as MediaFile;
    // a blob: address keeps the chat's HTML small however large the file is
    const url = URL.createObjectURL(await (await fetch(f.dataUrl)).blob());
    const users = typeof after === 'number' ? after : late.ChatView ? late.ChatView.userCount(s) : 0;
    s.media = [...(s.media || []), { key: String(Date.now()), path: f.path, mime: f.mime, prompt, url, after: users }];
    if (late.ChatView) late.ChatView.apply(true);
    return true;
  } catch {
    return false;
  }
}

/** Ask for one picture or clip and wait for it. `tick` hears how long it has been. */
async function run(k: Kind, prompt: string, opts: { shape?: string; seconds?: number; checkpoint?: string }, tick?: (secs: number) => void): Promise<MediaJob> {
  const id = (await invoke('media_make', { kind: k, prompt, shape: opts.shape || 'wide', seconds: opts.seconds || 3, checkpoint: opts.checkpoint || '' })) as string;
  if (tick) job = id;
  for (;;) {
    await sleep(1200);
    const st = (await invoke('media_job', { id })) as MediaJob;
    if (st.state !== 'working') return st;
    if (tick) tick(st.seconds);
  }
}

async function make() {
  const prompt = ($('createPrompt') as HTMLTextAreaElement).value.trim();
  if (job) return;
  if (!prompt) {
    status('Describe what you want first.', 'warn');
    $('createPrompt').focus();
    return;
  }
  const checkpoint = ($('createModel') as HTMLSelectElement).value;
  if (kind === 'image' && checkpoint) {
    prefs.comfyCheckpoint = checkpoint;
    savePrefs();
  }
  const what = kind === 'video' ? 'Making the video' : 'Making the picture';
  status(`${what}…`);
  job = 'pending';
  render();
  try {
    const done = await run(kind, prompt, { shape: ($('createShape') as HTMLSelectElement).value, seconds: Number(($('createLength') as HTMLSelectElement).value) || 3, checkpoint }, (secs) => status(`${what}… ${secs}s`));
    if (done.state === 'done') {
      status('');
      await keep(done.path, prompt);
    } else {
      status(done.why || 'It could not be made.', done.why === 'Stopped.' ? '' : 'err');
    }
  } catch (e) {
    status(String(e), 'err');
  } finally {
    job = '';
    render();
  }
}

function onDownload(p: { key: string; state: string; bytes: number; error: string; note: string }) {
  if (!p || typeof p.key !== 'string' || !p.key.startsWith('studio')) return;
  if (p.state === 'downloading' || p.state === 'verifying') {
    downloads.set(p.key, p.note || (p.bytes ? `${bytesText(p.bytes)} downloaded` : 'Starting…'));
    render();
    return;
  }
  downloads.delete(p.key);
  if (p.state === 'error') status(p.error, 'err');
  if (p.state === 'done') status('');
  starting = false;
  void refresh();
}

function open() {
  const s = sheet();
  if (!s) return;
  if (!s.open) s.showModal();
  render();
  void refresh();
}

export const Create = {
  open,
  /** Whether a chat can be told it may ask for pictures: the engine is installed or one is open. */
  usable: () => info.status.installed || info.status.running,
  /** A local model asked for a picture or a clip. Pictures are waited for; a clip is left to finish on its own. */
  async forChat(k: Kind, prompt: string, s?): Promise<{ ok: boolean; text: string }> {
    const after = s && late.ChatView ? late.ChatView.userCount(s) : undefined;
    try {
      if (k === 'video') {
        // a clip takes minutes: let it finish on its own and show it in the chat when it does
        void run('video', prompt, { shape: 'wide', seconds: 3 })
          .then((done) => {
            if (done.state === 'done') void attach(s, done.path, prompt, after);
            else if (done.why) toast(`The video could not be made: ${done.why}`, 'error');
          })
          .catch(() => {});
        return chatReply('video', { state: 'working' });
      }
      const done = await run('image', prompt, { checkpoint: prefs.comfyCheckpoint || '' });
      if (done.state === 'done') await attach(s, done.path, prompt, after);
      return chatReply('image', done);
    } catch (e) {
      return chatReply(k, { state: 'failed', why: String(e) });
    }
  },
};

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
  try {
    listen('model-download', (e) => onDownload(e.payload as Parameters<typeof onDownload>[0]));
    // a picture or clip finished, whoever asked for it: the panel, an agent's tool call, or a local-model chat
    listen('media-made', (e) => {
      const p = e.payload as { path: string; prompt: string; mime: string; pty?: string };
      if (!p || !p.path) return;
      void keep(p.path, p.prompt || '');
      // an agent asked for it: show it in that agent's chat
      const owner = p.pty ? state.sessions.find((x) => x.ptyId === p.pty) : null;
      if (owner) {
        void attach(owner, p.path, p.prompt || '');
        if (owner.id === state.activeId) return;
      }
      if (!sheet()?.open) toast(p.mime.startsWith('video/') ? 'A video is ready. Click to see it.' : 'A picture is ready. Click to see it.', '', open, 'Show');
    });
  } catch {
    /* no event bridge: the panel still works, it just hears about downloads and agent-made files late */
  }
  $('createKind')?.addEventListener('click', (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>('[data-kind]')?.dataset.kind as Kind | undefined;
    if (!k || job) return;
    kind = k;
    status('');
    render();
  });
  $('createSetup')?.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-create]')?.dataset.create;
    if (!act) return;
    try {
      if (act === 'get') openUrl(COMFY_DOWNLOAD);
      if (act === 'check') {
        starting = false;
        status('');
        await refresh();
      }
      if (act === 'setup') {
        downloads.set('studio', 'Starting…');
        render();
        await invoke('studio_install', {});
      }
      if (act === 'models') {
        for (const m of view(info, kind).needed) {
          downloads.set(`studio-model:${m.id}`, 'Starting…');
          await invoke('studio_model', { id: m.id });
        }
        render();
      }
      if (act === 'cancel') for (const key of downloads.keys()) await invoke('hub_cancel', { key });
    } catch (err) {
      downloads.clear();
      status(String(err), 'err');
      render();
    }
  });
  // "Show in folder" under a picture or clip in a chat
  document.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.cm-media-open');
    if (!b || !b.dataset.path) return;
    const dir = b.dataset.path.replace(/[\\/][^\\/]*$/, '');
    invoke('open_in', { target: 'files', path: dir }).catch((err) => toast(String(err), 'error'));
  });
  $('createGo')?.addEventListener('click', () => void make());
  $('createPrompt')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter' && ((e as KeyboardEvent).ctrlKey || (e as KeyboardEvent).metaKey)) void make();
  });
  $('createStop')?.addEventListener('click', () => {
    if (job && job !== 'pending') invoke('media_cancel', { id: job }).catch(() => {});
  });
  $('createRecent')?.addEventListener('click', (e) => {
    const i = Number((e.target as HTMLElement).closest<HTMLElement>('[data-recent]')?.dataset.recent);
    if (i) show(i);
  });
  // find out quietly whether pictures are set up, so local-model chats can be told about IMAGE: and VIDEO:
  setTimeout(() => void refresh(), 4000);
});

registerCommand({ group: 'App', label: 'Create a picture or video', run: open });

Object.assign(late, { Create });
