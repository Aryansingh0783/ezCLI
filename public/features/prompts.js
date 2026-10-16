'use strict';
/* Prompt library: saved prompts with {{variables}}.
 *
 * Prompts live in preferences next to the history. Choosing one fills any
 * {{name}} placeholders through a short form, then puts the text in the
 * composer (or the home box) for review. Nothing is sent automatically. */

const DEFAULT_PROMPTS = [
  { id: 'review', title: 'Review my changes', body: 'Review my uncommitted changes. List bugs, risky edits and anything I forgot, most serious first.' },
  { id: 'explain', title: 'Explain a file', body: 'Explain what {{file}} does, how it fits into this project, and where to start reading.' },
  { id: 'tests', title: 'Write tests for', body: 'Write tests for {{target}}. Cover the main path and the edge cases you think are most likely to break.' },
  { id: 'fix', title: 'Fix this error', body: 'I get this error:\n\n{{error}}\n\nFind the cause in this project and fix it. Explain the fix in two sentences.' },
  { id: 'commit', title: 'Write a commit message', body: 'Write a concise commit message for the staged changes. Subject under 60 characters, then a short body.' }
];

const Prompts = (() => {
  const list = () => (prefs.prompts ||= DEFAULT_PROMPTS.map((p) => ({ ...p })));
  const vars = (body) => [...new Set([...String(body).matchAll(/\{\{\s*([\w .-]{1,40}?)\s*\}\}/g)].map((m) => m[1]))];
  let sheet = null;
  let editing = null;

  function target() {
    return active() ? $('ptyInput') : $('homeInput');
  }

  function insert(text) {
    const el = target();
    el.value = el.value.trim() ? `${el.value.trimEnd()}\n${text}` : text;
    autoGrow(el);
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  /** Ask for each {{variable}}, then insert the filled prompt. */
  function use(p) {
    const names = vars(p.body);
    if (!names.length) return insert(p.body);
    const d = document.createElement('dialog');
    d.className = 'sheet prompt-fill';
    d.innerHTML = `<h2>${esc(p.title)}</h2>
      <form method="dialog" class="prompt-fill-form">
        ${names.map((n, i) => `<label class="field"><span>${esc(n)}</span><textarea rows="${/error|text|code/i.test(n) ? 4 : 1}" data-var="${esc(n)}" ${i === 0 ? 'autofocus' : ''}></textarea></label>`).join('')}
        <div class="row-actions end"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Insert</button></div>
      </form>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => {
      if (d.returnValue === 'ok') {
        let text = p.body;
        d.querySelectorAll('[data-var]').forEach((t) => {
          const re = new RegExp(`\\{\\{\\s*${t.dataset.var.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g');
          text = text.replace(re, t.value.trim());
        });
        insert(text);
      }
      d.remove();
    });
    d.showModal();
  }

  function menu(anchor) {
    openMenu(anchor, {
      title: 'Prompt library',
      search: list().length > 6 ? 'Search prompts' : '',
      empty: 'No saved prompts yet.',
      items: [
        ...list().map((p) => ({ label: p.title, hint: vars(p.body).length ? 'fills in ' + vars(p.body).join(', ') : '', run: () => use(p) })),
        { sep: true },
        { label: 'Manage prompts…', run: () => openSheet() },
        ...(target().value.trim() ? [{ label: 'Save current text as a prompt…', run: () => openSheet({ title: '', body: target().value.trim() }) }] : [])
      ]
    });
  }

  function renderSheet() {
    const box = sheet.querySelector('.prompt-list');
    box.innerHTML = list().length
      ? list()
          .map(
            (p, i) => `<li class="${editing && editing.id === p.id ? 'on' : ''}"><button class="prompt-row" data-edit="${i}">
              <strong>${esc(p.title)}</strong><span>${esc(p.body.replace(/\s+/g, ' ').slice(0, 110))}</span></button></li>`
          )
          .join('')
      : '<li class="note">No saved prompts. Add one on the right.</li>';
    const f = sheet.querySelector('.prompt-edit');
    f.title.value = editing ? editing.title : '';
    f.body.value = editing ? editing.body : '';
    f.querySelector('[data-delete]').hidden = !(editing && editing.id);
    f.querySelector('.prompt-vars').textContent = editing && vars(editing.body).length
      ? `Fills in: ${vars(editing.body).join(', ')}`
      : 'Write {{name}} where a value should be asked for when you use the prompt.';
  }

  function openSheet(draft = null) {
    if (!sheet) {
      sheet = document.createElement('dialog');
      sheet.className = 'sheet wide prompt-sheet';
      sheet.setAttribute('aria-labelledby', 'promptSheetTitle');
      sheet.innerHTML = `<h2 id="promptSheetTitle">Prompt library</h2>
        <div class="prompt-layout">
          <ul class="prompt-list" aria-label="Saved prompts"></ul>
          <form class="prompt-edit">
            <label class="field"><span>Title</span><input name="title" maxlength="80" required /></label>
            <label class="field"><span>Prompt</span><textarea name="body" rows="9" required></textarea></label>
            <p class="note prompt-vars"></p>
            <div class="row-actions">
              <button class="btn danger" type="button" data-delete>Delete</button>
              <span class="grow"></span>
              <button class="btn" type="button" data-new>New prompt</button>
              <button class="btn primary" type="submit">Save</button>
            </div>
          </form>
        </div>
        <form method="dialog" class="row-actions end"><button class="btn primary">Done</button></form>`;
      document.body.appendChild(sheet);
      const f = sheet.querySelector('.prompt-edit');
      sheet.querySelector('.prompt-list').addEventListener('click', (e) => {
        const b = e.target.closest('[data-edit]');
        if (!b) return;
        editing = list()[Number(b.dataset.edit)];
        renderSheet();
      });
      f.body.addEventListener('input', () => {
        f.querySelector('.prompt-vars').textContent = vars(f.body.value).length
          ? `Fills in: ${vars(f.body.value).join(', ')}`
          : 'Write {{name}} where a value should be asked for when you use the prompt.';
      });
      f.querySelector('[data-new]').addEventListener('click', () => {
        editing = null;
        renderSheet();
        f.title.focus();
      });
      f.querySelector('[data-delete]').addEventListener('click', () => {
        if (!editing) return;
        prefs.prompts = list().filter((p) => p.id !== editing.id);
        editing = null;
        savePrefs();
        renderSheet();
      });
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        const title = f.title.value.trim();
        const body = f.body.value.trim();
        if (!title || !body) return;
        if (editing && editing.id) {
          Object.assign(editing, { title, body });
        } else {
          editing = { id: `p${Date.now().toString(36)}`, title, body };
          list().push(editing);
        }
        savePrefs();
        renderSheet();
        toast(`Saved “${title}”`, 'ok');
      });
    }
    editing = draft ? { id: '', ...draft } : null;
    renderSheet();
    if (!sheet.open) sheet.showModal();
  }

  return { menu, openSheet, list, use, vars };
})();

