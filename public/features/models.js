'use strict';
/* Local models, the way LM Studio shows them: what is downloaded and whether it fits this PC, what is
 * loaded in memory, load settings (context length, GPU offload), and the local OpenAI-compatible server.
 * Everything goes through LM Studio's own `lms` command; ezCLI never downloads a model by itself. */

const Models = {
  dlg: null,
  data: { list: [], loaded: [], server: '', error: '' },
  pc: { found: [], scanning: false, deep: false, error: '', done: false },
  hub: { query: '', repos: [], repo: '', files: [], loading: false, error: '', searched: false },
  dl: {}, // downloads in progress or finished, by key: { state, bytes, total, path, error }
  llama: { installed: true, plan: '', path: '' },
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

  async installLlama() {
    this.dl['llama.cpp'] = { state: 'downloading', bytes: 0, total: 0, error: '' };
    this.render();
    try {
      await invoke('llama_install');
    } catch (e) {
      this.dl['llama.cpp'] = { state: 'error', bytes: 0, total: 0, error: String(e) };
      this.render();
    }
  },

  /** A progress event from the downloader (a model file, or llama.cpp itself). */
  async onProgress(p) {
    const prev = this.dl[p.key] || {};
    this.dl[p.key] = { state: p.state, bytes: p.bytes || prev.bytes || 0, total: p.total || prev.total || 0, path: p.path || prev.path || '', error: p.error || '' };
    const ended = p.state === 'done' || p.state === 'error' || p.state === 'cancelled';
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

  async download(file) {
    const f = this.hub.files.find((x) => x.path === file);
    if (!f) return;
    const key = `${this.hub.repo}/${f.path}`;
    this.dl[key] = { state: 'downloading', bytes: 0, total: f.size, error: '' };
    this.render();
    try {
      await invoke('hub_download', { repo: this.hub.repo, file: f.path, size: f.size, sha256: f.sha256 });
    } catch (e) {
      this.dl[key] = { state: 'error', bytes: 0, total: f.size, error: String(e) };
      this.render();
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
    return this.el('div', { class: 'mprog' }, bar, this.el('span', { class: 'mmuted', text: label }));
  },

  /** llama.cpp runs the model files. When it is missing, offer to install it from the official release. */
  runtimeNote() {
    if (this.llama.installed) return null;
    const d = this.dl['llama.cpp'];
    const busy = d && (d.state === 'downloading' || d.state === 'verifying');
    return this.el(
      'div',
      { class: 'mcard' },
      this.el(
        'div',
        { class: 'mrow-main' },
        this.el('div', { class: 'mrow-name', text: 'llama.cpp is not installed' }),
        this.el('div', { class: 'mrow-meta', text: `It is the program that runs these files. ezCLI can install ${this.llama.plan || 'it'} into your own folder (no admin rights).` }),
        busy && this.progressBar(d),
        d && d.state === 'error' && this.el('div', { class: 'merror', text: d.error })
      ),
      !busy && this.btn('Install llama.cpp', { 'data-llama-install': true }, true)
    );
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
            this.el('div', { class: 'mrow-main' }, this.el('div', { class: 'mrow-name', text: base }), this.el('div', { class: 'mrow-meta', text: [f.quant, this.gb(f.size), f.sha256 ? 'checksum verified after download' : ''].filter(Boolean).join(' · ') }), busy && this.progressBar(d), d && d.state === 'error' && this.el('div', { class: 'merror', text: d.error })),
            fit && this.el('span', { class: `mfit ${fit.cls}`, text: fit.text }),
            busy ? this.btn('Cancel', { 'data-dl-cancel': key }) : done ? this.btn('Chat', { 'data-gguf': d.path }, true) : this.btn('Download', { 'data-dl': f.path }, !fit || fit.cls !== 'bad')
          );
        })
      : h.repos.map((r) =>
          this.el('div', { class: 'mrow mclick', 'data-repo': r.id, role: 'button', tabindex: '0' }, this.el('div', { class: 'mrow-main' }, this.el('div', { class: 'mrow-name', text: r.id }), this.el('div', { class: 'mrow-meta', text: `${r.downloads.toLocaleString()} downloads · ${r.likes.toLocaleString()} likes` })), this.el('span', { class: 'mmuted', text: 'Files ›' }))
        );
    return [
      this.el('h3', { text: 'Find models' }),
      this.el('p', { class: 'mmuted', text: 'Search Hugging Face for GGUF models and download one here. Files are checked against Hugging Face\'s checksum and saved in your ezCLI folder.' }),
      this.el('div', { class: 'msettings' }, this.el('input', { type: 'text', 'data-search-input': true, class: 'mfolder', placeholder: 'Search, e.g. qwen3 8b, llama 3.1, gemma', value: h.query }), this.btn(h.loading && !h.repo ? 'Searching…' : 'Search', { 'data-search': true }), h.repo && this.btn('‹ Back to results', { 'data-hub-back': true })),
      h.error && this.el('p', { class: 'merror', text: h.error }),
      h.repo && this.el('p', { class: 'mmuted', text: `${h.repo}: pick a size. Smaller files (Q4) run on less memory; larger ones are more exact.` }),
      this.el('div', { class: 'mlist' }, rows.length ? rows : this.el('p', { class: 'mmuted', text: h.loading ? 'Loading…' : h.searched ? 'Nothing found. Try another name.' : 'Type a model name and press Search.' }))
    ];
  },

  render(working) {
    const d = this.dlg;
    if (!d) return;
    const body = d.querySelector('.models-body');
    const keep = { top: body.scrollTop, vals: {}, focus: document.activeElement && d.contains(document.activeElement) ? document.activeElement.getAttribute('data-search-input') !== null ? 'search' : document.activeElement.getAttribute('data-folder-input') !== null ? 'folder' : '' : '' };
    for (const k of ['search-input', 'folder-input']) {
      const i = body.querySelector(`[data-${k}]`);
      if (i) keep.vals[k] = i.value;
    }
    const $e = (t, p, ...k) => this.el(t, p, ...k);
    const profile = typeof systemProfileSummary === 'function' ? systemProfileSummary() : '';
    const on = this.serverOn();
    const loadedKeys = new Set(this.data.loaded.map((m) => m.key));
    // the hardware profile may arrive after the panel opens: draw again once it does
    if (!state.systemProfile && !this.profileRetry) {
      this.profileRetry = setTimeout(() => {
        this.profileRetry = null;
        if (this.dlg && this.dlg.open) this.render();
      }, 1500);
    }
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
        loadedKeys.has(m.key)
          ? this.btn('Unload', { 'data-unload': m.key })
          : this.btn('Load', { 'data-load': m.key, title: tooBig ? 'Larger than your memory; it may be very slow or fail' : false }, !tooBig)
      );
    });
    const pcRows = this.pc.found.map((m) => {
      const f = this.fit(m.bytes);
      const meta = [m.quant, this.fmtSize(m.bytes), m.source].filter(Boolean).join(' · ');
      return $e(
        'div',
        { class: 'mrow', title: m.path },
        $e('div', { class: 'mrow-main' }, $e('div', { class: 'mrow-name', text: m.name }), $e('div', { class: 'mrow-meta', text: meta })),
        f && $e('span', { class: `mfit ${f.cls}`, text: f.text }),
        this.btn('Chat', { 'data-gguf': m.path, title: 'Start a chat with this model file' }, f ? f.cls !== 'bad' : true)
      );
    });
    const loaded = this.data.loaded.length
      ? [...this.data.loaded.map((m) => $e('span', { class: 'mchip', text: m.name })), this.btn('Unload all', { 'data-unload-all': true })]
      : [$e('span', { class: 'mmuted', text: 'Nothing is loaded. A model loads when you chat with it, or click Load.' })];
    const select = (attr, options, current) =>
      $e('select', { [attr]: true }, options.map(([v, t]) => $e('option', { value: v, text: t, selected: v === current })));
    const label = (text, sel) => $e('label', {}, `${text} `, sel);
    const kids = [
      $e('p', { class: 'mmuted', text: profile }),
      $e('h3', {}, 'On this PC', $e('span', { class: 'mbtns' }, this.btn(this.pc.scanning && !this.pc.deep ? 'Scanning…' : 'Scan', { 'data-scan': true }), this.btn(this.pc.scanning && this.pc.deep ? 'Searching all drives…' : 'Deep scan', { 'data-scan-deep': true, title: 'Search whole drives (up to about 40 seconds)' }))),
      $e('p', { class: 'mmuted', text: 'Model files (.gguf) already on this computer, whoever downloaded them. They run with a plain llama.cpp build: no LM Studio or Ollama needed.' }),
      this.pc.error && $e('p', { class: 'merror', text: this.pc.error }),
      this.runtimeNote(),
      $e('div', { class: 'mlist' }, pcRows.length ? pcRows : $e('p', { class: 'mmuted', text: this.pc.scanning ? 'Looking through your folders…' : this.pc.done ? 'No model files found. Add the folder they are in below.' : 'Press Scan to look for model files.' })),
      $e(
        'div',
        { class: 'msettings' },
        $e('input', { type: 'text', 'data-folder-input': true, placeholder: 'Add a folder to search, e.g. D:\\Models or /home/me/models', class: 'mfolder' }),
        this.btn('Add folder', { 'data-folder-add': true }),
        this.folders().map((f) => $e('span', { class: 'mchip' }, f, ' ', this.btn('×', { 'data-folder-rm': f, 'aria-label': `Stop searching ${f}`, class: 'mx' })))
      ),
      ...this.browser(),
      $e('h3', { text: 'LM Studio (optional)' }),
      this.data.error && $e('p', { class: 'merror', text: this.data.error }),
      $e('h3', { text: 'Local server' }),
      $e(
        'div',
        { class: 'mcard' },
        $e('span', { class: on ? 'mdot on' : 'mdot' }),
        $e(
          'div',
          { class: 'mrow-main' },
          $e('div', { class: 'mrow-name', text: on ? 'Running' : 'Stopped' }),
          $e('div', { class: 'mrow-meta', text: on ? `OpenAI-compatible API at http://localhost:${this.port()}/v1` : 'Start it to let other apps use your models through an OpenAI-compatible API.' })
        ),
        on && this.btn('Copy address', { 'data-copy': true }),
        this.btn(on ? 'Stop' : 'Start', { 'data-server': on ? 'stop' : 'start' }, !on)
      ),
      $e('h3', { text: 'Loaded in memory' }),
      $e('div', { class: 'mcard mloaded' }, loaded),
      $e('h3', {}, 'Downloaded', this.btn('Refresh', { 'data-refresh': true })),
      $e(
        'div',
        { class: 'msettings' },
        label('Context length', select('data-ctx', this.CONTEXTS.map((c) => [c, c || 'model default']), this.settings.context)),
        label('GPU offload', select('data-gpu', this.GPUS, this.settings.gpu))
      ),
      $e('div', { class: 'mlist' }, rows.length ? rows : $e('p', { class: 'mmuted', text: this.busy ? (working ? `${working}…` : 'Reading your models…') : 'No downloaded chat models found.' })),
    ];
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
    body.querySelectorAll('button').forEach((b) => (b.disabled = this.busy));
  },

  open() {
    if (!this.dlg) this.build();
    this.dlg.showModal();
    this.loadLlama().then(() => this.render());
    this.refresh();
    if (!this.pc.done) this.scanPc(false);
  },

  build() {
    const d = document.createElement('dialog');
    d.className = 'sheet wide models-sheet';
    d.append(this.el('div', { class: 'models-head' }, this.el('h2', { text: 'Local models' }), this.btn('Done', { 'data-close': true })), this.el('div', { class: 'models-body' }));
    document.body.appendChild(d);
    this.dlg = d;
    d.addEventListener('click', (e) => {
      const t = e.target.closest('button,select');
      if (!t) return;
      if (t.hasAttribute('data-close')) return d.close();
      if (t.hasAttribute('data-refresh')) return this.refresh();
      if (t.hasAttribute('data-llama-install')) return void this.installLlama();
      if (t.hasAttribute('data-search')) return void this.searchHub();
      if (t.hasAttribute('data-hub-back')) {
        this.hub = { ...this.hub, repo: '', files: [], error: '' };
        return void this.render();
      }
      if (t.dataset.dl) return void this.download(t.dataset.dl);
      if (t.dataset.dlCancel) return void invoke('hub_cancel', { key: t.dataset.dlCancel });
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
