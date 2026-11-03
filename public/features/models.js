'use strict';
/* Local models, the way LM Studio shows them: what is downloaded and whether it fits this PC, what is
 * loaded in memory, load settings (context length, GPU offload), and the local OpenAI-compatible server.
 * Everything goes through LM Studio's own `lms` command; ezCLI never downloads a model by itself. */

const Models = {
  dlg: null,
  data: { list: [], loaded: [], server: '', error: '' },
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

  render(working) {
    const d = this.dlg;
    if (!d) return;
    const body = d.querySelector('.models-body');
    const esc2 = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const profile = typeof systemProfileSummary === 'function' ? systemProfileSummary() : '';
    const on = this.serverOn();
    const loadedKeys = new Set(this.data.loaded.map((m) => m.key));
    const rows = this.data.list
      .map((m) => {
        const f = this.fit(m.bytes);
        const isLoaded = loadedKeys.has(m.key);
        const meta = [m.params, m.arch, this.fmtSize(m.bytes), m.vision ? 'vision' : '', m.tools ? 'tools' : ''].filter(Boolean).join(' · ');
        return `<div class="mrow">
          <div class="mrow-main"><div class="mrow-name">${esc2(m.name)}</div><div class="mrow-meta">${esc2(meta)}</div></div>
          ${f ? `<span class="mfit ${f.cls}">${f.text}</span>` : ''}
          <button class="btn" data-chat="${esc2(m.key)}" title="Start a chat with this model">Chat</button>
          ${isLoaded ? `<button class="btn" data-unload="${esc2(m.key)}">Unload</button>` : `<button class="btn primary" data-load="${esc2(m.key)}">Load</button>`}
        </div>`;
      })
      .join('');
    const loaded = this.data.loaded.length
      ? this.data.loaded.map((m) => `<span class="mchip">${esc2(m.name)}</span>`).join('') + '<button class="btn" data-unload-all>Unload all</button>'
      : '<span class="mmuted">Nothing is loaded. A model loads when you chat with it, or click Load.</span>';
    body.innerHTML = `
      <p class="mmuted">${esc2(profile)}</p>
      ${this.data.error ? `<p class="merror">${esc2(this.data.error)}</p>` : ''}
      <h3>Local server</h3>
      <div class="mcard">
        <span class="mdot ${on ? 'on' : ''}"></span>
        <div class="mrow-main"><div class="mrow-name">${on ? 'Running' : 'Stopped'}</div>
        <div class="mrow-meta">${on ? `OpenAI-compatible API at http://localhost:${this.port()}/v1` : 'Start it to let other apps use your models through an OpenAI-compatible API.'}</div></div>
        ${on ? '<button class="btn" data-copy>Copy address</button>' : ''}
        <button class="btn ${on ? '' : 'primary'}" data-server="${on ? 'stop' : 'start'}">${on ? 'Stop' : 'Start'}</button>
      </div>
      <h3>Loaded in memory</h3>
      <div class="mcard mloaded">${loaded}</div>
      <h3>Downloaded <button class="btn" data-refresh>Refresh</button></h3>
      <div class="msettings">
        <label>Context length <select data-ctx>${this.CONTEXTS.map((c) => `<option value="${c}" ${c === this.settings.context ? 'selected' : ''}>${c || 'model default'}</option>`).join('')}</select></label>
        <label>GPU offload <select data-gpu>${this.GPUS.map(([v, t]) => `<option value="${v}" ${v === this.settings.gpu ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      </div>
      <div class="mlist">${rows || `<p class="mmuted">${this.busy ? esc2(working ? `${working}…` : 'Reading your models…') : 'No downloaded chat models found.'}</p>`}</div>
      <h3>Get more models</h3>
      <div class="mcard">
        <div class="mrow-main"><div class="mrow-name">Browse and download</div>
        <div class="mrow-meta">Search Hugging Face in the in-app browser, then run <code>lms get &lt;model&gt;</code> in a terminal. ezCLI never downloads a model for you.</div></div>
        <button class="btn" data-hf>Search models</button>
      </div>`;
    body.querySelectorAll('button').forEach((b) => (b.disabled = this.busy));
  },

  open() {
    if (!this.dlg) this.build();
    this.dlg.showModal();
    this.refresh();
  },

  build() {
    const d = document.createElement('dialog');
    d.className = 'sheet wide models-sheet';
    d.innerHTML = '<div class="models-head"><h2>Local models</h2><button class="btn" data-close>Done</button></div><div class="models-body"></div>';
    document.body.appendChild(d);
    this.dlg = d;
    d.addEventListener('click', (e) => {
      const t = e.target.closest('button,select');
      if (!t) return;
      if (t.hasAttribute('data-close')) return d.close();
      if (t.hasAttribute('data-refresh')) return this.refresh();
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
    b.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="4" width="16" height="6" rx="1.5" /><rect x="4" y="14" width="16" height="6" rx="1.5" /><path d="M8 7h.01M8 17h.01" /></svg><span class="rail-label">Models</span>';
    anchor.before(b);
    b.addEventListener('click', () => Models.open());
  }
});

registerCommand({ group: 'App', label: 'Local models: downloaded, loaded, server', run: () => Models.open() });
