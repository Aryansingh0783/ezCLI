import { beforeEach, describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';
import { StreamView } from './stream-view';

let host: HTMLElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.replaceChildren(host);
});

const SAMPLE = [
  '# Plan',
  '',
  'First paragraph with **bold words** and `inline code` in it.',
  'It has a second line and a [link](https://example.com/a).',
  '',
  '1. Step one',
  '   - detail a',
  '   - detail b',
  '2. Step two',
  '',
  '```ts',
  'const answer: number = 42;',
  'console.log(`value: ${answer}`);',
  '```',
  '',
  '| name | value |',
  '|------|-------|',
  '| a    | 1     |',
  '| b    | 2     |',
  '',
  '> a closing remark',
  '',
  'Done.'
].join('\n');

/** Deterministic pseudo-random chunk sizes, so a failure can be reproduced from its seed. */
function chunks(text: string, seed: number, max: number): string[] {
  const out: string[] = [];
  let x = seed;
  let at = 0;
  while (at < text.length) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const n = 1 + (x % max);
    out.push(text.slice(at, at + n));
    at += n;
  }
  return out;
}

/** Feed `text` in pieces and check, at every step, that no element of an earlier block was touched. */
function stream(text: string, pieces: string[], hard = false) {
  const view = new StreamView(host);
  let shown = '';
  const frozen = new Map<Element, string>();
  let mutationsInFrozen = 0;
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const el of frozen.keys()) if (el === r.target || el.contains(r.target)) mutationsInFrozen++;
    }
  });
  observer.observe(host, { childList: true, subtree: true, characterData: true, attributes: true });
  for (const piece of pieces) {
    shown += piece;
    const before = view.elements.slice();
    const stats = view.update(shown, { hard, streaming: true });
    observer.takeRecords().forEach((r) => {
      for (const el of frozen.keys()) if (el === r.target || el.contains(r.target)) mutationsInFrozen++;
    });
    // The last block is still growing, and the one before it can still absorb a line that is only half
    // typed ("2" is a paragraph until it becomes "2. Step two" and joins the list above). Everything
    // earlier is finished: its element must be the very same node, with the same HTML, from now on.
    const now = view.elements;
    for (let i = 0; i < now.length - 2; i++) {
      const el = now[i] as HTMLElement;
      if (!frozen.has(el)) frozen.set(el, el.outerHTML);
      else expect(el.outerHTML, `block ${i} changed after it was finished`).toBe(frozen.get(el));
    }
    // elements only ever disappear from the end (the growing block changing kind), never from the middle
    for (let i = 0; i < Math.min(before.length, now.length) - 2; i++) expect(now[i]).toBe(before[i]);
    expect(stats.replaced).toBeLessThanOrEqual(1);
  }
  view.update(shown, { hard, streaming: false });
  observer.disconnect();
  return { view, mutationsInFrozen };
}

