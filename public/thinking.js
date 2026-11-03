/* Splits a model's reasoning from its answer. Shared by the browser UI and Node tests.
 * Recognised wrappers: "Thinking..." / "...done thinking." (Ollama), "[Start thinking]" / "[End thinking]"
 * (llama.cpp's console) and <think> ... </think>. Text with none of them is returned as the answer. */
(function attachThinking(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ezCliThinking = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function thinking() {
  const WRAPPERS = [
    { open: /^[ \t]*Thinking\.\.\.[ \t]*$/m, close: /^[ \t]*\.\.\.done thinking\.[ \t]*$/m },
    { open: /^[ \t]*\[Start thinking\][ \t]*$/m, close: /^[ \t]*\[End thinking\][ \t]*$/m },
    { open: /<think>/, close: /<\/think>/ }
  ];

  /** Earliest wrapper wins. While the closing marker has not arrived, everything after the opening one is reasoning. */
  function splitThinking(text) {
    let best = null;
    for (const w of WRAPPERS) {
      const o = w.open.exec(text);
      if (o && (!best || o.index < best.o.index)) best = { w, o };
    }
    if (!best) return { think: '', answer: text };
    const start = best.o.index + best.o[0].length;
    const rest = text.slice(start);
    const c = best.w.close.exec(rest);
    const before = text.slice(0, best.o.index).trim();
    if (!c) return { think: rest.trim(), answer: before, open: true };
    return { think: rest.slice(0, c.index).trim(), answer: [before, rest.slice(c.index + c[0].length).trim()].filter(Boolean).join('\n'), open: false };
  }

  return { splitThinking };
});
