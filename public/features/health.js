'use strict';
/* Health check: one screen that says what is installed and what is missing.
 *
 * The backend runs `<cli> --version` for every agent and tool in parallel
 * and checks sign-in by file or variable presence only. This screen shows
 * the result with the exact install command for anything missing. */

const Health = (() => {
  let sheet = null;
  let running = false;

  const signLabel = { yes: 'Signed in', no: 'Not signed in', unknown: 'Sign-in not checked' };

  function row(a) {
    const installed = Boolean(a.path);
    const status = !installed ? 'missing' : a.signedIn === 'no' ? 'warn' : 'ok';
    const statusText = !installed ? 'Not installed' : a.signedIn === 'yes' ? 'Ready' : signLabel[a.signedIn];
    const detail = installed
      ? `<span class="health-path" title="${esc(a.path)}">${esc(a.path)}</span>`
      : `<span class="health-why">ezCLI looked for <code>${esc(a.command)}</code> on PATH and in the usual install folders.</span>`;
    const fix = !installed && a.install
      ? `<div class="health-fix"><code>${esc(a.install)}</code><button class="btn quiet" data-copy="${esc(a.install)}">Copy</button></div>`
      : installed && a.signedIn === 'no' && a.signInHint
        ? `<p class="health-hint">${esc(a.signInHint)}</p>`
        : installed && a.signedIn === 'unknown' && a.signInHint
          ? `<p class="health-hint">${esc(a.signInHint)}</p>`
          : '';
    return `<li class="health-row">
      <span class="health-dot ${status}" aria-hidden="true"></span>
      <div class="health-main">
        <div class="health-line"><strong>${esc(a.label)}</strong><span class="health-status ${status}">${esc(statusText)}</span>${a.version ? `<span class="health-version">${esc(a.version)}</span>` : ''}</div>
        ${detail}${fix}
      </div></li>`;
  }

  function toolRow(t) {
    const ok = Boolean(t.path);
    return `<li class="health-row">
      <span class="health-dot ${ok ? 'ok' : 'missing'}" aria-hidden="true"></span>
      <div class="health-main">
        <div class="health-line"><strong>${esc(t.name)}</strong><span class="health-status ${ok ? 'ok' : 'missing'}">${ok ? 'Found' : 'Not found'}</span>${t.version ? `<span class="health-version">${esc(t.version)}</span>` : ''}</div>
        <span class="health-why">${esc(t.purpose)}</span>
        ${ok ? '' : `<div class="health-fix"><code>${esc(t.install)}</code><button class="btn quiet" data-copy="${esc(t.install)}">Copy</button></div>`}
      </div></li>`;
  }

  async function refresh() {
    if (running) return;
    running = true;
    const body = sheet.querySelector('.health-body');
    body.innerHTML = '<p class="note health-loading">Checking every CLI… this runs each one with --version and can take a few seconds.</p>';
    sheet.querySelector('[data-refresh]').disabled = true;
    try {
      const r = await invoke('health_report');
      const ready = r.agents.filter((a) => a.path).length;
      body.innerHTML = `
        <p class="health-summary">${ready} of ${r.agents.length} agents installed · ezCLI ${esc(r.appVersion)} on ${esc(r.os)}</p>
        <h3>Agents</h3><ul class="health-list">${r.agents.map(row).join('')}</ul>
        <h3>Tools</h3><ul class="health-list">${r.tools.map(toolRow).join('')}</ul>
        <p class="note">A provider's desktop app (Claude Desktop, ChatGPT, Antigravity) is not its command-line tool. Install the CLI with the command shown, then press Check again. ezCLI reads the current PATH from Windows, so you do not need to sign out.</p>`;
    } catch (err) {
      body.innerHTML = `<p class="note">The check failed: ${esc(String(err))}</p>`;
    }
    sheet.querySelector('[data-refresh]').disabled = false;
    running = false;
  }

  function open() {
    if (!sheet) {
      sheet = document.createElement('dialog');
      sheet.className = 'sheet wide health-sheet';
      sheet.setAttribute('aria-labelledby', 'healthTitle');
      sheet.innerHTML = `<h2 id="healthTitle">Health check</h2>
        <div class="health-body"></div>
        <div class="row-actions">
          <button class="btn" data-refresh>Check again</button>
          <button class="btn quiet" data-reload>Reload agents</button>
          <span class="grow"></span>
          <form method="dialog"><button class="btn primary">Done</button></form>
        </div>`;
      document.body.appendChild(sheet);
      sheet.addEventListener('click', (e) => {
        const c = e.target.closest('[data-copy]');
        if (c) copy(c.dataset.copy);
      });
      sheet.querySelector('[data-refresh]').addEventListener('click', refresh);
      sheet.querySelector('[data-reload]').addEventListener('click', async () => {
        await reloadAgents();
        refresh();
      });
    }
    if (!sheet.open) sheet.showModal();
    refresh();
  }

  return { open };
})();

registerCommand({ group: 'App', label: 'Health check: installed CLIs and tools', run: () => Health.open() });
hooks.boot.push(() => {
  const b = $('openHealth');
  if (b) b.addEventListener('click', () => Health.open());
});
