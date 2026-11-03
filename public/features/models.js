'use strict';
/* Local models, the way LM Studio shows them: what is downloaded and whether it fits this PC, what is
 * loaded in memory, load settings (context length, GPU offload), and the local OpenAI-compatible server.
 * Everything goes through LM Studio's own `lms` command; ezCLI never downloads a model by itself. */

/** Well-known GGUF models, each checked to exist on Hugging Face with ordinary files. Which one is offered, and in
 *  which size, is decided by the user's own hardware (see `Models.plan`). */
const CURATED = [
  { repo: 'Qwen/Qwen3-4B-GGUF', title: 'Qwen3 4B', kind: 'General', note: 'Small and quick' },
  { repo: 'Qwen/Qwen3-8B-GGUF', title: 'Qwen3 8B', kind: 'General', note: 'Strong all-rounder' },
  { repo: 'Qwen/Qwen3-14B-GGUF', title: 'Qwen3 14B', kind: 'General', note: 'Better reasoning' },
  { repo: 'Qwen/Qwen3-30B-A3B-GGUF', title: 'Qwen3 30B-A3B', kind: 'General', note: 'Large, fast for its size' },
  { repo: 'unsloth/gpt-oss-20b-GGUF', title: 'gpt-oss 20B', kind: 'General', note: 'OpenAI open-weight model' },
  { repo: 'unsloth/gemma-3-4b-it-GGUF', title: 'Gemma 3 4B', kind: 'General', note: 'Google, small' },
  { repo: 'unsloth/gemma-3-12b-it-GGUF', title: 'Gemma 3 12B', kind: 'General', note: 'Google, mid-size' },
  { repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF', title: 'Llama 3.2 3B', kind: 'General', note: 'Tiny, runs almost anywhere' },
  { repo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', title: 'Llama 3.1 8B', kind: 'General', note: 'Meta, popular' },
  { repo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF', title: 'Mistral 7B', kind: 'General', note: 'Fast and light' },
  { repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', title: 'Qwen2.5 Coder 7B', kind: 'Coding', note: 'Code-tuned' },
  { repo: 'Qwen/Qwen2.5-Coder-14B-Instruct-GGUF', title: 'Qwen2.5 Coder 14B', kind: 'Coding', note: 'Code-tuned, larger' },
  { repo: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', title: 'Qwen3 Coder 30B-A3B', kind: 'Coding', note: 'Best local coding model here' }
];

const Models = {
  dlg: null,
  data: { list: [], loaded: [], server: '', error: '' },
  pc: { found: [], scanning: false, deep: false, error: '', done: false },
  hub: { query: '', repos: [], repo: '', files: [], loading: false, error: '', searched: false },
  rec: { items: [], loading: false, done: false, note: '' },
  dl: {}, // downloads in progress or finished, by key: { state, bytes, total, path, error }
  llama: { installed: true, plan: '', path: '', version: '' },
  latest: { tag: '', checking: false, error: '' }, // the newest llama.cpp release, once asked
  confirmDel: '', // the model file waiting for a second click to be deleted
  tab: 'discover', // which tab is showing: discover | mine | lmstudio
  defaultDir: '', // where models are saved unless the user picks a folder
  starting: 0, // starts being sent to the backend (polling waits for them)
  pendingChat: '', // the model file to start chatting with once llama.cpp has been installed
  busy: false,
  settings: { context: '', gpu: 'auto' },
  CONTEXTS: ['', '4096', '8192', '16384', '32768', '65536', '131072'],
  GPUS: [['auto', 'GPU: auto'], ['max', 'GPU: all layers'], ['0.5', 'GPU: half'], ['off', 'GPU: off (CPU only)']],

  gib(bytes) {
    return bytes / 1073741824;
  },

  fmtSize(bytes) {
    if (!bytes) return '';
    const g = this.gib(bytes);
    return g >= 1 ? `${g.toFixed(1)} GB` : `${Math.round(bytes / 1048576)} MB`;
  },

  /** Parse `lms ls --json` / `lms ps --json` loosely: field names differ between LM Studio versions. */
  rows(text) {
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      return [];
    }
    const arr = Array.isArray(v) ? v : Array.isArray(v && v.models) ? v.models : [];
    return arr
      .map((m) => ({
        key: m.modelKey || m.identifier || m.path || m.id || '',
        name: m.displayName || m.modelKey || m.identifier || m.path || '',
        type: String(m.type || 'llm').toLowerCase(),
        bytes: Number(m.sizeBytes ?? m.size ?? 0) || 0,
        params: m.paramsString || m.params || '',
        arch: m.architecture || m.arch || '',
        ctx: Number(m.contextLength ?? m.maxContextLength ?? 0) || 0,
        vision: Boolean(m.vision),
        tools: Boolean(m.trainedForToolUse)
      }))
      .filter((m) => m.key && (m.type === 'llm' || m.type === 'vlm'));
  },

  /** Will it run well here? Compares the file size (plus working room) with VRAM and RAM. */
  fit(bytes) {
    const p = state.systemProfile;
    if (!p || !bytes) return null;
    const ram = Number(p.totalMemoryGib ?? p.total_memory_gib) || 0;
    const vram = (Number(p.gpuVramMib ?? p.gpu_vram_mib) || 0) / 1024;
    const need = this.gib(bytes) * 1.15;
    if (vram && need <= vram) return { cls: 'good', text: 'Fits your GPU' };
    if (ram && need <= ram * 0.7) return { cls: vram ? 'ok' : 'good', text: vram ? 'Fits in RAM (slower)' : 'Fits your RAM' };
    return { cls: 'bad', text: 'Too big for this PC' };
  },

  async act(action, extra = {}) {
    try {
      return await invoke('lms_action', { action, model: null, gpu: null, context: null, ...extra });
    } catch (e) {
      throw new Error(String(e));
    }
  },

  async refresh() {
    if (this.busy) return;
    this.busy = true;
    this.data.error = '';
    this.render();
    try {
      const [list, loaded, server] = await Promise.all([
        this.act('list'),
        this.act('loaded').catch(() => '[]'),
        this.act('server_status').catch((e) => String(e.message || e))
      ]);
      this.data.list = this.rows(list);
      this.data.loaded = this.rows(loaded);
      this.data.server = String(server || '');
    } catch (e) {
      this.data.error = e.message;
      this.data.list = [];
      this.data.loaded = [];
    } finally {
      this.busy = false;
      this.render();
    }
  },

  folders() {
    return Array.isArray(prefs.modelFolders) ? prefs.modelFolders : [];
  },

  /** What this PC can run: the memory a model may use, and whether that is the GPU or the system RAM. */
  budget() {
    const p = state.systemProfile;
    if (!p) return null;
    const ram = Number(p.totalMemoryGib ?? p.total_memory_gib) || 0;
    const vram = (Number(p.gpuVramMib ?? p.gpu_vram_mib) || 0) / 1024;
    const gpu = String(p.gpuName ?? p.gpu_name ?? '');
    if (vram >= 2) return { gpuGib: vram, ramGib: ram * 0.5, where: 'GPU' };
    if (/apple/i.test(gpu) && ram) return { gpuGib: ram * 0.65, ramGib: ram * 0.65, where: 'unified memory' };
    if (ram) return { gpuGib: 0, ramGib: ram * 0.5, where: 'CPU' };
    return null;
  },

  /** Rank of a quantisation: higher is closer to the original model. Anything below Q4_K or above Q8 is left out. */
  quantRank(q) {
    const u = String(q || '').toUpperCase();
    if (u.startsWith('Q8')) return 4;
    if (u.startsWith('Q6')) return 3;
    if (u.startsWith('Q5')) return 2;
    if (u.startsWith('Q4_K')) return 1;
    return 0;
  },

  /** The best file of one model for a budget: the highest-quality quantisation that fits the GPU, otherwise
   *  the smallest good one that fits system RAM (slower). Null when nothing fits. */
  pick(files, b) {
    const ok = files.filter((f) => this.quantRank(f.quant) > 0);
    const need = (f) => (f.size / 1073741824) * 1.15;
    const gpu = ok.filter((f) => b.gpuGib && need(f) <= b.gpuGib).sort((x, y) => this.quantRank(y.quant) - this.quantRank(x.quant) || y.size - x.size)[0];
    if (gpu) return { file: gpu, tier: b.where === 'CPU' ? 'cpu' : 'gpu' };
    const ram = ok.filter((f) => this.quantRank(f.quant) === 1 && need(f) <= b.ramGib).sort((x, y) => x.size - y.size)[0];
    return ram ? { file: ram, tier: 'slow' } : null;
  },

  /** Choose which curated models to offer: only ones that run on this machine, the most capable first. */
  plan(entries, b) {
    const rows = entries.map((e) => ({ ...e, ...(this.pick(e.files, b) || {}) })).filter((r) => r.file);
    const order = { gpu: 0, cpu: 0, slow: 1 };
    rows.sort((x, y) => order[x.tier] - order[y.tier] || y.file.size - x.file.size);
    const perKind = {};
    return rows.filter((r) => ((perKind[r.kind] = (perKind[r.kind] || 0) + 1) <= 3)).slice(0, 6);
  },

  async loadRecommended() {
    if (this.rec.loading || this.rec.done) return;
    this.rec.loading = true;
    for (let i = 0; i < 12 && !state.systemProfile; i++) await new Promise((r) => setTimeout(r, 250)); // the hardware scan may still be running
    const b = this.budget();
    if (!b) {
      this.rec = { items: [], loading: false, done: true, note: "ezCLI could not read this PC's memory, so it cannot tell which models fit. Use Find models below and check each file's size against your memory." };
      return this.render();
    }
    const entries = [];
    let next = 0;
    const worker = async () => {
      while (next < CURATED.length) {
        const e = CURATED[next++];
        try {
          const files = await invoke('hub_files', { repo: e.repo });
          if (Array.isArray(files)) entries.push({ ...e, files });
        } catch {
          /* a repo that cannot be read right now is simply not offered */
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const items = this.plan(entries, b);
    const note = entries.length === 0 ? 'Could not reach Hugging Face to look up models. Check your connection, then reopen this panel.' : items.length ? '' : 'No ready-made model fits this PC comfortably. Use Find models below and look for small files (under 2 GB).';
    this.rec = { items, loading: false, done: entries.length > 0, note };
    this.render();
  },

  busyKeys() {
    return Object.keys(this.dl).filter((k) => ['downloading', 'verifying'].includes(this.dl[k].state));
  },

  /** Ask the backend how the downloads are doing once a second while any is running, so the screen never depends
   *  on events alone. */
  poll() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(async () => {
      if (!this.busyKeys().length) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
        return;
      }
      if (this.starting) return; // a download is being handed over: its first report would be old news
      try {
        for (const p of await invoke('hub_status')) if (this.dl[p.key]) this.onProgress(p);
      } catch {
        /* the next tick tries again */
      }
    }, 1000);
  },

  /** The folder chosen for downloads, or null for the default one. */
  saveDir() {
    return typeof prefs.modelDir === 'string' && prefs.modelDir.trim() ? prefs.modelDir.trim() : null;
  },

  async chooseDir() {
    const defaultPath = this.saveDir() || this.defaultDir || undefined;
    let dir = null;
    try {
      dir = T.dialog && T.dialog.open
        ? await T.dialog.open({ directory: true, multiple: false, defaultPath })
        : await invoke('plugin:dialog|open', { options: { directory: true, multiple: false, defaultPath } });
    } catch (e) {
      toast(`Could not open the folder picker: ${e}`, 'error');
      return;
    }
    dir = Array.isArray(dir) ? dir[0] : dir;
    if (!dir) return; // cancelled
    prefs.modelDir = String(dir);
    // downloads must show up in "My models", so the scan searches this folder too
    if (!this.folders().includes(prefs.modelDir)) prefs.modelFolders = [...this.folders(), prefs.modelDir];
    savePrefs();
    toast(`Models will be saved in ${prefs.modelDir}`);
    this.render();
    this.scanPc(false);
  },

  resetDir() {
    prefs.modelDir = '';
    savePrefs();
    this.render();
  },

  gb(bytes) {
    return `${(bytes / 1073741824).toFixed(bytes >= 1073741824 * 10 ? 0 : 1)} GB`;
  },

  async loadLlama() {
    try {
      this.llama = await invoke('llama_status');
    } catch {
      this.llama = { installed: true, plan: '', path: '' };
    }
  },

  /** Chat was pressed on a model file but llama.cpp is not there: open the panel at the install button. */
  async needLlama(modelPath) {
    this.pendingChat = modelPath || '';
    toast('llama.cpp is needed to run this model. Press "Install llama.cpp" and the chat starts when it is ready.');
    if (!this.dlg || !this.dlg.open) this.open();
    await this.loadLlama();
    this.render();
    const card = this.dlg && this.dlg.querySelector('[data-llama-install]');
    if (card) card.scrollIntoView({ block: 'center' });
  },

  async installLlama(cpuOnly) {
    this.dl['llama.cpp'] = { state: 'downloading', bytes: 0, total: 0, error: '', note: '' };
    this.latest = { tag: '', checking: false, error: '' };
    this.render();
    this.starting++;
    try {
      await invoke('llama_install', { cpuOnly: Boolean(cpuOnly) });
      this.poll();
    } catch (e) {
      this.dl['llama.cpp'] = { state: 'error', bytes: 0, total: 0, error: String(e), note: '' };
      this.render();
    } finally {
      this.starting--;
    }
  },

  async checkLlamaUpdate() {
    this.latest = { tag: '', checking: true, error: '' };
    this.render();
    try {
      this.latest = { tag: await invoke('llama_latest', { cpuOnly: false }), checking: false, error: '' };
    } catch (e) {
      this.latest = { tag: '', checking: false, error: String(e) };
    }
    this.render();
  },

  /** Delete one model file after a second click on the same row. */
  async deleteModel(path) {
    if (this.confirmDel !== path) {
      this.confirmDel = path;
      return void this.render();
    }
    this.confirmDel = '';
    try {
      await invoke('model_delete', { path });
      this.pc.found = this.pc.found.filter((m) => m.path !== path);
      toast('Model deleted.');
    } catch (e) {
      toast(String(e));
    }
    this.render();
  },

  /** A progress event from the downloader (a model file, or llama.cpp itself). */
  async onProgress(p) {
    const prev = this.dl[p.key] || {};
    const ended = p.state === 'done' || p.state === 'error' || p.state === 'cancelled';
    // the same ending can arrive twice (as an event and from the status poll): act on it once
    if (ended && prev.state === p.state) return;
    this.dl[p.key] = { state: p.state, bytes: p.bytes || prev.bytes || 0, total: p.total || prev.total || 0, path: p.path || prev.path || '', error: p.error || '', note: p.note || '', startedAt: prev.startedAt || 0 };
    if (p.key === 'llama.cpp' && p.state === 'done') {
      // the agent list tells the app which programs exist: refresh it so the new one counts
      try {
        const info = await invoke('list_agents');
        state.agents = info.agents;
      } catch {
        /* the next start will see it */
      }
      await this.loadLlama();
      toast('llama.cpp is installed.');
      if (this.pendingChat) {
        const path = this.pendingChat;
        this.pendingChat = '';
        if (this.dlg && this.dlg.open) this.dlg.close();
        createSession('gguf', { modelId: path });
      }
    } else if (p.state === 'done') {
      toast('Download finished and checked.');
      this.scanPc(false);
    } else if (p.state === 'error') {
      toast(p.error || 'The download failed.', 'error');
    }
    // progress ticks redraw at most twice a second; the end of a download redraws at once
    if (ended || !this.drawAt || Date.now() - this.drawAt > 500) {
      this.drawAt = Date.now();
      this.render();
    }
  },

  async searchHub() {
    const input = this.dlg && this.dlg.querySelector('[data-search-input]');
    const q = (input ? input.value : this.hub.query).trim();
    this.hub = { ...this.hub, query: q, loading: true, error: '', repo: '', files: [], searched: true };
    this.render();
    try {
      this.hub.repos = await invoke('hub_search', { query: q });
    } catch (e) {
      this.hub.error = String(e);
      this.hub.repos = [];
    }
    this.hub.loading = false;
    this.render();
  },

  async openRepo(id) {
    this.hub = { ...this.hub, repo: id, files: [], loading: true, error: '' };
    this.render();
    try {
      this.hub.files = await invoke('hub_files', { repo: id });
    } catch (e) {
      this.hub.error = String(e);
    }
    this.hub.loading = false;
    this.render();
  },

  async download(f, repo) {
    if (!f || !repo) return;
    const key = `${repo}/${f.path}`;
    this.dl[key] = { state: 'downloading', bytes: 0, total: f.size, error: '', note: '', startedAt: Date.now() };
    this.render();
    this.starting++;
    try {
      await invoke('hub_download', { repo, file: f.path, size: f.size, sha256: f.sha256, dir: this.saveDir() });
      this.poll();
    } catch (e) {
      if (/already running/i.test(String(e))) {
        this.poll(); // the same file is already coming down: keep showing its progress
      } else {
        this.dl[key] = { state: 'error', bytes: 0, total: f.size, error: String(e), note: '' };
        this.render();
      }
    } finally {
      this.starting--;
    }
  },

  /** Look for .gguf model files on this PC (read-only: folder listings and file sizes). */
  async scanPc(deep) {
    if (this.pc.scanning) return;
    this.pc = { ...this.pc, scanning: true, deep: Boolean(deep), error: '' };
    this.render();
    try {
      this.pc.found = await invoke('local_models_scan', { folders: this.folders(), deep: Boolean(deep) });
      this.pc.done = true;
    } catch (e) {
      this.pc.error = String(e);
    }
    this.pc.scanning = false;
    this.render();
  },

  addFolder(path) {
    const p = String(path || '').trim();
    if (!p) return;
    if (!this.folders().includes(p)) {
      prefs.modelFolders = [...this.folders(), p];
      savePrefs();
    }
    return this.scanPc(false);
  },

  removeFolder(path) {
    prefs.modelFolders = this.folders().filter((x) => x !== path);
    savePrefs();
    return this.scanPc(false);
  },

  serverOn() {
    const t = this.data.server.toLowerCase();
    return /running|listening|on port/.test(t) && !/not running|stopped|is off/.test(t);
  },

  port() {
    const m = /(?:port|:)\s*(\d{4,5})/.exec(this.data.server);
    return m ? m[1] : '1234';
  },

  async run(label, action, extra) {
    this.busy = true;
    this.render(label);
    try {
      await this.act(action, extra);
      toast(`${label} done.`);
    } catch (e) {
      toast(`${label} failed: ${e.message}`, 'error');
    }
    this.busy = false;
    await this.refresh();
  },

  /** Build an element; text is always set with textContent, never parsed as HTML. */
  el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c) n.append(c);
    return n;
  },

  btn(label, attrs = {}, primary = false) {
    return this.el('button', { class: primary ? 'btn primary' : 'btn', type: 'button', text: label, ...attrs });
  },

  progressBar(d) {
    const pct = d.total ? Math.min(100, Math.round((d.bytes / d.total) * 100)) : 0;
    const bar = this.el('div', { class: 'mbar' }, this.el('div', { class: 'mbar-fill', style: `width:${d.state === 'verifying' ? 100 : pct}%` }));
    const label = d.state === 'verifying' ? 'Checking the file…' : d.total ? `${this.gb(d.bytes)} of ${this.gb(d.total)} (${pct}%)` : 'Downloading…';
    return this.el('div', { class: 'mprog' }, bar, this.el('span', { class: 'mmuted', text: label }), d.note && this.el('span', { class: 'mwarn', text: d.note }));
  },

  /** llama.cpp runs the model files. When it is missing, offer to install it from the official release. */
  runtimeNote() {
    const d = this.dl['llama.cpp'];
    const busy = d && (d.state === 'downloading' || d.state === 'verifying');
    if (this.llama.installed) {
      const have = this.llama.version;
      const newer = have && this.latest.tag && this.latest.tag !== have;
      const status = busy ? 'Installing…' : this.latest.checking ? 'Checking for a newer version…' : newer ? `Update available: ${this.latest.tag} (you have ${have})` : have && this.latest.tag ? `Up to date (${have})` : have ? `Version ${have}` : 'Installed (not by ezCLI, so its version is unknown)';
      return this.el(
        'div',
        { class: 'msetup' },
        this.el(
          'div',
          { class: 'mrow-main' },
          this.el('div', { class: 'mrow-name', text: 'llama.cpp (runs the model files)' }),
          this.el('div', { class: 'mrow-meta', title: this.llama.path, text: status }),
          busy && this.progressBar(d),
          d && d.state === 'error' && this.el('div', { class: 'merror', text: d.error }),
          this.latest.error && this.el('div', { class: 'merror', text: this.latest.error })
        ),
        !busy && this.btn(newer ? 'Update' : 'Check for update', newer ? { 'data-llama-install': true } : { 'data-llama-check': true }, Boolean(newer)),
        !busy && this.btn('Reinstall', { 'data-llama-install': true, title: 'Download the newest build again and replace the installed one' }),
        !busy && this.btn('CPU-only build', { 'data-llama-install': true, 'data-cpu': true, title: 'Install the build without GPU support. Use it if models crash while loading.' })
      );
    }
    return this.el(
      'div',
      { class: 'msetup' },
      this.el(
        'div',
        { class: 'mrow-main' },
        this.el('div', { class: 'mrow-name', text: 'One step first: install the runner' }),
        this.el('div', { class: 'mrow-meta', text: `llama.cpp runs the model files. ezCLI installs ${this.llama.plan || 'it'} into your own folder (no admin rights).` }),
        busy && this.progressBar(d),
        d && d.state === 'error' && this.el('div', { class: 'merror', text: d.error })
      ),
      !busy && this.btn(d && d.state === 'error' ? 'Try again' : 'Install llama.cpp', { 'data-llama-install': true }, true),
      !busy && this.btn('CPU-only build', { 'data-llama-install': true, 'data-cpu': true, title: 'Install the build without GPU support' })
    );
  },

  /** "Recommended for this PC": models chosen from this machine's own memory, one click to install. */
  recommended() {
    const profile = typeof systemProfileSummary === 'function' ? systemProfileSummary() : '';
    const tierText = { gpu: 'Fits your GPU', cpu: 'Runs on your CPU', slow: 'Fits your RAM (slower)' };
    const cards = this.rec.items.map((r) => {
      const key = `${r.repo}/${r.file.path}`;
      const d = this.dl[key];
      const busy = d && (d.state === 'downloading' || d.state === 'verifying');
      const done = d && d.state === 'done';
      return this.el(
        'div',
        { class: 'mrow' },
        this.el(
          'div',
          { class: 'mrow-main' },
          this.el('div', { class: 'mrow-name', text: r.title }),
          this.el('div', { class: 'mrow-meta', text: [r.kind, r.note, r.file.quant, this.gb(r.file.size)].filter(Boolean).join(' · ') }),
          busy && this.progressBar(d),
          done && d.path && this.el('div', { class: 'mmuted', text: `Saved to ${d.path}` }),
          d && d.state === 'error' && this.el('div', { class: 'merror', text: d.error })
        ),
        this.el('span', { class: `mfit ${r.tier === 'slow' ? 'ok' : 'good'}`, text: tierText[r.tier] }),
        busy ? this.btn('Cancel', { 'data-dl-cancel': key }) : done ? this.btn('Chat', { 'data-gguf': d.path }, true) : this.btn('Install', { 'data-rec': r.repo })
      );
    });
    return [
      this.sec('Best for your PC', 'Only models that run on this machine, in the best quality that fits. One click downloads, checks and installs.'),
      this.rec.note && this.el('p', { class: 'merror', text: this.rec.note }),
      this.el('div', { class: 'mlist' }, cards.length ? cards : this.el('p', { class: 'mmuted', text: this.rec.loading || !this.rec.done ? 'Checking which models fit your PC…' : '' }))
    ];
  },

  /** The Hugging Face browser: search, pick a model, pick a file, download. */
  browser(esc) {
    const h = this.hub;
    const rows = h.repo
      ? h.files.map((f) => {
          const key = `${h.repo}/${f.path}`;
          const d = this.dl[key];
          const fit = this.fit(f.size);
          const busy = d && (d.state === 'downloading' || d.state === 'verifying');
          const done = d && d.state === 'done';
          const base = f.path.split('/').pop();
          return this.el(
            'div',
            { class: 'mrow' },
            this.el('div', { class: 'mrow-main' }, this.el('div', { class: 'mrow-name', text: base }), this.el('div', { class: 'mrow-meta', text: [f.quant, this.gb(f.size), f.sha256 ? 'checksum verified after download' : ''].filter(Boolean).join(' · ') }), busy && this.progressBar(d), done && d.path && this.el('div', { class: 'mmuted', text: `Saved to ${d.path}` }), d && d.state === 'error' && this.el('div', { class: 'merror', text: d.error })),
            fit && this.el('span', { class: `mfit ${fit.cls}`, text: fit.text }),
            busy ? this.btn('Cancel', { 'data-dl-cancel': key }) : done ? this.btn('Chat', { 'data-gguf': d.path }, true) : this.btn('Download', { 'data-dl': f.path })
          );
        })
      : h.repos.map((r) =>
          this.el('div', { class: 'mrow mclick', 'data-repo': r.id, role: 'button', tabindex: '0' }, this.el('div', { class: 'mrow-main' }, this.el('div', { class: 'mrow-name', text: r.id }), this.el('div', { class: 'mrow-meta', text: `${r.downloads.toLocaleString()} downloads · ${r.likes.toLocaleString()} likes` })), this.el('span', { class: 'mmuted', text: 'Files ›' }))
        );
    return [
      this.sec('Find more', 'Search Hugging Face for GGUF models. Downloads are checked against its checksum.'),
      this.el('div', { class: 'msettings' }, this.el('input', { type: 'text', 'data-search-input': true, class: 'mfolder', placeholder: 'Search, e.g. qwen3 8b, llama 3.1, gemma', value: h.query }), this.btn(h.loading && !h.repo ? 'Searching…' : 'Search', { 'data-search': true }), h.repo && this.btn('‹ Back to results', { 'data-hub-back': true })),
      h.error && this.el('p', { class: 'merror', text: h.error }),
      h.repo && this.el('p', { class: 'mmuted', text: `${h.repo}: pick a size. Smaller files (Q4) run on less memory; larger ones are more exact.` }),
      this.el('div', { class: 'mlist' }, rows.length ? rows : this.el('p', { class: 'mmuted', text: h.loading ? 'Loading…' : h.searched ? 'Nothing found. Try another name.' : 'Type a model name and press Search.' }))
    ];
  },

  /** A section heading with a one-line explanation and optional buttons on the right. */
  sec(title, sub, ...actions) {
    return this.el('div', { class: 'msec' }, this.el('div', {}, this.el('div', { class: 'msec-t', text: title }), sub && this.el('div', { class: 'msec-s', text: sub })), actions.length && this.el('div', { class: 'mbtns' }, actions));
  },

  /** Where downloads go, with a button to change it. */
  locationRow() {
    const dir = this.saveDir();
    return this.el(
      'div',
      { class: 'mdir' },
      this.el('div', { class: 'mrow-main' }, this.el('div', { class: 'mrow-name', text: 'Save models to' }), this.el('div', { class: 'mpath', title: dir || this.defaultDir, text: dir || this.defaultDir || '…' }), !dir && this.el('div', { class: 'mmuted', text: 'The default folder. Each model gets its own sub-folder.' })),
      this.btn('Change…', { 'data-dir-change': true }),
      dir && this.btn('Use default', { 'data-dir-reset': true })
    );
  },

  discoverTab() {
    return [this.locationRow(), ...this.recommended(), ...this.browser()];
  },

  mineTab() {
    const $e = (t, p, ...k) => this.el(t, p, ...k);
    const rows = this.pc.found.map((m) => {
      const f = this.fit(m.bytes);
      const meta = [m.quant, this.fmtSize(m.bytes), m.source].filter(Boolean).join(' · ');
      return $e(
        'div',
        { class: 'mrow', title: m.path },
        $e('div', { class: 'mrow-main' }, $e('div', { class: 'mrow-name', text: m.name }), $e('div', { class: 'mrow-meta', text: meta })),
        f && $e('span', { class: `mfit ${f.cls}`, text: f.text }),
        this.btn('Chat', { 'data-gguf': m.path, title: 'Start a chat with this model file' }),
        this.confirmDel === m.path && this.btn('Keep', { 'data-gguf-del-no': true }),
        this.btn(this.confirmDel === m.path ? 'Delete the file?' : 'Uninstall', { 'data-gguf-del': m.path, title: 'Delete this model file from your PC' })
      );
    });
    const searching = this.pc.scanning;
    return [
      this.sec('Models on this PC', 'Model files (.gguf) found on this computer, whoever downloaded them. No LM Studio or Ollama needed.', this.btn(searching && !this.pc.deep ? 'Scanning…' : 'Scan', { 'data-scan': true }), this.btn(searching && this.pc.deep ? 'Searching all drives…' : 'Deep scan', { 'data-scan-deep': true, title: 'Search whole drives (up to about 40 seconds)' })),
      this.pc.error && $e('p', { class: 'merror', text: this.pc.error }),
      $e('div', { class: 'mlist' }, rows.length ? rows : $e('p', { class: 'mempty', text: searching ? 'Looking through your folders…' : this.pc.done ? 'No model files found yet. Add the folder they are in, or download one from Discover.' : 'Press Scan to look for model files.' })),
      this.sec('Folders searched', 'Besides the usual places (Downloads, LM Studio, Hugging Face cache, …).'),
      $e(
        'div',
        { class: 'mfolders' },
        this.folders().map((f) => $e('span', { class: 'mchip' }, f, ' ', this.btn('×', { 'data-folder-rm': f, 'aria-label': `Stop searching ${f}`, class: 'mx' }))),
        $e('input', { type: 'text', 'data-folder-input': true, placeholder: 'Add a folder, e.g. D:\\Models or /home/me/models', class: 'mfolder' }),
        this.btn('Add', { 'data-folder-add': true })
      )
    ];
  },

  lmstudioTab() {
    const $e = (t, p, ...k) => this.el(t, p, ...k);
    const on = this.serverOn();
    const loadedKeys = new Set(this.data.loaded.map((m) => m.key));
    const rows = this.data.list.map((m) => {
      const f = this.fit(m.bytes);
      const meta = [m.params, m.arch, this.fmtSize(m.bytes), m.vision ? 'vision' : '', m.tools ? 'tools' : ''].filter(Boolean).join(' · ');
      const tooBig = f && f.cls === 'bad';
      return $e(
        'div',
        { class: 'mrow' },
        $e('div', { class: 'mrow-main' }, $e('div', { class: 'mrow-name', text: m.name }), $e('div', { class: 'mrow-meta', text: meta })),
        f && $e('span', { class: `mfit ${f.cls}`, text: f.text }),
        this.btn('Chat', { 'data-chat': m.key, title: 'Start a chat with this model' }),
        loadedKeys.has(m.key) ? this.btn('Unload', { 'data-unload': m.key }) : this.btn('Load', { 'data-load': m.key, title: tooBig ? 'Larger than your memory; it may be very slow or fail' : false })
      );
    });
    const select = (attr, options, current) => $e('select', { [attr]: true }, options.map(([v, t]) => $e('option', { value: v, text: t, selected: v === current })));
    const loaded = this.data.loaded.length
      ? [...this.data.loaded.map((m) => $e('span', { class: 'mchip', text: m.name })), this.btn('Unload all', { 'data-unload-all': true })]
      : [$e('span', { class: 'mmuted', text: 'Nothing is loaded. A model loads when you chat with it, or when you press Load.' })];
    return [
      $e('p', { class: 'mmuted', text: 'Optional. If you use LM Studio, manage its models and local server here.' }),
      this.data.error && $e('p', { class: 'merror', text: this.data.error }),
      this.sec('Local server', null),
      $e(
        'div',
        { class: 'mcard' },
        $e('span', { class: on ? 'mdot on' : 'mdot' }),
        $e('div', { class: 'mrow-main' }, $e('div', { class: 'mrow-name', text: on ? 'Running' : 'Stopped' }), $e('div', { class: 'mrow-meta', text: on ? `OpenAI-compatible API at http://localhost:${this.port()}/v1` : 'Start it to let other apps use your models.' })),
        on && this.btn('Copy address', { 'data-copy': true }),
        this.btn(on ? 'Stop' : 'Start', { 'data-server': on ? 'stop' : 'start' }, !on)
      ),
      this.sec('Loaded in memory', null),
      $e('div', { class: 'mcard mloaded' }, loaded),
      this.sec('Downloaded in LM Studio', null, this.btn('Refresh', { 'data-refresh': true })),
      $e('div', { class: 'msettings' }, $e('label', {}, 'Context length ', select('data-ctx', this.CONTEXTS.map((c) => [c, c || 'model default']), this.settings.context)), $e('label', {}, 'GPU offload ', select('data-gpu', this.GPUS, this.settings.gpu))),
      $e('div', { class: 'mlist' }, rows.length ? rows : $e('p', { class: 'mempty', text: this.busy ? 'Reading your models…' : 'No LM Studio models found.' }))
    ];
  },

  render() {
    const d = this.dlg;
    if (!d) return;
    const body = d.querySelector('.models-body');
    const keep = { top: body.scrollTop, vals: {}, focus: document.activeElement && d.contains(document.activeElement) ? (document.activeElement.getAttribute('data-search-input') !== null ? 'search' : document.activeElement.getAttribute('data-folder-input') !== null ? 'folder' : '') : '' };
    for (const k of ['search-input', 'folder-input']) {
      const i = body.querySelector(`[data-${k}]`);
      if (i) keep.vals[k] = i.value;
    }
    // the hardware profile may arrive after the panel opens: draw again once it does
    if (!state.systemProfile && !this.profileRetry) {
      this.profileRetry = setTimeout(() => {
        this.profileRetry = null;
        if (this.dlg && this.dlg.open) this.render();
      }, 1500);
    }
    d.querySelector('.models-hw').textContent = (typeof systemProfileSummary === 'function' ? systemProfileSummary() : '') || '';
    d.querySelectorAll('[data-tab]').forEach((t) => {
      const on = t.dataset.tab === this.tab;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', String(on));
    });
    const mine = d.querySelector('[data-tab="mine"] .mcount');
    if (mine) mine.textContent = this.pc.found.length ? String(this.pc.found.length) : '';
    d.querySelector('.models-setup').replaceChildren(...[this.runtimeNote()].filter(Boolean));
    const kids = this.tab === 'mine' ? this.mineTab() : this.tab === 'lmstudio' ? this.lmstudioTab() : this.discoverTab();
    body.replaceChildren(...kids.filter(Boolean));
    for (const [k, v] of Object.entries(keep.vals)) {
      const i = body.querySelector(`[data-${k}]`);
      if (i && v) i.value = v;
    }
    body.scrollTop = keep.top;
    if (keep.focus) {
      const f = body.querySelector(keep.focus === 'search' ? '[data-search-input]' : '[data-folder-input]');
      if (f) f.focus();
    }
    // only the LM Studio buttons wait while an LM Studio command runs; nothing else is held up
    if (this.busy && this.tab === 'lmstudio') body.querySelectorAll('button').forEach((b) => (b.disabled = true));
  },

  open() {
    if (!this.dlg) this.build();
    this.dlg.showModal();
    invoke('hub_default_dir').then((d) => { this.defaultDir = String(d || ''); this.render(); }).catch(() => {});
    if (this.busyKeys().length) this.poll();
    this.loadLlama().then(() => this.render());
    this.loadRecommended();
    this.refresh();
    if (!this.pc.done) this.scanPc(false);
  },

  build() {
    const d = document.createElement('dialog');
    d.className = 'sheet wide models-sheet';
    const tab = (id, label, extra) => this.el('button', { type: 'button', class: 'mtab', role: 'tab', 'data-tab': id }, label, extra);
    d.append(
      this.el('div', { class: 'models-head' }, this.el('div', {}, this.el('h2', { text: 'Local models' }), this.el('div', { class: 'models-hw' })), this.btn('Done', { 'data-close': true })),
      this.el('div', { class: 'models-setup' }),
      this.el('div', { class: 'models-tabs', role: 'tablist' }, tab('discover', 'Discover'), tab('mine', 'My models ', this.el('span', { class: 'mcount' })), tab('lmstudio', 'LM Studio')),
      this.el('div', { class: 'models-body' })
    );
    document.body.appendChild(d);
    this.dlg = d;
    d.addEventListener('click', (e) => {
      const t = e.target.closest('button,select');
      if (!t) return;
      if (t.dataset.tab) {
        this.tab = t.dataset.tab;
        return void this.render();
      }
      if (t.hasAttribute('data-close')) return d.close();
      if (t.hasAttribute('data-refresh')) return this.refresh();
      if (t.hasAttribute('data-dir-change')) return void this.chooseDir();
      if (t.hasAttribute('data-dir-reset')) return void this.resetDir();
      if (t.hasAttribute('data-llama-check')) return void this.checkLlamaUpdate();
      if (t.hasAttribute('data-llama-install')) return void this.installLlama(t.hasAttribute('data-cpu'));
      if (t.dataset.ggufDel) return void this.deleteModel(t.dataset.ggufDel);
      if (t.hasAttribute('data-gguf-del-no')) {
        this.confirmDel = '';
        return void this.render();
      }
      if (t.hasAttribute('data-search')) return void this.searchHub();
      if (t.hasAttribute('data-hub-back')) {
        this.hub = { ...this.hub, repo: '', files: [], error: '' };
        return void this.render();
      }
      if (t.dataset.dl) return void this.download(this.hub.files.find((x) => x.path === t.dataset.dl), this.hub.repo);
      if (t.dataset.rec) {
        const r = this.rec.items.find((x) => x.repo === t.dataset.rec);
        if (!r) return;
        // the model needs llama.cpp to run: fetch it too, so one click is enough
        if (!this.llama.installed && !this.dl['llama.cpp']) {
          toast('Installing llama.cpp too: it is the program that runs the model.');
          this.installLlama();
        }
        return void this.download(r.file, r.repo);
      }
      if (t.dataset.dlCancel) {
        // the Install button turns into Cancel under the cursor: a double-click must not cancel what it just started
        const started = (this.dl[t.dataset.dlCancel] || {}).startedAt || 0;
        if (Date.now() - started < 800) return;
        return void invoke('hub_cancel', { key: t.dataset.dlCancel });
      }
      if (t.hasAttribute('data-scan')) return void this.scanPc(false);
      if (t.hasAttribute('data-scan-deep')) return void this.scanPc(true);
      if (t.hasAttribute('data-folder-add')) {
        const input = d.querySelector('[data-folder-input]');
        return void this.addFolder(input && input.value);
      }
      if (t.dataset.folderRm) return void this.removeFolder(t.dataset.folderRm);
      if (t.dataset.gguf) {
        d.close();
        return void createSession('gguf', { modelId: t.dataset.gguf });
      }
      if (t.hasAttribute('data-copy')) return void navigator.clipboard.writeText(`http://localhost:${this.port()}/v1`).then(() => toast('Address copied.'));
      if (t.hasAttribute('data-hf')) return void openAgentBrowser('https://huggingface.co/models?library=gguf&sort=trending');
      if (t.dataset.server) return void this.run(t.dataset.server === 'start' ? 'Starting the server' : 'Stopping the server', `server_${t.dataset.server}`);
      if (t.hasAttribute('data-unload-all')) return void this.run('Unloading', 'unload_all');
      if (t.dataset.unload) return void this.run('Unloading', 'unload', { model: t.dataset.unload });
      if (t.dataset.load) {
        const ctx = this.settings.context ? Number(this.settings.context) : null;
        return void this.run('Loading the model', 'load', { model: t.dataset.load, gpu: this.settings.gpu, context: ctx });
      }
      if (t.dataset.chat) {
        d.close();
        createSession('lmstudio', { modelId: t.dataset.chat });
      }
    });
    d.addEventListener('click', (e) => {
      const row = e.target.closest('[data-repo]');
      if (row && !e.target.closest('button')) this.openRepo(row.dataset.repo);
    });
    d.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.target.matches('[data-search-input]')) this.searchHub();
      else if (e.target.matches('[data-folder-input]')) this.addFolder(e.target.value);
      else if (e.target.matches('[data-repo]')) this.openRepo(e.target.dataset.repo);
    });
    d.addEventListener('change', (e) => {
      if (e.target.matches('[data-ctx]')) this.settings.context = e.target.value;
      if (e.target.matches('[data-gpu]')) this.settings.gpu = e.target.value;
    });
  }
};

hooks.boot.push(() => {
  try {
    listen('model-download', (e) => Models.onProgress(e.payload));
  } catch {
    /* no event bridge: downloads still run, progress just is not shown */
  }
  const anchor = document.getElementById('browserBtn');
  if (anchor && !document.getElementById('modelsBtn')) {
    const b = document.createElement('button');
    b.className = 'rail-btn';
    b.id = 'modelsBtn';
    b.title = 'Local models: downloaded, loaded, and the local server';
    b.setAttribute('aria-label', 'Local models');
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7 })) svg.setAttribute(k, v);
    for (const [tag, attrs] of [['rect', { x: 4, y: 4, width: 16, height: 6, rx: 1.5 }], ['rect', { x: 4, y: 14, width: 16, height: 6, rx: 1.5 }], ['path', { d: 'M8 7h.01M8 17h.01' }]]) {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      svg.append(n);
    }
    const label = document.createElement('span');
    label.className = 'rail-label';
    label.textContent = 'Models';
    b.append(svg, label);
    anchor.before(b);
    b.addEventListener('click', () => Models.open());
  }
});

registerCommand({ group: 'App', label: 'Local models: downloaded, loaded, server', run: () => Models.open() });
