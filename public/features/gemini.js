'use strict';
/* Connect Gemini CLI with an API key, from inside ezCLI.
 *
 * Google dropped personal Google sign-in for Gemini CLI, so a session just fails at its own
 * sign-in screen. A free key from aistudio.google.com fixes it. This turns the Gemini notice in
 * the session header into a small setup: paste your key, ezCLI stores it where Gemini CLI reads
 * it (~/.gemini/.env) and switches the CLI to API-key auth, then restarts the tab. The key stays
 * on this PC; ezCLI never sends it anywhere and never shows it back. */

const GeminiSetup = {
  status: null,
  busy: false,

  /** Fill the notice for a Gemini session. Called from renderSessionAgentNotice. */
  render(notice, s) {
    // Do not stomp on a key the user is in the middle of typing.
    if (notice.dataset.gemFor === s.id && notice.querySelector('.gem-key:focus')) return;
    notice.dataset.gemFor = s.id;
    notice.classList.add('gem-notice');
    this.paint(notice, this.status);
    invoke('gemini_status')
      .then((st) => {
        this.status = st;
        if (notice.dataset.gemFor === s.id && !notice.querySelector('.gem-key:focus')) this.paint(notice, st);
      })
      .catch(() => {});
  },

  paint(notice, st) {
    if (st && st.ready) {
      notice.innerHTML = `<strong>Gemini CLI:</strong> connected with your API key. <button type="button" class="gem-link" data-gem="disconnect">Remove key</button>`;
      return;
    }
    const connectedButOff = st && st.hasKey && st.authType && st.authType !== 'gemini-api-key';
    notice.innerHTML = `<strong>Gemini CLI setup:</strong> personal Google sign-in no longer works here. Paste a free Gemini API key to connect, or use Antigravity CLI for a personal Google account.
      <div class="gem-row">
        <input type="password" class="gem-key" placeholder="Paste your Gemini API key" aria-label="Gemini API key" autocomplete="off" spellcheck="false" />
        <button type="button" class="gem-btn" data-gem="connect">Connect</button>
      </div>
      <div class="gem-foot"><a href="https://aistudio.google.com/apikey" class="gem-link" data-gem="get">Get a free key</a>${connectedButOff ? ' · a key is saved but Gemini is set to another sign-in; Connect will switch it.' : ''}<span class="gem-msg" aria-live="polite"></span></div>`;
  },

  async connect(notice, s) {
    if (this.busy) return;
    const input = notice.querySelector('.gem-key');
    const msg = notice.querySelector('.gem-msg');
    const key = (input.value || '').trim();
    if (!key) {
      input.focus();
      return;
    }
    this.busy = true;
    const btn = notice.querySelector('[data-gem="connect"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Connecting…';
    }
    try {
      this.status = await invoke('gemini_connect', { key });
      input.value = '';
      if (msg) {
        msg.textContent = ' Connected. Restarting Gemini…';
        msg.className = 'gem-msg ok';
      }
      const live = active();
      if (live && live.agentId === 'gemini' && typeof restartSession === 'function') {
        setTimeout(() => restartSession(live), 500);
      }
    } catch (err) {
      if (msg) {
        msg.textContent = ' ' + String(err);
        msg.className = 'gem-msg err';
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Connect';
      }
    } finally {
      this.busy = false;
    }
  },

  async disconnect(notice) {
    try {
      this.status = await invoke('gemini_disconnect');
    } catch {
      /* ignore */
    }
    this.paint(notice, this.status);
  },

  mount() {
    const notice = $('sessionAgentNotice');
    if (!notice) return;
    notice.addEventListener('click', (e) => {
      const a = e.target.closest('[data-gem]');
      if (!a) return;
      const what = a.dataset.gem;
      if (what === 'get') {
        e.preventDefault();
        openUrl(a.getAttribute('href'));
      } else if (what === 'connect') {
        this.connect(notice, active());
      } else if (what === 'disconnect') {
        this.disconnect(notice);
      }
    });
    notice.addEventListener('keydown', (e) => {
      if (e.target.classList.contains('gem-key') && e.key === 'Enter') {
        e.preventDefault();
        this.connect(notice, active());
      }
    });
  }
};

hooks.boot.push(() => GeminiSetup.mount());
