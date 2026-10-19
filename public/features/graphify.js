'use strict';
/* Graphify (third-party): install it, add its skill to every installed agent
 * that supports it, build a project's graph, and open it. Every command is
 * chosen by the backend from a fixed list and shown here before it runs. */

const Graphify = {
  busy: false,

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
      cmd = await invoke('graphify_plan', { action });
    } catch (e) {
      toast(String(e), 'error');
      return;
    }
    const where = action === 'build' ? ` in ${this.folder()}` : action === 'setup' ? ' (from a temporary folder, so your projects are untouched)' : '';
    if (!(await confirmDialog(title, `${why}\n\nezCLI will run${where}:\n${cmd}`, 'Run it'))) return;
    const log = $('graphifyLog');
    log.hidden = false;
    log.textContent = `> ${cmd}\n`;
    this.busy = true;
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
