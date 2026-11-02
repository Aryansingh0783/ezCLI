'use strict';
/* Claude desktop details: the spark beside the greeting, Claude's five starter chips
 * (Write, Learn, Code, Life stuff, Claude's choice), and the account row at the foot of the sidebar. */

const CLAUDE_SPARK =
  '<svg class="claude-spark" width="34" height="34" viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><rect x="10.9" y="1.5" width="2.2" height="21" rx="1.1"/><rect x="10.9" y="1.5" width="2.2" height="21" rx="1.1" transform="rotate(45 12 12)"/><rect x="10.9" y="1.5" width="2.2" height="21" rx="1.1" transform="rotate(90 12 12)"/><rect x="10.9" y="1.5" width="2.2" height="21" rx="1.1" transform="rotate(135 12 12)"/></g></svg>';

const CLAUDE_CHIPS = [
  { label: 'Write', icon: '<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M14 7l3 3"/>', text: 'Help me write ' },
  { label: 'Learn', icon: '<path d="M3 8l9-4 9 4-9 4-9-4z"/><path d="M7 10.5V15c0 1.5 2.2 3 5 3s5-1.500 5-3v-4.500"/>', text: 'Teach me about ' },
  { label: 'Code', icon: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.500 5l-3 14"/>', text: 'Help me write code to ' },
  { label: 'Life stuff', icon: '<path d="M12 20s-7-4.500-7-10a4 4 0 0 1 7-2.500A4 4 0 0 1 19 10c0 5.500-7 10-7 10z"/>', text: 'I need help with ' },
  { label: "Claude's choice", icon: '<path d="M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800L12 3z"/>', text: 'Surprise me: pick something useful to do in this project and do it.' }
];

/* Starters: replace the project-specific ideas with Claude's chips. Clicking still only fills the box. */
Starters.ideas = () => CLAUDE_CHIPS;
Starters.render = function () {
  if (!this.box) return;
  const html = CLAUDE_CHIPS.map(
    (x, i) =>
      `<button type="button" class="starter" data-i="${i}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${x.icon}</svg>${esc(x.label)}</button>`
  ).join('');
  if (html !== this.html) {
    this.html = html;
    this.box.innerHTML = html;
  }
  this.sync();
};

function mountClaudeSpark() {
  const title = $('homeTitle');
  if (!title || document.querySelector('.greet-row')) return;
  const row = document.createElement('div');
  row.className = 'greet-row';
  title.before(row);
  row.insertAdjacentHTML('afterbegin', CLAUDE_SPARK);
  row.append(title);
}

function renderAccountRow() {
  const rail = document.querySelector('.rail');
  if (!rail) return;
  let row = $('railAccount');
  if (!row) {
    row = document.createElement('button');
    row.type = 'button';
    row.id = 'railAccount';
    row.className = 'rail-account';
    row.addEventListener('click', () => $('settingsBtn').click());
    rail.append(row);
  }
  const name = String(prefs.displayName || '').trim() || 'You';
  const ini = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const html = `<span class="acct-ini">${esc(ini)}</span><span class="acct-text"><span class="acct-name">${esc(name)}</span><span class="acct-plan">ezCLI</span></span>`;
  if (row.innerHTML !== html) row.innerHTML = html;
}

hooks.boot.push(() => {
  mountClaudeSpark();
  renderAccountRow();
  Starters.render();
});
hooks.view.push(renderAccountRow);
