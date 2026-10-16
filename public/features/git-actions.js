'use strict';
/* Git actions in the Changes pane: stage, unstage, discard, commit.
 *
 * The core renders the list; this module adds a commit box above it and
 * per-row actions next to each file. Discarding asks first, because it
 * cannot be undone from ezCLI. */

const GitActions = (() => {
  ICONS.plusSmall = svg('<path d="M12 6v12M6 12h12"/>', 12, 2.2);
  ICONS.minusSmall = svg('<path d="M6 12h12"/>', 12, 2.2);
  ICONS.undo = svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', 12, 2);

  const repoPath = () => {
    const g = state.git[space() && space().path];
    return g && g.repo ? g.root : null;
  };
  const fileOf = (name) => {
    const g = state.git[space() && space().path];
    return g && g.files ? g.files.find((f) => f.file === name) : null;
  };
  // Porcelain XY: X is the index (staged), Y the working tree.
  const isStaged = (f) => !f.untracked && f.code[0] !== ' ' && f.code[0] !== '?';
  const hasUnstaged = (f) => f.untracked || (f.code[1] && f.code[1] !== ' ');

  function decorate() {
    const box = $('explorerContent');
    const list = box.querySelector('.explorer-list');
    const g = state.git[space() && space().path];
    if (!list || !g || !g.repo || !g.files) return;
    if (!box.querySelector('.commit-box')) {
      const staged = g.files.filter(isStaged).length;
      const form = document.createElement('form');
      form.className = 'commit-box';
      form.innerHTML = `<textarea rows="2" placeholder="Commit message" aria-label="Commit message"></textarea>
        <div class="commit-row">
          <span class="commit-count">${staged ? `${staged} staged` : 'Nothing staged'}</span>
          <span class="grow"></span>
          <button class="btn quiet" type="button" data-stage-all>Stage all</button>
          <button class="btn primary" type="submit">${staged ? 'Commit staged' : 'Commit all'}</button>
        </div>`;
      form.querySelector('textarea').value = state.commitDraft || '';
      form.querySelector('textarea').addEventListener('input', (e) => (state.commitDraft = e.target.value));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        commit(form, staged === 0);
      });
      form.querySelector('[data-stage-all]').addEventListener('click', stageAll);
      list.before(form);
    }
    for (const row of list.querySelectorAll('.file-row[data-file]')) {
      const f = fileOf(row.dataset.file);
      if (!f || row.parentElement.querySelector('.row-actions-inline')) continue;
      const acts = document.createElement('span');
      acts.className = 'row-actions-inline';
      const btn = (act, icon, label) => `<button data-git="${act}" title="${label}" aria-label="${label} ${esc(f.file)}">${icon}</button>`;
      acts.innerHTML =
        btn('discard', ICONS.undo, f.untracked ? 'Delete new file' : 'Discard changes') +
        (isStaged(f) ? btn('unstage', ICONS.minusSmall, 'Unstage') : '') +
        (hasUnstaged(f) ? btn('stage', ICONS.plusSmall, 'Stage') : '');
      acts.dataset.file = f.file;
      acts.dataset.untracked = f.untracked ? '1' : '0';
      if (isStaged(f)) row.classList.add('is-staged');
      row.after(acts);
    }
  }

  async function act(kind, file, untracked) {
    const path = repoPath();
    if (!path) return;
    try {
      if (kind === 'stage') await invoke('git_stage', { path, file });
      else if (kind === 'unstage') await invoke('git_unstage', { path, file });
      else if (kind === 'discard') {
        const ok = await confirmDialog(
          untracked ? `Delete ${basename(file)}?` : `Discard changes to ${basename(file)}?`,
          untracked
            ? 'This new file has never been committed. Deleting it cannot be undone.'
            : 'The file goes back to its last committed version. Your edits are lost and cannot be recovered from ezCLI.',
          untracked ? 'Delete' : 'Discard'
        );
        if (!ok) return;
        await invoke('git_discard', { path, file, untracked });
      }
    } catch (err) {
      toast(String(err), 'error');
    }
    await refreshGit();
    if (prefs.explorerTab === 'changes' && state.explorer.view === 'list') renderChanges(true);
  }

  async function stageAll() {
    const path = repoPath();
    const g = state.git[space().path];
    if (!path || !g) return;
    for (const f of g.files.filter(hasUnstaged)) {
      try {
        await invoke('git_stage', { path, file: f.file });
      } catch (err) {
        toast(String(err), 'error');
        break;
      }
    }
    await refreshGit();
    renderChanges(true);
  }

  async function commit(form, all) {
    const path = repoPath();
    const message = form.querySelector('textarea').value;
    if (!message.trim()) {
      form.querySelector('textarea').focus();
      return toast('Write a commit message first.');
    }
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const head = await invoke('git_commit', { path, message, all });
      state.commitDraft = '';
      toast(`Committed ${head}`, 'ok');
    } catch (err) {
      toast(String(err), 'error');
    }
    submit.disabled = false;
    await refreshGit();
    renderChanges(true);
  }

  return { decorate, act };
})();

{
  const original = renderChanges;
  // eslint-disable-next-line no-global-assign
  renderChanges = async function (...args) {
    const r = await original(...args);
    GitActions.decorate();
    return r;
  };
}

hooks.boot.push(() => {
  // Capture phase, so an action never also opens the diff underneath it.
  $('explorerContent').addEventListener(
    'click',
    (e) => {
      const b = e.target.closest('[data-git]');
      if (!b) return;
      e.stopPropagation();
      const wrap = b.closest('.row-actions-inline');
      GitActions.act(b.dataset.git, wrap.dataset.file, wrap.dataset.untracked === '1');
    },
    true
  );
});

registerCommand({
  group: 'Workspace',
  label: 'Commit changes…',
  run: () => {
    setExplorerOpen(true);
    document.querySelector('[data-xtab="changes"]').click();
    setTimeout(() => {
      const t = document.querySelector('.commit-box textarea');
      if (t) t.focus();
    }, 400);
  }
});
