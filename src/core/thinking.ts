/* Splits a model's reasoning from its answer.
 *
 * Recognised wrappers: "Thinking..." / "...done thinking." (Ollama), "[Start thinking]" / "[End thinking]"
 * (llama.cpp's console) and <think> ... </think>. Text with none of them is all answer.
 *
 * The text arrives a few characters at a time, so a marker is often cut in half: "<thi" now, "nk>" on the
 * next read. Half a marker is held back rather than shown, otherwise it would appear in the answer for a
 * moment and then jump into the Thinking block. */

export interface Split {
  /** The reasoning, without its markers. */
  think: string;
  /** Everything that is not reasoning. */
  answer: string;
  /** The opening marker has arrived but the closing one has not: the model is still thinking. */
  open?: boolean;
}

interface Wrapper {
  open: RegExp;
  close: RegExp;
  /** The literal markers, used to spot one that is only partly here. */
  openText: string;
  closeText: string;
  /** The marker must be alone on its line. */
  line: boolean;
}

const WRAPPERS: Wrapper[] = [
  { open: /^[ \t]*Thinking\.\.\.[ \t]*$/m, close: /^[ \t]*\.\.\.done thinking\.[ \t]*$/m, openText: 'Thinking...', closeText: '...done thinking.', line: true },
  { open: /^[ \t]*\[Start thinking\][ \t]*$/m, close: /^[ \t]*\[End thinking\][ \t]*$/m, openText: '[Start thinking]', closeText: '[End thinking]', line: true },
  { open: /<think>/, close: /<\/think>/, openText: '<think>', closeText: '</think>', line: false }
];

/** How many characters at the end of `text` are the start of `marker` (but not all of it). */
function partialAtEnd(text: string, marker: string, line: boolean): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let n = max; n > 0; n--) {
    if (!text.endsWith(marker.slice(0, n))) continue;
    if (!line) return n;
    // a line marker only counts when nothing else is on that line before it
    const before = text.slice(0, text.length - n);
    const lineStart = before.lastIndexOf('\n') + 1;
    if (/^[ \t]*$/.test(before.slice(lineStart))) return n;
  }
  return 0;
}

/** Drop a half-arrived marker from the end of text that is still growing. */
function withoutPartial(text: string, markers: Array<[string, boolean]>): string {
  let cut = 0;
  for (const [marker, line] of markers) cut = Math.max(cut, partialAtEnd(text, marker, line));
  return cut ? text.slice(0, text.length - cut) : text;
}

/**
 * Earliest wrapper wins. Until the closing marker arrives, everything after the opening one is reasoning.
 * `streaming` says more text may follow, which is when half a marker at the end is held back.
 */
export function splitThinking(text: string, streaming = false): Split {
  let best: { w: Wrapper; index: number; length: number } | null = null;
  for (const w of WRAPPERS) {
    const o = w.open.exec(text);
    if (o && (!best || o.index < best.index)) best = { w, index: o.index, length: o[0].length };
  }
  if (!best) {
    if (!streaming) return { think: '', answer: text };
    return { think: '', answer: withoutPartial(text, WRAPPERS.map((w) => [w.openText, w.line])) };
  }
  const start = best.index + best.length;
  const rest = text.slice(start);
  const c = best.w.close.exec(rest);
  const before = text.slice(0, best.index).trim();
  if (!c) {
    const think = streaming ? withoutPartial(rest, [[best.w.closeText, best.w.line]]) : rest;
    return { think: think.trim(), answer: before, open: true };
  }
  const after = rest.slice(c.index + c[0].length).trim();
  return { think: rest.slice(0, c.index).trim(), answer: [before, after].filter(Boolean).join('\n'), open: false };
}
