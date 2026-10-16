'use strict';
/* Provider web chats (experimental).
 *
 * For plans without CLI access, such as Claude Free, this opens the
 * provider's own website in a separate window. You sign in there yourself.
 * The window has no ezCLI permissions, and ezCLI does not read, script or
 * relay anything in it. It is a convenience, not a backend. */

const WEB_CHATS = [
  { id: 'claude', label: 'Claude', note: 'claude.ai · works on the free plan' },
  { id: 'chatgpt', label: 'ChatGPT', note: 'chatgpt.com' },
  { id: 'gemini', label: 'Gemini', note: 'gemini.google.com' },
  { id: 'copilot', label: 'Copilot', note: 'copilot.microsoft.com' }
];

function openWebChat(id) {
  invoke('open_web_chat', { provider: id }).catch((err) => toast(String(err), 'error'));
}

function webChatMenu(anchor) {
  openMenu(anchor, {
    title: 'Web chat · experimental',
    items: [
      ...WEB_CHATS.map((w) => ({ label: w.label, hint: w.note, run: () => openWebChat(w.id) })),
      { sep: true },
      { label: 'Opens the provider’s own site in its own window. You sign in there.', disabled: true }
    ]
  });
}

hooks.boot.push(() => {
  const b = document.createElement('button');
  b.className = 'chip home-webchat';
  b.title = 'Open a provider’s web chat in its own window (experimental)';
  b.innerHTML = `${ICONS.chat} Web chat`;
  b.addEventListener('click', (e) => webChatMenu(e.currentTarget));
  $('agentStrip').after(b);
});

for (const w of WEB_CHATS) {
  registerCommand({ group: 'Web chat', label: `Open ${w.label} web chat`, hint: w.note, run: () => openWebChat(w.id) });
}
