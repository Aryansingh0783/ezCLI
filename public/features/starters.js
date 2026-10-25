'use strict';
/* Starter prompts under the home message box.
 *
 * A few one-click ideas that fit the project you are in: if git shows uncommitted work the first
 * one offers to review it. Clicking a starter only fills the message box (it never sends), so you
 * can edit it first. They step aside as soon as you start typing. */

const Starters = {
  box: null,
  html: '',

  ideas() {
    const sp = space();
    const g = sp && state.git[sp.path];
    const n = g && g.repo && g.files ? g.files.length : 0;
    const list = [];
    if (n) {
      list.push({ label: `Review my ${n} uncommitted change${n === 1 ? '' : 's'}`, text: 'Review my uncommitted changes. Point out bugs, loose ends and anything I should fix before committing.' });
      list.push({ label: 'Write a commit message', text: 'Look at my uncommitted changes and write a clear commit message for them.' });
    }
    list.push({ label: 'Explain this project', text: 'Give me a short tour of this project: what it does, how it is laid out, and where to start reading.' });
    list.push({ label: 'Find likely bugs', text: 'Read through this project and list the most likely bugs or fragile spots, with the file and line for each.' });
    if (!n) list.push({ label: 'Add tests', text: 'Find the least tested part of this project and write tests for it.' });
    return list.slice(0, 4);
  },

  mount() {
    const note = $('homeRouteNotice');
    if (!note || this.box) return;
    const box = document.createElement('div');
    box.id = 'homeStarters';
    box.className = 'home-starters';
    box.setAttribute('aria-label', 'Ideas to start with');
    note.after(box);
    this.box = box;
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      const idea = this.ideas()[Number(b.dataset.i)];
      const input = $('homeInput');
      if (!idea || !input) return;
      input.value = idea.text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    const input = $('homeInput');
    if (input) input.addEventListener('input', () => this.sync());
  },

  render() {
    if (!this.box) return;
    const html = this.ideas()
      .map((x, i) => `<button type="button" class="starter" data-i="${i}">${esc(x.label)}</button>`)
      .join('');
    if (html !== this.html) {
      this.html = html;
      this.box.innerHTML = html;
    }
    this.sync();
  },

  sync() {
    const input = $('homeInput');
    if (this.box) this.box.classList.toggle('away', Boolean(input && input.value.trim()));
  }
};

hooks.boot.push(() => {
  Starters.mount();
  Starters.render();
});
hooks.view.push(() => Starters.render());
hooks.tabs.push(() => Starters.render());
setInterval(() => {
  if (document.documentElement.dataset.layout === 'calm' && !active()) Starters.render();
}, 6000);
