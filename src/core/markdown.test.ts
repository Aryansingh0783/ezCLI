import { describe, expect, it } from 'vitest';
import { inline, parseBlocks, renderMarkdown, safeCut } from './markdown';

describe('renderMarkdown', () => {
  it('nests bullets under the numbered item they are indented beneath (#44)', () => {
    const html = renderMarkdown('1. A\n   - x\n   - y\n2. B\n   - z\n3. C', true);
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html).toContain('<li>A<ul><li>x</li><li>y</li></ul></li>');
    expect(html.match(/<li>C<\/li>/g)).toHaveLength(1);
  });

  it('keeps the first number of a list that does not start at 1 (#44)', () => {
    expect(renderMarkdown('2. B\n3. C', true)).toBe('<ol start="2"><li>B</li><li>C</li></ol>');
    // a numbered list interrupted by a paragraph resumes at its own number instead of restarting at 1
    const html = renderMarkdown('1. one\n\nsome text\n\n2. two\n3. three');
    expect(html).toBe('<ol><li>one</li></ol><p>some text</p><ol start="2"><li>two</li><li>three</li></ol>');
  });

  it('leaves a plain bullet list as it was', () => {
    expect(renderMarkdown('- a\n- b', true)).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('draws headings, rules, quotes, tables and code', () => {
    const html = renderMarkdown('# Title\n\n---\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```');
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<blockquote>quoted</blockquote>');
    expect(html).toContain('<thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody>');
    expect(html).toContain('<span class="tk-k">const</span>');
  });

  it('never lets message text become markup', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **b** `<script>`');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<strong>b</strong>');
  });

  it('treats an unclosed code fence as code to the end', () => {
    const blocks = parseBlocks('text\n```py\nprint(1)', false, false);
    expect(blocks.map((b) => b.t)).toEqual(['p', 'code']);
    expect(blocks[1]).toMatchObject({ lang: 'py', body: 'print(1)' });
  });
});

describe('parseBlocks while streaming', () => {
  it('leaves only the last block open, and closes it at a blank line', () => {
    const a = parseBlocks('first\n\nsecond', false, true);
    expect(a.map((b) => b.open)).toEqual([false, true]);
    const b = parseBlocks('first\n\nsecond\n\n', false, true);
    expect(b.map((x) => x.open)).toEqual([false, false]);
  });

  it('keeps a code block open until its closing fence arrives', () => {
    expect(parseBlocks('```js\nlet a', false, true)[0]).toMatchObject({ t: 'code', open: true, body: 'let a' });
    expect(parseBlocks('```js\nlet a\n```', false, true)[0]).toMatchObject({ t: 'code', open: false });
    // half a fence is not a fence yet
    expect(parseBlocks('```js\nlet a\n``', false, true)[0]).toMatchObject({ t: 'code', open: true });
  });

  it('gives finished blocks the same source however the text was cut (prefix stability)', () => {
    const full = '# H\n\npara one\nstill para\n\n- a\n- b\n\n```sh\necho hi\n```\n\n1. x\n   - y\n2. z\n\n| a |\n|---|\n| 1 |\n\nend';
    const final = parseBlocks(full, false, false).map((b) => `${b.t}:${b.src}`);
    for (let n = 1; n <= full.length; n++) {
      const part = parseBlocks(full.slice(0, n), false, true);
      const closed = part.filter((b) => !b.open).map((b) => `${b.t}:${b.src}`);
      // every closed block of a prefix, except possibly the very last (which may still grow in the full text), is final
      for (const c of closed.slice(0, -1)) expect(final, `prefix ${n}`).toContain(c);
    }
  });
});

describe('safeCut', () => {
  it('cuts only where no inline markdown is left open', () => {
    expect(safeCut('plain words here')).toBe('plain words '.length);
    expect(safeCut('some **bold text')).toBe('some '.length);
    expect(safeCut('some **bold** text')).toBe('some **bold** '.length);
    expect(safeCut('use `npm run')).toBe('use '.length);
    expect(safeCut('see [the docs](https://exa')).toBe('see '.length);
    expect(safeCut('nospace')).toBe(0);
  });

  it('formatting the two halves equals formatting the whole', () => {
    const line = 'a **b c** d `e f` g [h i](https://x.y/z) j *k l* m';
    for (let n = 0; n <= line.length; n++) {
      const part = line.slice(0, n);
      const cut = safeCut(part);
      // the finished part, once formatted, is a prefix of the fully formatted line
      const whole = inline(line.slice(0, cut)) + inline(line.slice(cut));
      expect(inline(line.slice(0, cut)).length).toBeLessThanOrEqual(whole.length);
      if (n === line.length) expect(whole).toBe(inline(line));
    }
  });
});

describe('bold around a code span', () => {
  it('formats bold that wraps inline code, and leaves the code itself alone', () => {
    const out = inline('**Method 2: Using `extend()` Method**');
    expect(out).toBe('<strong>Method 2: Using <code>extend()</code> Method</strong>');
    expect(inline('use `**not bold**` here')).toBe('use <code>**not bold**</code> here');
    expect(inline('[the `docs`](https://example.com)')).toBe('<a href="https://example.com">the <code>docs</code></a>');
  });
});
