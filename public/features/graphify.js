'use strict';
/* Graphify (third-party): install it, add its skill to every installed agent
 * that supports it, build a project's graph, and open it. Every command is
 * chosen by the backend from a fixed list and shown here before it runs. */

const Graphify = {
  busy: false,
  autoSeen: new Set(),

  // Project folders ezCLI knows about; the backend keeps only those with a graph.
  projectPaths() {
    return [...new Set([...(prefs.spaces || []).map((x) => x.path), ...state.sessions.map((x) => x.cwd)].filter(Boolean))];
  },

  // Once per folder per app run: build (or refresh) its graph in the background,
  // then fold it into the second brain. Never installs anything by itself.
  async auto(cwd) {
    if (!cwd || prefs.graphAuto === false || this.autoSeen.has(cwd)) return;
    this.autoSeen.add(cwd);
    try {
      const r = await invoke('graphify_auto', { cwd });
      if (r === 'built') {
        toast('Project graph updated.');
        await Brain.update(true);
      }
    } catch {
      /* best effort; the manual buttons report errors */
    }
  },

  folder() {
    const s = active();
    return (s && s.cwd) || space()?.path || null;
  },

  async refresh() {
    const el = $('graphifyStatus');
    if (!el) return;
    let st;
    try {
      st = await invoke('graphify_status', { cwd: this.folder() });
    } catch (e) {
      el.textContent = `Couldn't check Graphify: ${e}`;
      return;
    }
    const where = this.folder();
    el.textContent = !st.installed
      ? st.installer
        ? 'Not installed yet.'
        : 'Not installed. Graphify needs Python — install uv or Python 3 first.'
      : `Installed. ${st.agents.length ? `Can be added to: ${st.agents.join(', ')}.` : 'No installed agent supports it.'} ${
          where ? (st.graphHtml ? 'This project has a graph.' : 'This project has no graph yet.') : 'Open a project folder to build a graph.'
        }`;
    $('graphifyInstall').hidden = st.installed || !st.installer;
    $('graphifySetup').disabled = !st.installed || !st.agents.length;
    $('graphifyBuild').disabled = !st.installed || !where;
    $('graphifyOpen').disabled = !st.graphHtml;
  },

  async run(action, title, why) {
    if (this.busy) return;
    let cmd;
    try {
      cmd = await invoke('graphify_plan', { action, cwd: this.folder() });
    } catch (e) {
      toast(String(e), 'error');
      return;
    }
    const where = action === 'build' ? ` in ${this.folder()}` : action === 'setup' ? ' (from a temporary folder, so your projects are untouched)' : '';
    if (!(await confirmDialog(title, `${why}\n\nezCLI will run${where}:\n${cmd}`, 'Run it'))) return;
    const log = $('graphifyLog');
    log.hidden = false;
    log.textContent = `> ${cmd}\nRunning… this can take a minute on a large project.\n`;
    this.busy = true;
    for (const id of ['graphifyInstall', 'graphifySetup', 'graphifyBuild']) $(id).disabled = true;
    $('graphifyStatus').textContent = `Running: ${title}…`;
    log.scrollIntoView({ block: 'center' });
    const unlisten = await listen('install-out:graphify', (e) => {
      log.textContent += e.payload;
      log.scrollTop = log.scrollHeight;
    });
    try {
      const done = await invoke('graphify_run', { action, cwd: this.folder() });
      if (done.outputTail && !log.textContent.includes(done.outputTail.trim().slice(-200))) log.textContent += `\n${done.outputTail}`;
      const ok = done.code === 0 && !done.cancelled && !done.timedOut;
      log.textContent += ok ? '\n✓ Done.' : `\n✗ Finished with exit code ${done.code ?? 'none'}${done.timedOut ? ' (timed out)' : ''}.`;
      toast(ok ? `${title}: done.` : `${title} failed — see the log in Settings.`, ok ? undefined : 'error');
    } catch (e) {
      log.textContent += `\n✗ ${e}`;
      toast(String(e), 'error');
    } finally {
      unlisten();
      this.busy = false;
      this.refresh();
    }
  }
};

