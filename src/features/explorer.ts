import { $, ICONS, active, addToChat, basename, esc, fitActive, fmtSize, invoke, prefs, relativeTo, renderHead, savePrefs, space, state, toast } from '../app';

/* The explorer pane: project files, git changes and the file viewer, docked
 * to the right of the session. Split out of app.ts; behaviour is unchanged. */
/* --------------------------------------------------------------- explorer */

export function setExplorerOpen(open, { quiet = false } = {}) {
  prefs.explorerOpen = open;
  savePrefs();
  $('explorer').hidden = !open;
  $('explorerToggle').classList.toggle('on', open);
  document.querySelector('.main').classList.toggle('explorer-docked', open);
  if (open && !quiet) renderExplorer(true);
  if (open && quiet) renderExplorer(true);
  requestAnimationFrame(fitActive);
}

/** The explorer never takes more than the window can spare: the session keeps at least 320px,
 *  so the explorer cannot cover the composer when the window is narrow or the sidebar is open. */
export function applyExplorerWidth() {
  const main = document.querySelector('.main');
  const room = main.clientWidth - 320;
  const width = Math.max(260, Math.min(prefs.explorerWidth, room));
  main.style.setProperty('--explorer-width', `${Math.round(width)}px`);
}
window.addEventListener('resize', () => applyExplorerWidth());
{
  let last = 0;
  new ResizeObserver(() => {
    const w = document.querySelector('.main').clientWidth;
    if (Math.abs(w - last) > 1) {
      last = w;
      applyExplorerWidth();
    }
  }).observe(document.querySelector('.main'));
}

export function explorerRoot() {
  const s = active();
  return s ? s.cwd : space() ? space().path : state.homeCwd;
}

export function renderExplorer(reset = false) {
  if (!prefs.explorerOpen) return;
  const ex = state.explorer;
  const root = explorerRoot();
  if (reset || ex.root !== root) {
    if (ex.root !== root) {
      ex.expanded = new Set();
      ex.cache = new Map();
      ex.filter = '';
    }
    ex.root = root;
    ex.view = 'list';
  }
  document.querySelectorAll('[data-xtab]').forEach((t) => t.classList.toggle('active', t.dataset.xtab === prefs.explorerTab));
  if (ex.view === 'file') return renderFileView();
  if (ex.view === 'diff') return renderDiffView();
  if (prefs.explorerTab === 'files') renderFiles();
  else renderChanges();
}

async function loadDir(path) {
  const ex = state.explorer;
  if (ex.cache.has(path)) return ex.cache.get(path);
  const data = await invoke('list_dir', { path });
  ex.cache.set(path, data.entries);
  return data.entries;
}

const NOISE = new Set(['.git', 'node_modules', 'target', '.next', 'dist', '__pycache__', '.venv']);

async function renderFiles() {
  const ex = state.explorer;
  const box = $('explorerContent');
  if (!box.querySelector('.files-search')) {
    box.innerHTML = `<div class="files-toolbar"><input class="files-search" id="fileFilter" placeholder="Filter files" aria-label="Filter files" /></div>
      <div class="crumbs" id="fileCrumbs"></div><ul class="explorer-list" id="fileList"><li class="explorer-empty">Loading files…</li></ul>`;
    const f = $('fileFilter');
    f.value = ex.filter;
    f.addEventListener('input', () => {
      ex.filter = f.value;
      drawFileRows();
    });
  }
  $('fileCrumbs').textContent = ex.root;
  try {
    await loadDir(ex.root);
    for (const d of ex.expanded) await loadDir(d).catch(() => ex.expanded.delete(d));
  } catch (err) {
    $('fileList').innerHTML = `<li class="explorer-empty"><b>Couldn’t list files</b>${esc(String(err))}</li>`;
    return;
  }
  drawFileRows();
}

