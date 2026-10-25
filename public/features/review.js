'use strict';
/* What the agent changed, at a glance.
 *
 * A pill in the session header shows the live count of changed files and lines ("3 files +42 -7")
 * for the project's git repository. Click it for the file list; click a file to open its diff in
 * the explorer. It refreshes when the agent goes quiet and while it is working, using the same
 * git status the explorer already reads. Nothing is staged, committed or sent anywhere. */

const Review = {
  pill: null,
  pop: null,
  busyAt: 0,

  mount() {
    const title = $('headTitle');
    if (!title || this.pill) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'headChanges';
    b.className = 'head-changes';
    b.hidden = true;
    b.setAttribute('aria-haspopup', 'dialog');
    b.addEventListener('click', () => this.toggle());
    title.after(b);
    this.pill = b;
  },

  data() {
    const sp = space();
    const g = sp && state.git[sp.path];
    if (!g || !g.repo || !g.files || !g.files.length) return null;
    let add = 0;
    let del = 0;
    for (const f of g.files) {
      add += f.added || 0;
      del += f.removed || 0;
    }
    return { files: g.files, add, del, root: g.root, branch: g.branch };
  },

  render() {
    if (!this.pill) return;
    const d = this.data();
    const s = active();
    if (!d || !s) {
      this.pill.hidden = true;
      this.close();
      return;
    }
    this.pill.hidden = false;
    const n = d.files.length;
    this.pill.innerHTML = `<span class="hc-files">${n} file${n === 1 ? '' : 's'}</span>${d.add ? `<span class="hc-add">+${d.add}</span>` : ''}${d.del ? `<span class="hc-del">-${d.del}</span>` : ''}`;
    this.pill.title = `${n} changed file${n === 1 ? '' : 's'} in ${d.branch || 'this project'}. Click to review.`;
    if (this.pop) this.drawPop();
  },

  kind(f) {
    return typeof changeKind === 'function' ? changeKind(f) : ['M', 'modified'];
  },

  drawPop() {
    const d = this.data();
    if (!d) return this.close();
    const rows = d.files
      .slice(0, 40)
      .map((f, i) => {
        const [letter, cls] = this.kind(f);
        const name = f.file.split('/').pop();
        const dir = f.file.slice(0, f.file.length - name.length);
        const nums = f.untracked && f.added == null ? '<em>new</em>' : `${f.added ? `<span class="hc-add">+${f.added}</span>` : ''}${f.removed ? `<span class="hc-del">-${f.removed}</span>` : ''}`;
        return `<button type="button" class="rv-row" data-i="${i}" title="${esc(f.file)}"><span class="rv-k ${cls}">${letter}</span><span class="rv-name"><b>${esc(name)}</b>${dir ? `<i>${esc(dir)}</i>` : ''}</span><span class="rv-nums">${nums}</span></button>`;
      })
      .join('');
    const more = d.files.length > 40 ? `<p class="meter-note">and ${d.files.length - 40} more in the explorer.</p>` : '';
    this.pop.innerHTML = `<div class="pop-title"><b>Changes</b><span>${esc(d.branch || '')}</span><span class="rv-total"><span class="hc-add">+${d.add}</span> <span class="hc-del">-${d.del}</span></span></div>
      <div class="rv-list">${rows}</div>${more}
      <button type="button" class="pop-link" data-all>Review in the explorer</button>`;
  },

  toggle() {
    if (this.pop) return this.close();
    const pop = document.createElement('div');
    pop.className = 'usage-pop review-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Changed files');
    document.body.append(pop);
    this.pop = pop;
    this.drawPop();
    const r = this.pill.getBoundingClientRect();
    pop.style.width = '380px';
    pop.style.left = `${Math.max(12, Math.min(innerWidth - 392, r.left))}px`;
    pop.style.top = `${r.bottom + 8}px`;
    pop.style.bottom = 'auto';
    this.pill.setAttribute('aria-expanded', 'true');
    pop.addEventListener('click', (e) => {
      const row = e.target.closest('.rv-row');
      if (row) return this.open(Number(row.dataset.i));
      if (e.target.closest('[data-all]')) return this.open(-1);
    });
  },

  close() {
    if (this.pop) this.pop.remove();
    this.pop = null;
    if (this.pill) this.pill.setAttribute('aria-expanded', 'false');
  },

  /** Open the explorer on the Changes tab, on one file's diff when `i` is a file. */
  open(i) {
    const d = this.data();
    this.close();
    if (!d) return;
    setExplorerOpen(true);
    prefs.explorerTab = 'changes';
    const tab = document.querySelector('[data-xtab="changes"]');
    if (tab) tab.click();
    if (i >= 0 && d.files[i]) {
      state.explorer.view = 'diff';
      state.explorer.diff = { file: d.files[i].file, untracked: Boolean(d.files[i].untracked) };
      renderExplorer();
    }
  },

  /** Ask git again, at most every few seconds. */
  async poll(force) {
    const now = Date.now();
    if (!force && now - this.busyAt < 4000) return;
    this.busyAt = now;
    try {
      await refreshGit();
    } catch {
      /* the next poll will try again */
    }
    this.render();
  }
};

hooks.boot.push(() => {
  Review.mount();
  Review.render();
});
hooks.view.push(() => {
  Review.render();
  Review.poll(true);
});
hooks.idle.push(() => Review.poll(true));
hooks.tabs.push(() => Review.render());
setInterval(() => {
  const s = active();
  if (s && s.status === 'running' && s.working) Review.poll(false);
  else Review.render();
}, 5000);

document.addEventListener('mousedown', (e) => {
  if (Review.pop && !Review.pop.contains(e.target) && !(Review.pill && Review.pill.contains(e.target))) Review.close();
});
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && Review.pop) {
      e.stopPropagation();
      Review.close();
    }
  },
  true
);
