'use strict';
/* Strata: a third-party MCP tool server from Klavis AI.
 *
 * ezCLI never creates a Klavis account, calls Klavis's API, or installs
 * anything on the user's behalf — that part is entirely the user's own
 * setup. Once a URL is pasted in Settings (prefs.strataUrl), though, it is
 * NOT opt-in per session: every new session for an agent that can receive an
 * MCP server gets it automatically (see app.js's launch(), which only
 * excludes it when a session was explicitly turned off via its own header
 * chip — see app.js's render + click handler, next to PC control). Leave the
 * field blank and Strata stays entirely inert: no chip, no attach, nothing
 * sent anywhere. */

hooks.boot.push(() => {
  const field = $('prefStrataUrl');
  if (!field) return;
  field.value = prefs.strataUrl || '';
  field.addEventListener('change', () => {
    const v = field.value.trim();
    const had = Boolean(prefs.strataUrl);
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
    if (v && !had) toast('Strata will attach to every new compatible session from now on.', 'ok');
    else if (!v && had) toast('Strata URL cleared; it will not be offered to new sessions.');
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
