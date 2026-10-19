'use strict';
/* Connectors: custom remote MCP servers the user sets up and configures
 * themselves — Klavis AI's Strata, a self-hosted tool server, or anything
 * else that speaks MCP over HTTP. This is the part of what a tool like
 * Claude Desktop's "Connectors" settings offers that ezCLI can actually do
 * safely: ezCLI never creates a third-party account, runs an OAuth flow, or
 * installs anything on the user's behalf — each connector is just a name
 * and a URL the user already has, attached to sessions the same way PC
 * control is, on by default once configured (see app.js's launch() and the
 * Connectors header chip, a per-tab opt-OUT). There is no built-in list of
 * pre-wired SaaS connectors (Notion, Drive, Slack, …): that would mean
 * ezCLI hosting OAuth redirects and holding real third-party credentials,
 * which is out of scope. */

function newConnectorId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function renderConnectors() {
  const list = $('connectorList');
  if (!list) return;
  const connectors = prefs.connectors || [];
  list.innerHTML = connectors.length
    ? connectors
        .map(
          (c) => `<li class="connector-row" data-id="${esc(c.id)}">
      <input type="checkbox" class="connector-enabled" ${c.enabled ? 'checked' : ''} aria-label="Enable ${esc(c.name || 'this connector')}" />
      <input type="text" class="connector-name" placeholder="Name (e.g. Strata)" value="${esc(c.name || '')}" />
      <input type="text" class="connector-url" placeholder="https://&hellip; MCP server URL" value="${esc(c.url || '')}" autocomplete="off" spellcheck="false" />
      <button class="btn quiet connector-remove" aria-label="Remove ${esc(c.name || 'this connector')}">${ICONS.close || '✕'}</button>
    </li>`
        )
        .join('')
    : '<li class="connector-empty note">No connectors yet. Add one below — paste in a name and the MCP server URL you already set up.</li>';
}

function saveConnectorField(id, field, value) {
  const c = (prefs.connectors || []).find((x) => x.id === id);
  if (!c) return;
  c[field] = value;
  savePrefs();
  renderHead();
}

hooks.boot.push(() => {
  const list = $('connectorList');
  const addBtn = $('addConnector');
  if (!list || !addBtn) return;
  renderConnectors();

  addBtn.addEventListener('click', () => {
    prefs.connectors ||= [];
    prefs.connectors.push({ id: newConnectorId(), name: '', url: '', enabled: true });
    savePrefs();
    renderConnectors();
    const rows = list.querySelectorAll('.connector-name');
    rows[rows.length - 1]?.focus();
  });

  list.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.connector-remove');
    if (!removeBtn) return;
    const row = removeBtn.closest('.connector-row');
    const id = row?.dataset.id;
    prefs.connectors = (prefs.connectors || []).filter((c) => c.id !== id);
    savePrefs();
    renderConnectors();
    renderHead();
    if (active() && active().connectorsOff) active().connectorsOff = false;
  });

  list.addEventListener('change', (e) => {
    const row = e.target.closest('.connector-row');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.classList.contains('connector-enabled')) {
      saveConnectorField(id, 'enabled', e.target.checked);
    } else if (e.target.classList.contains('connector-name')) {
      saveConnectorField(id, 'name', e.target.value.trim());
    } else if (e.target.classList.contains('connector-url')) {
      const v = e.target.value.trim();
      if (v && !/^https?:\/\//i.test(v)) {
        toast('Connector URL must start with http:// or https://', 'error');
        e.target.value = (prefs.connectors || []).find((c) => c.id === id)?.url || '';
        return;
      }
      saveConnectorField(id, 'url', v);
    }
  });
});

registerCommand({
  group: 'App',
  label: 'Connectors: add or edit an MCP server…',
  run: () => {
    $('settingsSheet').showModal();
    requestAnimationFrame(() => $('addConnector')?.focus());
  }
});
