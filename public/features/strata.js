'use strict';
/* Strata: an optional third-party MCP tool server from Klavis AI.
 *
 * ezCLI never creates a Klavis account, calls Klavis's API, or installs
 * anything on the user's behalf. This file only persists a URL the user
 * pastes in Settings (prefs.strataUrl) and keeps the header chip (defined in
 * app.js's render + click handler, next to PC control) in sync with it. If
 * the field is blank, Strata is entirely inert: no chip, no attach, nothing
 * sent anywhere. */

hooks.boot.push(() => {
  const field = $('prefStrataUrl');
  if (!field) return;
  field.value = prefs.strataUrl || '';
  field.addEventListener('change', () => {
    const v = field.value.trim();
    // Loose client-side check; the Rust side is the real gate (http/https
    // only) and refuses the launch outright if this slips through odd.
    if (v && !/^https?:\/\//i.test(v)) {
      toast('Strata URL must start with http:// or https://', 'error');
      field.value = prefs.strataUrl || '';
      return;
    }
    prefs.strataUrl = v;
    savePrefs();
    // The chip's visibility depends on this value; refresh the active header.
    renderHead();
    if (!v && active() && active().wantStrata) {
      active().wantStrata = false;
      toast('Strata URL cleared; it will not be offered to new sessions.');
    }
  });
});

registerCommand({
  group: 'App',
  label: 'Strata: set or clear the MCP server URL…',
  run: () => {
    $('settingsSheet').showModal();
    requestAnimationFrame(() => $('prefStrataUrl')?.focus());
  }
});
