'use strict';
/* Compare: run one prompt on several agents and models at once.
 *
 * Each pick launches as its own real session (its own CLI, its own quota),
 * tagged with a shared group. While a grouped tab is active the terminal
 * area shows every member side by side, and the composer can send each
 * message to all of them. ezCLI never merges or rewrites the answers. */

const Compare = (() => {
  const MAX = 6;
  let sheet = null;
  let rows = [];
  let seq = 0;
  let broadcasting = false;
  let typedForBroadcast = '';

  const members = (s) => (s && s.compareGroup ? state.sessions.filter((x) => x.compareGroup === s.compareGroup) : []);
  const inGrid = (s) => members(s).length > 1 && !(s.compareGroupSolo);

  /* ---------------------------------------------------------- picker */

  function modelChoices(a) {
    const list = allModels(a).filter((m) => !(a.requiresModelSelection && m.id === 'default'));
    return list.length ? list : [{ id: 'default', label: 'Default' }];
  }

  function rowHtml(r, i) {
    const a = agent(r.agentId);
    const models = modelChoices(a);
    return `<li class="compare-row">
      <span class="compare-agent">${ICONS[a.icon] || ICONS.term}<strong>${esc(a.label)}</strong>${a.free ? '<span class="free-badge">Free</span>' : ''}</span>
      <select data-model="${i}" aria-label="Model for ${esc(a.label)}">
        ${models.map((m) => `<option value="${esc(m.id)}" ${m.id === r.modelId ? 'selected' : ''}>${esc(m.label)}${modelPrice(a, m.id) === 'Paid' ? ' · Paid' : ''}</option>`).join('')}
      </select>
      <button class="btn quiet compare-remove" data-remove="${i}" aria-label="Remove ${esc(a.label)}">${ICONS.close}</button>
    </li>`;
  }

  function render() {
    const list = sheet.querySelector('.compare-list');
    list.innerHTML = rows.length
      ? rows.map(rowHtml).join('')
      : '<li class="compare-empty">Add two or more agents or models below.</li>';
    const ready = state.agents.filter((a) => a.available);
    sheet.querySelector('.compare-add').innerHTML = ready
      .map((a) => `<button class="chip" data-add="${esc(a.id)}" ${rows.length >= MAX ? 'disabled' : ''}>${ICONS.plus}${esc(a.label)}</button>`)
      .join('');
    const go = sheet.querySelector('[data-start]');
    go.disabled = rows.length < 2;
    go.textContent = rows.length >= 2 ? `Start ${rows.length} sessions` : 'Pick at least two';
    sheet.querySelector('.compare-cap').textContent = `${rows.length} of ${MAX}`;
  }

  async function add(agentId) {
    if (rows.length >= MAX) return;
    const a = agent(agentId);
    if (!a) return;
    if (a.dynamic_models && !state.catalogs[a.id]) await fetchCatalog(a, { quiet: true });
    const used = rows.filter((r) => r.agentId === a.id).map((r) => r.modelId);
    const models = modelChoices(a);
    // A second row of the same agent defaults to a model not picked yet,
    // preferring free ones so "add another" never quietly picks a paid model.
    const preferred = pick(a).model;
    const unused = models.filter((m) => !used.includes(m.id));
    const isFree = (m) => modelPrice(a, m.id) === 'Free' || /(^|[-:/])free$/i.test(m.id);
    const next = unused.find((m) => m.id === preferred) || unused.find(isFree) || unused[0] || models[0];
    rows.push({ agentId: a.id, modelId: next.id });
    render();
  }

  async function addAllReady() {
    rows = [];
    for (const a of state.agents.filter((x) => x.available && !x.requiresModelSelection)) {
      if (rows.length >= MAX) break;
      await add(a.id);
    }
    render();
  }

  async function start() {
    const prompt = sheet.querySelector('textarea').value.trim();
    const picks = rows.slice(0, MAX);
    if (picks.length < 2) return;
    sheet.close();
    const group = `g${Date.now().toString(36)}${++seq}`;
    const created = [];
    for (const r of picks) {
      const a = agent(r.agentId);
      const label = r.modelId && r.modelId !== 'default' ? `${a.label} · ${modelLabel(a, r.modelId)}` : a.label;
      const s = await createSession(r.agentId, { modelId: r.modelId, prompt, title: label });
      if (s) {
        s.compareGroup = group;
        created.push(s);
      }
    }
    if (prompt) pushHistory(prompt);
    if (created.length) {
      selectSession(created[0].id);
      state.compareSendAll = true;
      toast(`Started ${created.length} sessions. Messages go to all of them until you turn off “Send to all”.`, 'ok');
    }
  }

  function open(prefill = '') {
    if (!sheet) {
      sheet = document.createElement('dialog');
      sheet.className = 'sheet wide compare-sheet';
      sheet.setAttribute('aria-labelledby', 'compareTitle');
      sheet.innerHTML = `<h2 id="compareTitle">Compare agents</h2>
        <p class="note">Send one prompt to several agents or models. Each runs as its own CLI session with its own account and limits; ezCLI shows them side by side.</p>
        <label class="field"><span>Prompt</span><textarea rows="3" placeholder="Leave empty to open the sessions and type later"></textarea></label>
        <div class="compare-head"><h3>Run on</h3><span class="compare-cap"></span><span class="grow"></span><button class="btn quiet" data-all>All ready agents</button><button class="btn quiet" data-clear>Clear</button></div>
        <ul class="compare-list"></ul>
        <div class="compare-add" aria-label="Add an agent"></div>
        <div class="row-actions">
          <span class="grow"></span>
          <form method="dialog"><button class="btn">Cancel</button></form>
          <button class="btn primary" data-start>Start</button>
        </div>`;
      document.body.appendChild(sheet);
      sheet.addEventListener('click', (e) => {
        const addBtn = e.target.closest('[data-add]');
        const rm = e.target.closest('[data-remove]');
        if (addBtn) add(addBtn.dataset.add);
        else if (rm) {
          rows.splice(Number(rm.dataset.remove), 1);
          render();
        }
      });
      sheet.addEventListener('change', (e) => {
        const sel = e.target.closest('[data-model]');
        if (sel) rows[Number(sel.dataset.model)].modelId = sel.value;
      });
      sheet.querySelector('[data-all]').addEventListener('click', addAllReady);
      sheet.querySelector('[data-clear]').addEventListener('click', () => {
        rows = [];
        render();
      });
      sheet.querySelector('[data-start]').addEventListener('click', start);
    }
    if (!rows.length) {
      const current = agent(prefs.agentId);
      if (current && current.available) rows.push({ agentId: current.id, modelId: pick(current).model || 'default' });
    }
    sheet.querySelector('textarea').value = prefill || $('homeInput').value.trim();
    render();
    if (!sheet.open) sheet.showModal();
  }

  /* ---------------------------------------------------------- grid */

  function layout() {
    const s = active();
    const hosts = $('termHosts');
    const group = inGrid(s) ? members(s) : [];
    hosts.classList.toggle('compare-grid', group.length > 1);
    for (const x of state.sessions) {
      x.host.classList.remove('compare-cell', 'compare-focus');
      x.host.style.removeProperty('--col');
      x.host.style.removeProperty('--row');
      x.host.removeAttribute('data-label');
    }
    renderBar(s, group);
    if (group.length < 2) return;
    const cols = group.length <= 2 ? 2 : group.length <= 4 ? 2 : 3;
    const rowsN = Math.ceil(group.length / cols);
    hosts.style.setProperty('--cols', cols);
    hosts.style.setProperty('--rows', rowsN);
    group.forEach((m, i) => {
      m.host.style.visibility = 'visible';
      m.host.classList.add('compare-cell');
      m.host.classList.toggle('compare-focus', m.id === s.id);
      m.host.style.setProperty('--col', (i % cols) + 1);
      m.host.style.setProperty('--row', Math.floor(i / cols) + 1);
      m.host.dataset.label = m.title;
    });
    requestAnimationFrame(() => group.forEach((m) => fitSession(m)));
  }

  function renderBar(s, group) {
    let bar = $('compareBar');
    if (group.length < 2 && !(s && members(s).length > 1)) {
      if (bar) bar.hidden = true;
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'compareBar';
      bar.className = 'compare-bar';
      $('ptyComposer').before(bar);
      bar.addEventListener('change', (e) => {
        if (e.target.matches('[data-sendall]')) state.compareSendAll = e.target.checked;
      });
      bar.addEventListener('click', (e) => {
        if (e.target.closest('[data-solo]')) {
          const cur = active();
          for (const m of members(cur)) m.compareGroupSolo = !cur.compareGroupSolo;
          layout();
        }
      });
    }
    const all = members(s);
    const running = all.filter((m) => m.status === 'running').length;
    bar.hidden = false;
    bar.innerHTML = `<span class="compare-bar-label">Comparing ${all.length} sessions · ${running} running</span>
      <label class="toggle-row"><input type="checkbox" data-sendall ${state.compareSendAll !== false ? 'checked' : ''}/> <span>Send to all</span></label>
      <span class="grow"></span>
      <button class="btn quiet" data-solo>${s && s.compareGroupSolo ? 'Show side by side' : 'Show one at a time'}</button>`;
  }

  /* ---------------------------------------------------------- broadcast */

  {
    const originalCompose = sendComposer;
    // eslint-disable-next-line no-global-assign
    sendComposer = async function () {
      const s = active();
      const others = members(s).filter((m) => m !== s && m.status === 'running');
      if (!others.length || state.compareSendAll === false) return originalCompose();
      typedForBroadcast = $('ptyInput').value.trim();
      const hadAttachments = (s.imageRefs && s.imageRefs.length) || (s.context && s.context.length);
      broadcasting = true;
      try {
        await originalCompose();
      } finally {
        broadcasting = false;
      }
      if (typedForBroadcast) {
        const text = typedForBroadcast;
        // Each member gets the same message, but never into a question it is stuck on.
        for (const o of others) prepareToSend(o, { quiet: true }).then((ok) => ok && sendText(o, text));
      }
      if (hadAttachments) toast('Attachments went to the focused session only; the others got your text.');
      typedForBroadcast = '';
    };
  }

  return { open, layout, members };
})();

