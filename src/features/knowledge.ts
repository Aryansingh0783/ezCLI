import { T, active, hooks, invoke, prefs, savePrefs, toast } from '../app';
import { WebSearch } from './websearch';
import { late } from '../late';
import { setKV } from '../core/html';
/* Knowledge for local models (RAG). You add folders or files; the app indexes their text on this PC
 * (src-tauri/src/rag.rs, word-statistics search, no model download). When you ask a question, the best
 * matching passages are sent to the model together with it, and the model may also ask for more with
 *
 *   KNOW: <query>   search the files you added
 *
 * It works for every local runner (llama.cpp, LM Studio, Ollama) because it only changes the text sent.
 * Only folders and files you pick here are read. The "Knowledge" button opens the list. */

export const Knowledge = {
  sources: [],
  panel: null,

  get files() {
    return this.sources.length;
  },

  mode() {
    return prefs.kbMode === 'off' ? 'off' : 'on';
  },

  /** Passages are added to a question only when there are files and the switch is on. */
  usable() {
    return this.files > 0 && this.mode() === 'on';
  },

  async refresh() {
    this.loaded = true;
    try {
      const list = await invoke('rag_sources');
      this.sources = Array.isArray(list) ? list : [];
    } catch {
      this.sources = [];
    }
    this.sync();
    if (this.panel) this.render();
  },

  name(path) {
    return String(path).split(/[\\/]/).filter(Boolean).pop() || String(path);
  },

  /** Passages as one block of text for the model, or '' when nothing matched. */
  format(hits) {
    if (!hits || !hits.length) return '';
    const items = hits.map((h, i) => `(${i + 1}) ${this.name(h.source)} - ${h.source} - ${String(h.text).replace(/\s*\n\s*/g, ' ')}`);
    return `[Knowledge from the user's own files (${hits.length} passage${hits.length === 1 ? '' : 's'}). ${items.join(' ')} Use these when they answer the question and name the file each fact came from. If they do not contain the answer, say so instead of guessing.]`;
  },

  async search(query, limit) {
    try {
      return await invoke('rag_search', { query: String(query).slice(0, 400), limit: limit || 4 });
    } catch {
      return [];
    }
  },

  /** What to add after a question. */
  async block(question) {
    if (!this.usable() || question.length < 4 || WebSearch.SMALLTALK.test(question)) return '';
    const hits = await this.search(question, 4);
    return this.format(hits);
  },

  /** The model asked `KNOW: <query>`: the answer message, and a short note for the chat. */
  async lookup(query) {
    const hits = await this.search(query, 5);
    const block = this.format(hits);
    const msg = block
      ? `Here are passages from my files for "${query}". ${block} Now answer my earlier question using only what these passages say.`
      : `My files have nothing about "${query}". Answer my earlier question as well as you can, and say that my files did not cover it.`;
    const note = hits.length ? `Searched your files for “${query}”` : `Your files had nothing for “${query}”`;
    return { msg, note, detail: hits.map((h, i) => `${i + 1}. ${h.source}`).join('\n') };
  },

  async pick(directory) {
    let chosen;
    try {
      const options = { directory, multiple: false, title: directory ? 'Folder to add to Knowledge' : 'File to add to Knowledge' };
      chosen = T.dialog && T.dialog.open ? await T.dialog.open(options) : await invoke('plugin:dialog|open', { options });
    } catch {
      chosen = window.prompt(directory ? 'Full path of the folder to add:' : 'Full path of the file to add:', '');
    }
    const path = Array.isArray(chosen) ? chosen[0] : chosen;
    if (!path) return;
    toast('Indexing… this runs on your PC and can take a moment for big folders.');
    try {
      const r = await invoke('rag_add', { path });
      toast(r.files ? `Added ${r.files} file${r.files === 1 ? '' : 's'} (${r.passages} passages)${r.skipped ? `, ${r.skipped} skipped` : ''}.${r.note ? ` ${r.note}` : ''}` : r.note || 'Nothing was added.', r.files ? '' : 'error');
    } catch (e) {
      toast(String(e), 'error');
    }
    await this.refresh();
  },

  async remove(path) {
    try {
      await invoke('rag_remove', { path });
    } catch (e) {
      toast(String(e), 'error');
    }
    await this.refresh();
  },

  async clear() {
    if (!window.confirm('Remove every file from Knowledge? Your files are not touched; only the index is emptied.')) return;
    try {
      await invoke('rag_clear');
    } catch (e) {
      toast(String(e), 'error');
    }
    await this.refresh();
  },

  /* ----------------------------------------------------------- the button and its list */

  sync() {
    const s = active();
    let b = document.getElementById('btnKb');
    if (!WebSearch.applies(s)) {
      if (b) b.hidden = true;
      return;
    }
    // the list is read at boot; if that ran before this file loaded, read it now
    if (!this.loaded) {
      this.loaded = true;
      this.refresh();
    }
    const grow = document.querySelector('#ptyComposer .composer-row .grow');
    if (!grow) return;
    if (!b) {
      b = document.createElement('button');
      b.type = 'button';
      b.id = 'btnKb';
      b.className = 'web-btn';
      b.addEventListener('click', () => this.toggle());
      grow.before(b);
    }
    b.hidden = false;
    const on = this.usable();
    b.dataset.mode = on ? 'auto' : 'off';
    setKV(b, this.files ? `Knowledge: ${this.mode() === 'on' ? (this.files === 1 ? '1 source' : `${this.files} sources`) : 'off'}` : 'Knowledge: none');
    b.title = 'Let the model answer from your own files. Click to add folders and files, see what is indexed, or turn it off.';
  },

  toggle() {
    if (this.panel) this.close();
    else this.open();
  },

  close() {
    if (!this.panel) return;
    this.panel.remove();
    this.panel = null;
    document.removeEventListener('mousedown', this.outside, true);
    document.removeEventListener('keydown', this.escape, true);
  },

  open() {
    const panel = document.createElement('div');
    panel.id = 'kbPanel';
    panel.className = 'kb-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Knowledge');
    document.body.appendChild(panel);
    this.panel = panel;
    this.outside = (e) => {
      const btn = document.getElementById('btnKb');
      if (!panel.contains(e.target) && !(btn && btn.contains(e.target))) this.close();
    };
    this.escape = (e) => {
      if (e.key === 'Escape') this.close();
    };
    document.addEventListener('mousedown', this.outside, true);
    document.addEventListener('keydown', this.escape, true);
    this.render();
    this.refresh();
  },

  render() {
    const p = this.panel;
    if (!p) return;
    const el = (tag, cls, text?) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };
    const button = (label, fn, title?) => {
      const b = el('button', 'kb-btn', label);
      b.type = 'button';
      if (title) b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    p.textContent = '';
    p.appendChild(el('div', 'kb-title', 'Knowledge'));
    p.appendChild(el('p', 'kb-help', 'Add folders or files. When you ask a question, the best matching passages are sent to the model with it, so it can answer from your own material. The index stays on this PC.'));
    const row = el('div', 'kb-row');
    row.appendChild(button('Add folder', () => this.pick(true)));
    row.appendChild(button('Add file', () => this.pick(false)));
    row.appendChild(
      button(
        this.mode() === 'on' ? 'Turn off' : 'Turn on',
        () => {
          prefs.kbMode = this.mode() === 'on' ? 'off' : 'on';
          savePrefs();
          this.sync();
          this.render();
        },
        'Off keeps the index but stops sending passages.'
      )
    );
    p.appendChild(row);
    const list = el('div', 'kb-list');
    if (!this.sources.length) list.appendChild(el('div', 'kb-empty', 'Nothing added yet. Text, code, markdown, csv and json files work.'));
    for (const src of this.sources.slice(0, 200)) {
      const item = el('div', 'kb-item');
      const label = el('span', 'kb-path', this.name(src.path));
      label.title = `${src.path} (${src.passages} passages)`;
      item.appendChild(label);
      item.appendChild(button('Remove', () => this.remove(src.path), 'Forget this file. The file itself is not touched.'));
      list.appendChild(item);
    }
    if (this.sources.length > 200) list.appendChild(el('div', 'kb-empty', `…and ${this.sources.length - 200} more`));
    p.appendChild(list);
    if (this.sources.length) p.appendChild(button('Remove all', () => this.clear()));
  }
};

hooks.tabs.push(() => Knowledge.sync());
hooks.view.push(() => Knowledge.sync());
hooks.boot.push(() => Knowledge.refresh());

Object.assign(late, { Knowledge });
