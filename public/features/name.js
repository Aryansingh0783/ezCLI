'use strict';
/* Your name in the home greeting. ezCLI no longer guesses it from the Windows account folder;
 * first-run setup asks for it, and until you answer (or dismiss it) the home screen offers one
 * small field under the greeting. Settings, "Your name", changes it any time. */

const NamePrompt = {
  save(name) {
    prefs.displayName = String(name || '').trim().slice(0, 24);
    prefs.nameAsked = true;
    savePrefs();
    const box = $('prefName');
    if (box) box.value = prefs.displayName;
    renderHome();
    this.render();
  },

  render() {
    const title = $('homeTitle');
    if (!title) return;
    let row = $('homeNameAsk');
    const want = !String(prefs.displayName || '').trim() && !prefs.nameAsked;
    if (!want) {
      if (row) row.remove();
      return;
    }
    if (row) return;
    row = document.createElement('form');
    row.id = 'homeNameAsk';
    row.className = 'home-name-ask';
    row.innerHTML = `<label for="homeNameInput">What should I call you?</label>
      <input id="homeNameInput" type="text" placeholder="Your name" maxlength="24" autocomplete="given-name" spellcheck="false" />
      <button type="submit">Save</button><button type="button" class="ghost" data-skip>Not now</button>`;
    row.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = row.querySelector('input').value.trim();
      if (v) this.save(v);
    });
    row.querySelector('[data-skip]').addEventListener('click', () => {
      prefs.nameAsked = true;
      savePrefs();
      this.render();
    });
    title.after(row);
  }
};

hooks.boot.push(() => {
  const ob = $('onboardingName');
  if (ob) {
    ob.value = prefs.displayName || '';
    ob.addEventListener('change', () => ob.value.trim() && NamePrompt.save(ob.value));
    ob.addEventListener('keydown', (e) => e.key === 'Enter' && ob.value.trim() && NamePrompt.save(ob.value));
  }
  NamePrompt.render();
});
hooks.view.push(() => NamePrompt.render());
