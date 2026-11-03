'use strict';
/* Local models, the way LM Studio shows them: what is downloaded and whether it fits this PC, what is
 * loaded in memory, load settings (context length, GPU offload), and the local OpenAI-compatible server.
 * Everything goes through LM Studio's own `lms` command; ezCLI never downloads a model by itself. */

const Models = {
  dlg: null,
  data: { list: [], loaded: [], server: '', error: '' },
  pc: { found: [], scanning: false, deep: false, error: '', done: false },
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

  /** A note when llama.cpp (the program that runs the files) is not installed. */
  runtimeNote() {
    const a = typeof agent === 'function' ? agent('gguf') : null;
    if (!a || a.available) return null;
    return this.el(
      'p',
      { class: 'merror' },
      'llama.cpp is not installed, so these files cannot run yet. Windows: ',
      this.el('code', { text: 'winget install ggml.llamacpp' }),
      '. Linux or macOS: use your package manager or the builds at github.com/ggml-org/llama.cpp, then restart ezCLI.'
    );
  },

  render(working) {
    const d = this.dlg;
    if (!d) return;
    const body = d.querySelector('.models-body');
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
      $e('h3', { text: 'Get more models' }),
      $e(
        'div',
        { class: 'mcard' },
        $e(
          'div',
          { class: 'mrow-main' },
          $e('div', { class: 'mrow-name', text: 'Browse and download' }),
          $e('div', { class: 'mrow-meta' }, 'Search Hugging Face in the in-app browser, then run ', $e('code', { text: 'lms get <model>' }), ' in a terminal. ezCLI never downloads a model for you.')
        ),
        this.btn('Search models', { 'data-hf': true })
      )
    ];
    body.replaceChildren(...kids.filter(Boolean));
    body.querySelectorAll('button').forEach((b) => (b.disabled = this.busy));
  },

  open() {
    if (!this.dlg) this.build();
    this.dlg.showModal();
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
    d.addEventListener('change', (e) => {
      if (e.target.matches('[data-ctx]')) this.settings.context = e.target.value;
      if (e.target.matches('[data-gpu]')) this.settings.gpu = e.target.value;
    });
  }
};

hooks.boot.push(() => {
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