describe('StreamView', () => {
  it('ends with exactly the HTML a one-shot render gives, for any way of cutting the text', () => {
    const want = renderMarkdown(SAMPLE);
    for (const [seed, max] of [[1, 1], [7, 3], [42, 9], [99, 40], [5, 200]] as const) {
      const { view } = stream(SAMPLE, chunks(SAMPLE, seed, max));
      expect(view.el.innerHTML, `seed ${seed}, pieces up to ${max}`).toBe(want);
      host.replaceChildren();
    }
  });

  it('never touches a block once it is finished: zero mutations inside finished blocks', () => {
    for (const seed of [3, 11, 2024]) {
      const { mutationsInFrozen } = stream(SAMPLE, chunks(SAMPLE, seed, 6));
      expect(mutationsInFrozen, `seed ${seed}`).toBe(0);
      host.replaceChildren();
    }
  });

  it('replaces no parent element while text streams character by character', () => {
    const view = new StreamView(host);
    let replaced = 0;
    let shown = '';
    for (const ch of 'A plain sentence that keeps growing, one character at a time, without any markup.') {
      shown += ch;
      replaced += view.update(shown, { streaming: true }).replaced;
    }
    expect(replaced).toBe(0);
    expect(host.children).toHaveLength(1);
  });

  it('appends code to one text node and colours the block once, when its fence closes', () => {
    const view = new StreamView(host);
    view.update('```js\ncon', { streaming: true });
    const block = host.firstElementChild as HTMLElement;
    const code = block.querySelector('code') as HTMLElement;
    const text = code.firstChild as Text;
    view.update('```js\nconst a = 1;', { streaming: true });
    view.update('```js\nconst a = 1;\nconst b', { streaming: true });
    expect(host.firstElementChild).toBe(block);
    expect(code.firstChild).toBe(text);
    expect(text.data).toBe('const a = 1;\nconst b');
    expect(code.querySelector('span')).toBeNull();
    view.update('```js\nconst a = 1;\nconst b = 2;\n```\n', { streaming: true });
    expect(host.firstElementChild).toBe(block);
    expect(code.querySelectorAll('.tk-k')).toHaveLength(2);
  });

  it('copes with a code fence split across chunks and with backticks that never close', () => {
    const text = 'Run this:\n\n```sh\nnpm test\n```\n\nand note the `unclosed tick\n\nnext paragraph';
    for (const seed of [1, 2, 3, 4, 5]) {
      const { view } = stream(text, chunks(text, seed, 2));
      expect(view.el.innerHTML).toBe(renderMarkdown(text));
      host.replaceChildren();
    }
  });

  it('adds list items after the existing ones and rewrites only the item being typed', () => {
    const view = new StreamView(host);
    view.update('- alpha\n- be', { streaming: true });
    const list = host.firstElementChild as HTMLElement;
    const first = list.children[0];
    view.update('- alpha\n- beta\n- gam', { streaming: true });
    expect(host.firstElementChild).toBe(list);
    expect(list.children[0]).toBe(first);
    expect(list.children).toHaveLength(3);
    expect(list.children[1]?.textContent).toBe('beta');
  });

  it('keeps nested lists and list numbers right while they stream', () => {
    const text = '1. A\n   - x\n   - y\n2. B\n   - z\n3. C\n\ntext\n\n4. D\n5. E';
    for (const seed of [8, 9, 10]) {
      const { view } = stream(text, chunks(text, seed, 3), true);
      expect(view.el.innerHTML).toBe(renderMarkdown(text, true));
      expect(view.el.querySelector('ol[start="4"]')).not.toBeNull();
      host.replaceChildren();
    }
  });

  it('keeps terminal-wrapped text and its line breaks identical to a one-shot render', () => {
    const text = 'short line\nanother short line\n\n' + 'word '.repeat(30).trim() + '\ncontinues here\n\n- item';
    const { view } = stream(text, chunks(text, 21, 5), true);
    expect(view.el.innerHTML).toBe(renderMarkdown(text, true));
  });

  it('redraws in place when earlier text changes instead of only growing', () => {
    const view = new StreamView(host);
    view.update('one\n\ntwo\n\nthree', { streaming: true });
    const [a, , c] = view.elements;
    const stats = view.update('one\n\nTWO changed\n\nthree', { streaming: true });
    expect(stats.replaced).toBe(0);
    expect(view.elements[0]).toBe(a);
    expect(view.elements[2]).toBe(c);
    expect(view.el.innerHTML).toBe('<p>one</p><p>TWO changed</p><p>three</p>');
    view.update('one', { streaming: false });
    expect(view.el.innerHTML).toBe('<p>one</p>');
  });

  it('holds unfinished inline markdown as plain text and formats it when it completes', () => {
    const view = new StreamView(host);
    view.update('this is **bo', { streaming: true });
    expect(host.querySelector('strong')).toBeNull();
    expect(host.textContent).toBe('this is **bo');
    view.update('this is **bold** now ', { streaming: true });
    expect(host.querySelector('strong')?.textContent).toBe('bold');
    expect(host.textContent).toBe('this is bold now');
  });
});
