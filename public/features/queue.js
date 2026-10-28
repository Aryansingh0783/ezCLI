'use strict';
/* Queued messages. While an agent is still working on your last message you can keep typing: the new
 * message waits above the box and is sent as soon as the agent is ready, in order. */

const MessageQueue = {
  list(s) {
    if (!s.queue) s.queue = [];
    return s.queue;
  },

  /** Is this agent busy answering, so a new message should wait its turn? */
  busy(s) {
    if (!s || s.status !== 'running' || !s.working) return false;
    if (s.runAsk || s.webBusy || s.compacting) return true;
    // "working" alone is not trusted (some CLIs redraw constantly): the chat must also be waiting on a reply
    return typeof ChatView !== 'undefined' && ChatView.pendingNow(s);
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
        if (b && cur) this.remove(cur, Number(b.dataset.q));
      });
    }
    const q = s ? this.list(s) : [];
    box.hidden = q.length === 0;
    box.innerHTML = q.map((t, i) => `<div class="queue-item"><b>Queued</b><span title="${esc(t)}">${esc(t)}</span><button type="button" data-q="${i}" aria-label="Remove from the queue" title="Remove">×</button></div>`).join('');
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
  for (const s of state.sessions) if (s.queue && s.queue.length) MessageQueue.drain(s);
}, 1200);