ICONS.book = svg('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19a2 2 0 0 1 2-2h13"/>', 13);

hooks.boot.push(() => {
  const chip = document.createElement('button');
  chip.className = 'chip';
  chip.id = 'btnPrompts';
  chip.title = 'Prompt library (Ctrl+Alt+L)';
  chip.innerHTML = `${ICONS.book} Prompts`;
  chip.addEventListener('click', (e) => Prompts.menu(e.currentTarget));
  $('btnHistory').after(chip);

  const homeChip = document.createElement('button');
  homeChip.className = 'chip home-prompts';
  homeChip.title = 'Prompt library (Ctrl+Alt+L)';
  homeChip.innerHTML = `${ICONS.book} Prompts`;
  homeChip.addEventListener('click', (e) => Prompts.menu(e.currentTarget));
  document.querySelector('#homeComposer .send-key').before(homeChip);
});

hooks.shortcut.push((code) => {
  if (code !== 'KeyL') return false;
  Prompts.menu(active() ? $('btnPrompts') : document.querySelector('.home-prompts'));
  return true;
});

registerCommand({ group: 'Prompts', label: 'Prompt library…', keys: 'Ctrl Alt L', run: () => Prompts.openSheet() });
registerCommand({
  group: 'Prompts',
  label: 'Use a saved prompt…',
  run: () => Prompts.menu(active() ? $('btnPrompts') : document.querySelector('.home-prompts'))
});
