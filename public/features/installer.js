'use strict';
/* In-app agent installer: run an agent's documented install command (the
 * same string already shown in Settings/Health check) without leaving ezCLI.
 *
 * Nothing installs silently. Every run starts from an explicit click, shows
 * the literal command first, and streams its real output so the user sees
 * exactly what ran: same transparency as PC control's consent dialog. */

const Installer = (() => {
  let sheet = null;
  let current = null; // { agentId, label, unlisten }
  let busy = false;

  function render(state_) {
    const body = sheet.querySelector('.install-body');
    const act = sheet.querySelector('[data-run]');
    const stop = sheet.querySelector('[data-stop]');
    if (state_ === 'confirm') {
      body.innerHTML = `<p class="note">ezCLI will run this exact command. It downloads and runs a third-party installer (npm or the vendor's own script), the same thing you'd run yourself in a terminal.</p>
        <pre class="install-cmd">${esc(current.install)}</pre>`;
      act.hidden = false;
      act.disabled = false;
      act.textContent = 'Run this command';
      stop.hidden = true;
      sheet.querySelector('h2').textContent = `Install ${current.label}?`;
      return;
    }
    if (state_ === 'running') {
      act.hidden = true;
      stop.hidden = false;
      sheet.querySelector('h2').textContent = `Installing ${current.label}…`;
      return;
    }
    // 'done'
    act.hidden = true;
    stop.hidden = true;
  }

  function appendLog(text) {
    const log = sheet.querySelector('.install-log');
    log.textContent += text;
    log.scrollTop = log.scrollHeight;
  }

  async function run() {
    if (busy || !current) return;
    busy = true;
    render('running');
    sheet.querySelector('.install-log').textContent = '';
    sheet.querySelector('.install-log').hidden = false;
    current.unlisten = await listen(`install-out:${current.agentId}`, (e) => appendLog(e.payload));
    let done;
    try {
      done = await invoke('install_agent', { agentId: current.agentId });
    } catch (err) {
      done = null;
      appendLog(`\n${String(err)}\n`);
    }
    safe(current.unlisten);
    busy = false;
    render('done');
    if (done && done.resolved) {
      toast(`${current.label} is installed.`, 'ok');
      await reloadAgents();
      if (typeof renderOnboarding === 'function' && $('onboardingSheet') && $('onboardingSheet').open) renderOnboarding();
      sheet.close();
    } else if (done && done.cancelled) {
      toast(`Install stopped.`);
    } else if (done && done.timedOut) {
      toast(`${current.label}'s installer did not finish in time.`, 'error');
    } else {
      toast(`${current.label} doesn't look installed yet. Check the log below, or try the command yourself.`, 'error');
    }
  }

  function stop() {
    if (!current) return;
    invoke('cancel_install', { agentId: current.agentId }).catch(() => {});
  }

  function open(agentId) {
    const a = agent(agentId);
    if (!a || !a.install) {
      toast(a ? `No install command is configured for ${a.label}.` : 'Unknown agent.', 'error');
      return;
    }
    current = { agentId, label: a.label, install: a.install, unlisten: null };
    if (!sheet) {
      sheet = document.createElement('dialog');
      sheet.className = 'sheet install-sheet';
      sheet.innerHTML = `<h2></h2>
        <div class="install-body"></div>
        <pre class="install-log" hidden></pre>
        <div class="row-actions">
          <span class="grow"></span>
          <button class="btn quiet" data-stop hidden>Stop</button>
          <form method="dialog"><button class="btn">Close</button></form>
          <button class="btn primary" data-run>Run this command</button>
        </div>`;
      document.body.appendChild(sheet);
      sheet.querySelector('[data-run]').addEventListener('click', run);
      sheet.querySelector('[data-stop]').addEventListener('click', stop);
      sheet.addEventListener('close', () => {
        if (current && current.unlisten) safe(current.unlisten);
      });
    }
    sheet.querySelector('.install-log').hidden = true;
    render('confirm');
    if (!sheet.open) sheet.showModal();
  }

  return { open };
})();

hooks.boot.push(() => {
  // renderFreeInstalls (app.js) builds one row per missing free agent, with
  // a Copy button and a data-install-agent Install button; it renders inside
  // both the Health check sheet and onboarding's "What ezCLI found" box, so
  // one delegated listener on the body covers every place it appears.
  document.body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-install-agent]');
    if (b) Installer.open(b.dataset.installAgent);
  });
});