function drawFileRows() {
  const ex = state.explorer;
  const list = $('fileList');
  if (!list) return;
  const rows = [];
  const q = ex.filter.trim().toLowerCase();
  if (q) {
    // Search everything loaded so far (the root plus expanded folders).
    for (const [, entries] of ex.cache) {
      for (const e of entries) if (e.name.toLowerCase().includes(q)) rows.push({ e, depth: 0, rel: relativeTo(e.path, ex.root) });
    }
    rows.sort((a, b) => a.rel.localeCompare(b.rel));
  } else {
    const walk = (dir, depth) => {
      for (const e of ex.cache.get(dir) || []) {
        rows.push({ e, depth });
        if (e.dir && ex.expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    walk(ex.root, 0);
  }
  if (!rows.length) {
    list.innerHTML = `<li class="explorer-empty">${q ? 'No loaded files match. Expand folders to search inside them.' : 'Empty folder.'}</li>`;
    return;
  }
  list.innerHTML = rows
    .slice(0, 3000)
    .map(({ e, depth, rel }) => {
      const open = e.dir && ex.expanded.has(e.path);
      const name = rel
        ? `<span class="dir-part">${esc(rel.slice(0, rel.length - e.name.length))}</span>${esc(e.name)}`
        : esc(e.name);
      return `<li><button class="file-row ${open ? 'open' : ''}" style="--depth:${depth}" data-path="${esc(e.path)}" data-dir="${e.dir ? 1 : 0}">
        <span class="twisty">${e.dir ? ICONS.twisty : ''}</span>
        <span class="ico">${e.dir ? ICONS.folder : ICONS.file}</span>
        <span class="name ${NOISE.has(e.name) ? 'dir-part' : ''}">${name}</span>
        ${e.dir ? '' : `<span class="meta">${fmtSize(e.size)}</span>`}</button></li>`;
    })
    .join('');
}

export async function toggleDir(path) {
  const ex = state.explorer;
  if (ex.expanded.has(path)) ex.expanded.delete(path);
  else {
    try {
      await loadDir(path);
      ex.expanded.add(path);
    } catch (err) {
      return toast(String(err), 'error');
    }
  }
  drawFileRows();
}

async function renderFileView() {
  const ex = state.explorer;
  const box = $('explorerContent');
  box.innerHTML = viewerHead(ex.file, true) + '<pre class="code-view numbered" id="codeView"><span class="ln">Loading file…</span></pre>';
  wireViewerHead(ex.file);
  let data;
  try {
    data = await invoke('read_file', { path: ex.file });
  } catch (err) {
    $('codeView').innerHTML = `<span class="ln">Couldn’t open this file: ${esc(String(err))}</span>`;
    return;
  }
  if (data.binary) {
    $('codeView').classList.remove('numbered');
    $('codeView').innerHTML = '<span class="ln">Binary file.</span>';
    return;
  }
  const lines = data.text.split('\n');
  $('codeView').innerHTML = lines.map((l) => `<span class="ln">${esc(l) || ' '}</span>`).join('');
  if (data.truncated) box.insertAdjacentHTML('beforeend', `<div class="code-note">Showing the first 256 KB of ${fmtSize(data.size)}.</div>`);
}

function viewerHead(path, canAdd) {
  return `<div class="viewer-head">
    <button class="head-icon" id="viewerBack" aria-label="Back">${ICONS.back}</button>
    <span class="path" title="${esc(path)}">${esc(relativeTo(path, state.explorer.root))}</span>
    ${canAdd ? '<button class="btn" id="viewerAdd" title="Mention this file in your next message">Add to chat</button>' : ''}
  </div>`;
}
function wireViewerHead(path) {
  $('viewerBack').addEventListener('click', () => {
    state.explorer.view = 'list';
    renderExplorer();
  });
  const add = $('viewerAdd');
  if (add) add.addEventListener('click', () => addToChat(path));
}

export async function refreshGit() {
  const sp = space();
  if (!sp) return;
  let g;
  try {
    g = await invoke('git_status', { path: active() ? active().cwd : sp.path });
  } catch {
    g = { repo: false, reason: 'Could not run git.' };
  }
  state.git[sp.path] = g;
  const n = g.repo ? g.files.length : 0;
  $('changesCount').hidden = !n;
  $('changesCount').textContent = n;
  $('explorerDot').hidden = !n || prefs.explorerOpen;
  renderHead();
  if (prefs.explorerOpen && prefs.explorerTab === 'changes' && state.explorer.view === 'list') renderChanges(true);
}

export function changeKind(f) {
  if (f.untracked) return ['U', 'added'];
  const c = f.code.trim();
  if (c.includes('D')) return ['D', 'deleted'];
  if (c.includes('A')) return ['A', 'added'];
  if (c.includes('R')) return ['R', 'modified'];
  return ['M', 'modified'];
}

export async function renderChanges(fromCache = false) {
  const box = $('explorerContent');
  const sp = space();
  if (!fromCache) {
    box.innerHTML = '<div class="explorer-empty">Loading changes…</div>';
    await refreshGit();
    return;
  }
  const g = state.git[sp.path];
  if (!g) return;
  if (!g.repo) {
    box.innerHTML = `<div class="explorer-empty"><b>No repository</b>${esc(g.reason || 'This folder is not a git repository.')}</div>`;
    return;
  }
  if (!g.files.length) {
    box.innerHTML = `<div class="crumbs">${esc(g.branch)} · ${esc(g.root)}</div><div class="explorer-empty"><b>No changes</b>Working tree clean.</div>`;
    return;
  }
  const add = g.files.reduce((n, f) => n + (f.added || 0), 0);
  const del = g.files.reduce((n, f) => n + (f.removed || 0), 0);
  box.innerHTML = `<div class="files-toolbar"><span class="head-branch">${ICONS.branch}${esc(g.branch)}</span><span class="grow"></span>
      <span class="meta">${g.files.length} change${g.files.length > 1 ? 's' : ''} · <span class="num-add">+${add}</span> <span class="num-del">−${del}</span></span></div>
    <ul class="explorer-list">${g.files
      .map((f) => {
        const [code, kind] = changeKind(f);
        // An untracked folder arrives once, as "path/to/folder/".
        const name = basename(f.file) + (f.file.endsWith('/') ? '/' : '');
        const dir = f.file.slice(0, f.file.length - name.length);
        const nums =
          f.added != null ? `<span class="meta"><span class="num-add">+${f.added}</span> <span class="num-del">−${f.removed}</span></span>` : '';
        return `<li><button class="file-row" data-file="${esc(f.file)}" data-untracked="${f.untracked ? 1 : 0}" title="${esc(f.file)}">
          <span class="change-status ${kind}">${code}</span>
          <span class="name"><span class="dir-part">${esc(dir)}</span>${esc(name)}</span>${nums}</button></li>`;
      })
      .join('')}</ul>`;
}

async function renderDiffView() {
  const ex = state.explorer;
  const g = state.git[space().path];
  const abs = g && g.root ? `${g.root}/${ex.diff.file}` : ex.diff.file;
  const box = $('explorerContent');
  box.innerHTML = viewerHead(abs, true) + '<pre class="code-view" id="codeView"><span class="ln">Loading diff…</span></pre>';
  wireViewerHead(abs);
  let data;
  try {
    data = await invoke('git_diff', { path: g ? g.root : explorerRoot(), file: ex.diff.file, untracked: ex.diff.untracked });
  } catch (err) {
    $('codeView').innerHTML = `<span class="ln">${esc(String(err))}</span>`;
    return;
  }
  if (!data.diff) {
    $('codeView').innerHTML = `<span class="ln">${esc(data.note || 'No changes to show.')}</span>`;
    return;
  }
  $('codeView').innerHTML = data.diff
    .split('\n')
    .map((line) => {
      let cls = '';
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) cls = 'd-meta';
      else if (line.startsWith('+')) cls = 'd-add';
      else if (line.startsWith('-')) cls = 'd-del';
      else if (line.startsWith('@@')) cls = 'd-hunk';
      return `<span class="ln ${cls}">${esc(line) || ' '}</span>`;
    })
    .join('');
}

export function startExplorerResize(e) {
  e.preventDefault();
  const main = document.querySelector('.main');
  const rect = main.getBoundingClientRect();
  document.body.classList.add('resizing-pane');
  let raf = 0;
  const move = (ev) => {
    const w = Math.round(Math.min(Math.max(rect.right - ev.clientX, 260), rect.width - 320));
    prefs.explorerWidth = w;
    applyExplorerWidth();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(fitActive);
  };
  const up = () => {
    document.body.classList.remove('resizing-pane');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    savePrefs();
    fitActive();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}


/** Lets a feature module wrap or replace `renderChanges` (ES imports are read-only). */
export function __set_renderChanges(value) {
  // @ts-expect-error A function declaration can be reassigned at run time; this is how a feature wraps a core function.
  renderChanges = value;
  return value;
}