hooks.boot.push(() => {
  if (!$('graphifyStatus')) return;
  $('graphifyInstall').addEventListener('click', () =>
    Graphify.run('install', 'Install Graphify', 'Downloads Graphify (PyPI package "graphifyy") with your Python tool installer.')
  );
  $('graphifySetup').addEventListener('click', () =>
    Graphify.run('setup', 'Add Graphify to my agents', "Runs Graphify's own installer for each of your installed agents, adding its skill to your user profile.")
  );
  $('graphifyBuild').addEventListener('click', () =>
    Graphify.run('build', 'Build graph', "Indexes this project's code locally (no API key, nothing uploaded) into a graphify-out folder.")
  );
  $('graphifyOpen').addEventListener('click', async () => {
    try {
      await invoke('graphify_open', { cwd: Graphify.folder() });
    } catch (e) {
      toast(String(e), 'error');
    }
  });
  $('settingsBtn')?.addEventListener('click', () => Graphify.refresh());
  Graphify.refresh();
});

registerCommand({
  group: 'App',
  label: 'Graphify: build a knowledge graph of this project',
  run: () => {
    $('settingsSheet').showModal();
    Graphify.refresh();
    requestAnimationFrame(() => $('graphifyBuild')?.scrollIntoView({ block: 'center' }));
  }
});

const Brain = {
  busy: false,

  async refresh() {
    const el = $('brainStatus');
    if (!el) return;
    let st;
    try {
      st = await invoke('brain_status', { paths: Graphify.projectPaths() });
    } catch (e) {
      el.textContent = `Couldn't check the second brain: ${e}`;
      return;
    }
    el.textContent = st.built
      ? `${st.projects} project${st.projects === 1 ? '' : 's'} with a graph. The merged graph and vault are built.`
      : st.projects
        ? `${st.projects} project${st.projects === 1 ? '' : 's'} with a graph. Not merged yet.`
        : 'No project has a graph yet. One is built automatically when you start a session in a project folder.';
    $('brainUpdate').disabled = !st.projects || this.busy;
    $('brainGraph').disabled = !st.built;
    $('brainVault').disabled = !st.built;
    $('brainObsidian').disabled = !st.built;
    $('brainObsidian').textContent = st.obsidian ? 'Open in Obsidian' : 'Open in Obsidian (not installed)';
    this.vault = st.vault;
  },

  async update(quiet = false) {
    if (this.busy) return;
    this.busy = true;
    try {
      const done = await invoke('brain_run', { paths: Graphify.projectPaths() });
      const ok = done.code === 0;
      if (!quiet || !ok) toast(ok ? 'Second brain updated.' : 'Second brain update failed.', ok ? undefined : 'error');
    } catch (e) {
      if (!quiet) toast(String(e), 'error');
    } finally {
      this.busy = false;
      this.refresh();
    }
  },

  async open(what) {
    try {
      await invoke('brain_open', { what });
    } catch (e) {
      toast(String(e), 'error');
    }
  }
};

hooks.boot.push(() => {
  if (!$('brainStatus')) return;
  const auto = $('graphAuto');
  auto.checked = prefs.graphAuto !== false;
  auto.addEventListener('change', () => {
    prefs.graphAuto = auto.checked;
    savePrefs();
  });
  $('brainUpdate').addEventListener('click', () => Brain.update());
  $('brainGraph').addEventListener('click', () => Brain.open('graph'));
  $('brainObsidian').addEventListener('click', () => Brain.open('obsidian'));
  $('brainVault').addEventListener('click', () => Brain.open('vault'));
  $('brainBtn')?.addEventListener('click', async () => {
    const st = await invoke('brain_status', { paths: Graphify.projectPaths() }).catch(() => null);
    if (st && st.built) return Brain.open('graph');
    $('settingsSheet').showModal();
    Brain.refresh();
    toast(st && st.projects ? 'Press "Update second brain" to merge your projects.' : 'No project graphs yet. Start a session in a project folder.');
  });
  $('settingsBtn')?.addEventListener('click', () => Brain.refresh());
  Brain.refresh();
});

registerCommand({ group: 'App', label: 'Second brain: open the graph of all projects', run: () => $('brainBtn').click() });
registerCommand({ group: 'App', label: 'Second brain: update from all projects', run: () => Brain.update() });
