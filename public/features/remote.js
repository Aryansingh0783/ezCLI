'use strict';
/* Remote view: watch sessions from a phone on the same Wi-Fi.
 *
 * Off by default. Turning it on starts a small server with a secret link;
 * the phone shows this window's tabs, read-only unless typing is allowed
 * as a second step. Turning it off ends the link. */

const Remote = (() => {
  let sheet = null;
  let status = { enabled: false, allowInput: false, url: null, qrSvg: null };

  function pushSessions() {
    if (!status.enabled || !IS_MAIN_WINDOW) return;
    const list = state.sessions
      .filter((s) => s.ptyId)
      .map((s) => ({ id: s.ptyId, title: s.title, agent: (agent(s.agentId) || {}).label || s.agentId }));
    invoke('remote_set_sessions', { sessions: list }).catch(() => {});
  }

  function render() {
    if (!sheet) return;
    const on = status.enabled;
    sheet.querySelector('[data-toggle]').textContent = on ? 'Turn off' : 'Turn on';
    sheet.querySelector('[data-toggle]').className = on ? 'btn' : 'btn primary';
    const body = sheet.querySelector('.remote-body');
    body.innerHTML = on
      ? `<div class="remote-live">
          <div class="remote-qr" aria-label="QR code for the remote view link">${status.qrSvg || ''}</div>
          <div class="remote-info">
            <p class="remote-step"><strong>Scan the code</strong> with your phone's camera, or open this link on a device on the same network:</p>
            <div class="remote-url"><code>${esc(status.url)}</code><button class="btn quiet" data-copy-url>Copy</button></div>
            <label class="toggle-row"><input type="checkbox" data-input ${status.allowInput ? 'checked' : ''}/> <span>Allow typing from the phone</span></label>
            <p class="note">Anyone with this link can ${status.allowInput ? '<strong>read and type into</strong>' : 'read'} your open sessions while it is on. The connection is unencrypted on your local network. Turning it off ends the link; the next one is different.</p>
          </div>
        </div>`
      : `<p class="note">Turn this on to see your open sessions on a phone or tablet on the same Wi-Fi. ezCLI creates a private link and a QR code. Typing from the phone is a separate switch. Windows may ask once whether ezCLI can accept connections on your network.</p>`;
  }

  async function toggle() {
    try {
      status = status.enabled ? await invoke('remote_stop') : await invoke('remote_start');
    } catch (err) {
      return toast(String(err), 'error');
    }
    pushSessions();
    render();
    updateIndicator();
  }

  function updateIndicator() {
    let dot = $('remoteIndicator');
    if (!status.enabled) {
      if (dot) dot.remove();
      return;
    }
    if (!dot) {
      dot = document.createElement('button');
      dot.id = 'remoteIndicator';
      dot.className = 'remote-indicator';
      dot.addEventListener('click', open);
      document.querySelector('.statusbar .grow').after(dot);
    }
    dot.textContent = status.allowInput ? 'Remote view on · typing allowed' : 'Remote view on';
    dot.classList.toggle('typing', status.allowInput);
  }

  async function open() {
    if (!sheet) {
      sheet = document.createElement('dialog');
      sheet.className = 'sheet remote-sheet';
      sheet.setAttribute('aria-labelledby', 'remoteTitle');
      sheet.innerHTML = `<h2 id="remoteTitle">Remote view</h2><div class="remote-body"></div>
        <div class="row-actions"><button data-toggle></button><span class="grow"></span><form method="dialog"><button class="btn">Done</button></form></div>`;
      document.body.appendChild(sheet);
      sheet.querySelector('[data-toggle]').addEventListener('click', toggle);
      sheet.addEventListener('click', (e) => {
        if (e.target.closest('[data-copy-url]')) copy(status.url);
      });
      sheet.addEventListener('change', async (e) => {
        if (!e.target.matches('[data-input]')) return;
        const allow = e.target.checked;
        if (allow && !(await confirmDialog('Allow typing from the phone?', 'Anyone with the link could send messages and keystrokes to your running CLIs, which can edit files and run commands. Only allow this on a network you trust.', 'Allow typing'))) {
          e.target.checked = false;
          return;
        }
        status = await invoke('remote_allow_input', { allow });
        render();
        updateIndicator();
      });
    }
    try {
      status = await invoke('remote_status');
    } catch {
      /* keep last known */
    }
    render();
    if (!sheet.open) sheet.showModal();
  }

  return { open, pushSessions };
})();

for (const name of ['tabs', 'launched', 'exit']) hooks[name].push(() => Remote.pushSessions());
hooks.boot.push(() => {
  const b = $('openRemote');
  if (b) b.addEventListener('click', () => Remote.open());
});
registerCommand({ group: 'App', label: 'Remote view: watch sessions from your phone…', run: () => Remote.open() });