hooks.view.push(() => Compare.layout());
hooks.tabs.push(() => {
  const s = active();
  if (s && s.compareGroup) Compare.layout();
});
hooks.exit.push((s) => {
  if (s.compareGroup) Compare.layout();
});
hooks.launched.push((s) => {
  if (s.compareGroup && active() && active().compareGroup === s.compareGroup) Compare.layout();
});

{
  const original = fitActive;
  // eslint-disable-next-line no-global-assign
  fitActive = function () {
    const s = active();
    const group = Compare.members(s);
    if (group.length > 1 && !s.compareGroupSolo) group.forEach((m) => fitSession(m));
    else original();
  };
}

hooks.shortcut.push((code) => {
  if (code !== 'KeyM') return false;
  Compare.open();
  return true;
});

hooks.boot.push(() => {
  const b = document.createElement('button');
  b.className = 'chip icon-chip home-compare';
  b.setAttribute('aria-label', 'Compare agents');
  b.title = 'Run this prompt on several agents or models at once (Ctrl+Alt+M)';
  b.innerHTML = `${svg('<rect x="3" y="4" width="8" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5"/>', 13)}`;
  b.addEventListener('click', () => Compare.open());
  document.querySelector('#homeComposer .send-key').before(b);
});

registerCommand({ group: 'Start', label: 'Compare agents: one prompt, several models…', keys: 'Ctrl Alt M', run: () => Compare.open() });
