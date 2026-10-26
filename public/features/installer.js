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

  /* ---------------------------------------------------------- install everything */

  /** Agents not installed yet, one per install command (Claude and Claude Code share one). */
  function missing() {
    const seen = new Set();
    return state.agents.filter((a) => {
      if (a.available || !a.install || seen.has(a.install)) return false;
      seen.add(a.install);
      return true;
    });
  }

  async function runAll(list) {
    busy = true;
    const act = sheet.querySelector('[data-run]');
    const stopBtn = sheet.querySelector('[data-stop]');
    act.hidden = true;
    stopBtn.hidden = false;
    const log = sheet.querySelector('.install-log');
    log.textContent = '';
    log.hidden = false;
    const ok = [];
    const failed = [];
    let stopped = false;
    for (let i = 0; i < list.length && !stopped; i++) {
      const a = list[i];
      current = { agentId: a.id, label: a.label, install: a.install, unlisten: null };
      sheet.querySelector('h2').textContent = `Installing ${a.label} (${i + 1} of ${list.length})…`;
      appendLog(`\n=== ${a.label}: ${a.install}\n`);
      current.unlisten = await listen(`install-out:${a.id}`, (e) => appendLog(e.payload));
      let done = null;
      try {
        done = await invoke('install_agent', { agentId: a.id });
      } catch (err) {
        appendLog(`\n${String(err)}\n`);
      }
      safe(current.unlisten);
      if (done && done.cancelled) stopped = true;
      if (done && done.resolved) {
        ok.push(a.label);
        appendLog(`\n✓ ${a.label} is installed.\n`);
      } else {
        failed.push(a.label);
        appendLog(`\n✗ ${a.label} did not install${stopped ? ' (stopped)' : ''}.\n`);
      }
    }
    busy = false;
    stopBtn.hidden = true;
    await reloadAgents();
    if (typeof renderOnboarding === 'function' && $('onboardingSheet') && $('onboardingSheet').open) renderOnboarding();
    sheet.querySelector('h2').textContent = failed.length ? `Installed ${ok.length} of ${list.length}` : 'All agents are installed';
    appendLog(`\nDone. Installed: ${ok.join(', ') || 'none'}.${failed.length ? ` Not installed: ${failed.join(', ')}. Their log is above; you can retry each from its Install button.` : ''}\n`);
    toast(failed.length ? `Installed ${ok.length} of ${list.length} agents.` : `All ${ok.length} agents are installed.`, failed.length ? 'error' : 'ok');
  }

  function openAll() {
    if (busy) return;
    const list = missing();
    if (!list.length) {
      toast('Every agent is already installed.', 'ok');
      return;
    }
    open(list[0].id); // builds the sheet
    current = null;
    sheet.querySelector('h2').textContent = `Install ${list.length} agent${list.length === 1 ? '' : 's'}?`;
    sheet.querySelector('.install-body').innerHTML = `<p class="note">ezCLI will run these commands one after another, the same ones you'd run in a terminal. If this PC has no Node.js, it is installed first (winget, or the official portable Node.js from nodejs.org, checked against its published SHA-256). Each agent brings its own models; you sign in to each one the first time you start it.</p>
      <pre class="install-cmd">${list.map((a) => `${esc(a.label)}:  ${esc(a.install)}`).join('\n')}</pre>`;
    const act = sheet.querySelector('[data-run]');
    act.hidden = false;
    act.disabled = false;
    act.textContent = 'Install all';
    // swap the single-agent handler for this run only
    const fresh = act.cloneNode(true);
    act.replaceWith(fresh);
    fresh.addEventListener('click', () => runAll(list), { once: true });
    sheet.addEventListener(
      'close',
      () => {
        const again = sheet.querySelector('[data-run]');
        const plain = again.cloneNode(true);
        again.replaceWith(plain);
        plain.addEventListener('click', run);
      },
      { once: true }
    );
  }

  return { open, openAll, missing };
})();

hooks.boot.push(() => {
  // renderFreeInstalls (app.js) builds one row per missing free agent, with
  // a Copy button and a data-install-agent Install button; it renders inside
  // both the Health check sheet and onboarding's "What ezCLI found" box, so
  // one delegated listener on the body covers every place it appears.
  document.body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-install-agent]');
    if (b) Installer.open(b.dataset.installAgent);
    if (e.target.closest('[data-install-all]')) Installer.openAll();
  });
  // the button's label says how many are left, and it hides when there are none
  const sync = () => {
    const n = Installer.missing().length;
    document.querySelectorAll('[data-install-all]').forEach((b) => {
      b.hidden = n === 0;
      b.textContent = `Install all agents (${n})`;
    });
  };
  sync();
  setInterval(sync, 4000);
});

registerCommand({ group: 'App', label: 'Install all agents', run: () => Installer.openAll() });
