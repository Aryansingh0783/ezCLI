import { late } from '../late';
import { $, __set_queueNext, active, autoGrow, esc, hooks, sendComposer, sendPlain, state } from '../app';
/* Queued messages. Enter always sends right away. While an agent is still working you can instead press
 * Ctrl+Enter (or the Queue button) to make a message wait above the box; it goes out as soon as the agent
 * is ready, in order, and each waiting message has Send now, Edit and Remove. */

export const MessageQueue = {
  list(s) {
    if (!s.queue) s.queue = [];
    return s.queue;
  },

  /** Is this agent busy answering, so a new message should wait its turn? */
  busy(s) {
    if (!s || s.status !== 'running' || !s.working) return false;
    if (s.runAsk || s.webBusy || s.compacting) return true;
    // "working" alone is not trusted (some CLIs redraw constantly): the chat must also be waiting on a reply
    return typeof late.ChatView !== 'undefined' && late.ChatView.pendingNow(s);
  },

  add(s, text) {
    this.list(s).push(String(text).trim());
    this.render();
  },

  remove(s, i) {
    this.list(s).splice(i, 1);
    this.render();
  },

  render() {
    const s = active();
    let box = document.getElementById('queueList');
    if (!box) {
      const composer = document.getElementById('ptyComposer');
      if (!composer) return;
      box = document.createElement('div');
      box.id = 'queueList';
      box.className = 'queue-list';
      box.setAttribute('aria-label', 'Queued messages');
      composer.insertBefore(box, composer.firstChild);
      box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-q]');
        const cur = active();
        if (!b || !cur) return;
        const i = Number(b.dataset.q);
        if (b.dataset.do === 'now') this.sendNow(cur, i);
        else if (b.dataset.do === 'edit') this.edit(cur, i);
        else this.remove(cur, i);
      });
    }
    const q = s ? this.list(s) : [];
    box.hidden = q.length === 0;
    box.innerHTML = q
      .map(
        (t, i) =>
          `<div class="queue-item"><b>Queued</b><span title="${esc(t)}">${esc(t)}</span>` +
          `<button type="button" class="q-now" data-q="${i}" data-do="now" title="Send this now">Send now</button>` +
          `<button type="button" data-q="${i}" data-do="edit" aria-label="Edit" title="Edit">Edit</button>` +
          `<button type="button" data-q="${i}" data-do="remove" aria-label="Remove from the queue" title="Remove">×</button></div>`
      )
      .join('');
    this.syncButton();
  },

  /** Send a waiting message immediately, ahead of the rest. */
  async sendNow(s, i) {
    const [text] = this.list(s).splice(i, 1);
    this.render();
    if (text && s.status === 'running') await sendPlain(s, text);
  },

  /** Take a waiting message back into the box to change it. */
  edit(s, i) {
    const [text] = this.list(s).splice(i, 1);
    this.render();
    const box = $('ptyInput');
    if (!text || !box) return;
    box.value = box.value.trim() ? `${text}\n${box.value}` : text;
    s.draft = box.value;
    autoGrow(box);
    box.focus();
  },

  /** "Queue" appears next to Send while the agent is busy and there is something typed. */
  syncButton() {
    const send = document.getElementById('btnSend');
    if (!send) return;
    let b = document.getElementById('btnQueue');
    if (!b) {
      b = document.createElement('button');
      b.type = 'button';
      b.id = 'btnQueue';
      b.className = 'chip queue-btn';
      b.title = 'Wait for the reply to finish, then send (Ctrl+Enter)';
      b.textContent = 'Queue';
      b.hidden = true;
      b.addEventListener('click', () => {
        __set_queueNext(true);
        sendComposer();
      });
      send.before(b);
      const box = document.getElementById('ptyInput');
      if (box) box.addEventListener('input', () => this.syncButton());
    }
    const s = active();
    const box = document.getElementById('ptyInput');
    b.hidden = !(s && box && box.value.trim() && this.busy(s));
  },

  /** Send the next waiting message once the agent is free. */
  async drain(s) {
    if (!s || s.draining || !s.queue || !s.queue.length || s.status !== 'running') return;
    if (this.busy(s)) return;
    s.draining = true;
    try {
      const text = s.queue.shift();
      this.render();
      await sendPlain(s, text);
    } finally {
      s.draining = false;
    }
  }
};

hooks.idle.push((s) => MessageQueue.drain(s));
hooks.tabs.push(() => MessageQueue.render());
hooks.view.push(() => MessageQueue.render());
// a quiet agent can stay "working" for a moment after it finishes; look again every second
setInterval(() => {
  MessageQueue.syncButton();
  for (const s of state.sessions) if (s.queue && s.queue.length) MessageQueue.drain(s);
}, 1200);

Object.assign(late, { MessageQueue });
