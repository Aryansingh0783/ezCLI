'use strict';
/* Find in terminal output. Ctrl+Shift+F opens a small bar over the terminal;
 * typing searches the session's whole scrollback, Enter / Shift+Enter step
 * through the matches and Esc closes it. It reads the terminal's own text
 * buffer (no add-on), joins lines the terminal wrapped, and matches plain
 * text case-insensitively, so characters like "(" or "." are never special. */

const Find = (() => {
  let bar = null;
  let matches = [];
  let at = -1;
  let timer = 0;
  let openFor = null;

  /** All matches of `query` in the session's buffer as {row, col, len}. */
  function search(term, query, limit = 2000) {
    const out = [];
    if (!query) return out;
    const needle = query.toLowerCase();
    const buf = term.buffer.active;
    const cols = term.cols;
    let i = 0;
    while (i < buf.length && out.length < limit) {
      // One logical line: a row plus the rows the terminal wrapped onto it.
      const start = i;
      let text = buf.getLine(i).translateToString(false);
      i++;
      while (i < buf.length && buf.getLine(i).isWrapped) {
        text += buf.getLine(i).translateToString(false);
        i++;
      }
      const hay = text.toLowerCase();
      let from = 0;
      for (let k = hay.indexOf(needle, from); k !== -1 && out.length < limit; k = hay.indexOf(needle, from)) {
        out.push({ row: start + Math.floor(k / cols), col: k % cols, len: needle.length });
        from = k + Math.max(1, needle.length);
      }
    }
    return out;
  }

  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'find-bar';
    bar.setAttribute('role', 'search');
    bar.innerHTML = `
      <input type="text" class="find-input" placeholder="Find in output" aria-label="Find in terminal output" spellcheck="false" autocomplete="off" />
      <span class="find-count" aria-live="polite"></span>
      <button type="button" class="find-btn" data-find="prev" aria-label="Previous match" title="Previous (Shift+Enter)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 15 6-6 6 6" /></svg></button>
      <button type="button" class="find-btn" data-find="next" aria-label="Next match" title="Next (Enter)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6" /></svg></button>
      <button type="button" class="find-btn" data-find="close" aria-label="Close find" title="Close (Esc)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" /></svg></button>`;
    const input = bar.querySelector('.find-input');
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 80);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-find]');
      if (!b) return;
      if (b.dataset.find === 'close') close();
      else step(b.dataset.find === 'next' ? 1 : -1);
    });
    document.querySelector('.terminal-panel').appendChild(bar);
    return bar;
  }

  function show(i) {
    const s = active();
    const count = bar.querySelector('.find-count');
    if (!s || !matches.length) {
      count.textContent = bar.querySelector('.find-input').value ? 'No results' : '';
      bar.classList.toggle('none', Boolean(bar.querySelector('.find-input').value));
      if (s) s.term.clearSelection();
      return;
    }
    bar.classList.remove('none');
    at = ((i % matches.length) + matches.length) % matches.length;
    const m = matches[at];
    s.term.select(m.col, m.row, m.len);
    // Keep the match roughly centred instead of jammed against an edge.
    s.term.scrollToLine(Math.max(0, m.row - Math.floor(s.term.rows / 2)));
    count.textContent = `${at + 1} of ${matches.length}${matches.length >= 2000 ? '+' : ''}`;
  }

  function run() {
    const s = active();
    if (!s || !bar) return;
    matches = search(s.term, bar.querySelector('.find-input').value);
    // Start from the match nearest the bottom, where the newest output is.
    show(matches.length ? matches.length - 1 : 0);
  }

  function step(dir) {
    if (!matches.length) return run();
    show(at + dir);
  }

  function open() {
    if (typeof ChatView !== 'undefined' && ChatView.visible()) return ChatFind.open();
    const s = active();
    if (!s) return toast('Open a session first, then search its output.');
    ensureBar().classList.add('open');
    openFor = s.id;
    const input = bar.querySelector('.find-input');
    // Searching for what is already selected is the common case.
    const sel = s.term.hasSelection() ? s.term.getSelection().trim() : '';
    if (sel && !sel.includes('\n') && sel.length < 120) input.value = sel;
    input.focus();
    input.select();
    run();
  }

  function close() {
    if (!bar) return;
    bar.classList.remove('open');
    matches = [];
    at = -1;
    const s = active();
    if (s) {
      s.term.clearSelection();
      s.term.focus();
    }
  }

  return { open, close, search, isOpen: () => Boolean(bar && bar.classList.contains('open')), openFor: () => openFor };
})();

hooks.boot.push(() => {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyF') {
        e.preventDefault();
        Find.open();
      }
    },
    true
  );
  // A different tab has a different buffer; close rather than search the wrong one.
  hooks.view.push((s) => {
    if (Find.isOpen() && (!s || s.id !== Find.openFor())) Find.close();
  });
});

registerCommand({ group: 'Session', label: 'Find in terminal output', keys: 'Ctrl Shift F', when: () => Boolean(active()), run: () => Find.open() });
