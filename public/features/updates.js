'use strict';
/* Updates from GitHub Releases.
 *
 * Checks at startup (unless turned off) and from Settings. An
 * update installs only when the release publishes a SHA-256 checksum and the
 * download matches it; otherwise ezCLI opens the release page instead. */

const Updates = (() => {
  let info = null;
  let sheet = null;
  let busy = false;

  function badge() {
    let b = $('updateBadge');
    if (!info || !info.available) {
      if (b) b.remove();
      return;
    }
    if (!b) {
      b = document.createElement('button');
      b.id = 'updateBadge';
      b.className = 'update-badge';
      b.addEventListener('click', open);
      $('paletteBtn') ? $('paletteBtn').before(b) : $('closedTabsBtn').before(b);
    }
    b.textContent = `Update ${info.latest}`;
    b.title = `ezCLI ${info.latest} is available (you have ${info.current})`;
  }

  async function check({ quiet = true } = {}) {
    try {
      info = await invoke('check_update');
      prefs.lastUpdateCheck = Date.now();
      savePrefs();
      badge();
      if (!quiet) toast(info.available ? `ezCLI ${info.latest} is available.` : `You have the latest version (${info.current}).`, info.available ? 'ok' : '');
    } catch (err) {
      if (!quiet) toast(`Couldn't check for updates: ${String(err)}`, 'error');
    }
    if (sheet && sheet.open) render();
    return info;
  }

  function render() {
    const body = sheet.querySelector('.update-body');
    const act = sheet.querySelector('[data-install]');
    if (!info) {
      body.innerHTML = '<p class="note">Checking GitHub for the latest release…</p>';
      act.hidden = true;
      return;
    }
    const size = info.installerSize ? ` · ${fmtSize(info.installerSize)}` : '';
    const notes = info.notes ? `<pre class="update-notes">${esc(info.notes)}</pre>` : '';
    if (!info.available) {
      body.innerHTML = `<p class="update-line"><strong>You're up to date.</strong> ezCLI ${esc(info.current)} is the latest release.</p>`;
      act.hidden = true;
      return;
    }
    const verified = info.installerUrl && info.checksumUrl;
    body.innerHTML = `<p class="update-line"><strong>ezCLI ${esc(info.latest)}</strong> is available. You have ${esc(info.current)}.</p>
      <p class="note">${verified
        ? `ezCLI downloads ${esc(info.installerName)}${size}, checks it against the published SHA-256, then starts the installer and closes. Running sessions stop.`
        : 'This release has no checksum for your platform, so ezCLI will not install it automatically. Open the release page to download it.'}</p>
      ${notes}`;
    act.hidden = false;
    act.textContent = verified ? 'Download and install' : 'Open release page';
    act.dataset.mode = verified ? 'install' : 'page';
  }

  async function install() {
    if (busy || !info) return;
    const act = sheet.querySelector('[data-install]');
    if (act.dataset.mode === 'page') return openUrl(info.pageUrl);
    const live = state.sessions.filter((s) => s.status === 'running').length;
    if (live && !(await confirmDialog('Install the update?', `${live} running session${live > 1 ? 's' : ''} will stop when ezCLI closes for the installer.`, 'Install'))) return;
    busy = true;
    act.disabled = true;
    act.textContent = 'Downloading…';
    try {
      const path = await invoke('download_update', { installerUrl: info.installerUrl, checksumUrl: info.checksumUrl, name: info.installerName });
      act.textContent = 'Starting installer…';
      snapshotParked();
      await invoke('install_update', { path });
    } catch (err) {
      toast(String(err), 'error');
      act.disabled = false;
      act.textContent = 'Download and install';
    }
    busy = false;
  }

  function open() {
    if (!sheet) {
      sheet = document.createElement('dialog');
      sheet.className = 'sheet update-sheet';
      sheet.innerHTML = `<h2>Updates</h2><div class="update-body"></div>
        <label class="toggle-row"><input type="checkbox" data-auto /> <span>Check for updates when ezCLI starts</span></label>
        <div class="row-actions">
          <button class="btn quiet" data-recheck>Check now</button>
          <span class="grow"></span>
          <button class="btn primary" data-install hidden>Download and install</button>
          <form method="dialog"><button class="btn">Close</button></form>
        </div>`;
      document.body.appendChild(sheet);
      sheet.querySelector('[data-install]').addEventListener('click', install);
      sheet.querySelector('[data-recheck]').addEventListener('click', () => {
        info = null;
        render();
        check({ quiet: false });
      });
      const auto = sheet.querySelector('[data-auto]');
      auto.addEventListener('change', () => {
        prefs.autoUpdateCheck = auto.checked;
        savePrefs();
      });
    }
    sheet.querySelector('[data-auto]').checked = prefs.autoUpdateCheck !== false;
    render();
    if (!sheet.open) sheet.showModal();
    if (!info) check();
  }

  hooks.boot.push(() => {
    const b = $('openUpdates');
    if (b) b.addEventListener('click', open);
    // One small request per launch, so the badge is accurate every time.
    if (IS_MAIN_WINDOW && prefs.autoUpdateCheck !== false) setTimeout(() => check(), 4000);
  });

  return { open, check };
})();

registerCommand({ group: 'App', label: 'Check for updates', run: () => Updates.open() });
