/* Draws one chat message that may still be arriving, without redrawing what is already on screen.
 *
 * The message is parsed into blocks on every update (parsing is cheap; touching the page is not). Each
 * block has an element. The rules:
 *
 *   - A block whose source text is unchanged keeps its element untouched. Finished blocks therefore never
 *     flicker, keep any text selection inside them, and cost nothing.
 *   - The last block, while it is still growing, is extended in place: new text is appended to a text
 *     node (a paragraph's unfinished line, a code block's body), a new list item or table row is added
 *     after the existing ones. Its element is not replaced.
 *   - When a block stops growing it is finished once: a paragraph's last line gets its formatting, a code
 *     block gets its colouring. After that it falls under the first rule.
 *   - Only when the kind of block at a position changes (the text "1" turning into the list "1. First")
 *     is that one element swapped. That can only happen to the last block.
 *
 * `stats` counts what each update did, so tests can assert the rules instead of trusting them. */
import { esc } from './html';
import { blockHtml, highlight, inline, listItemHtml, parseBlocks, safeCut, tableRowHtml, tableRows } from './markdown';
import type { Block } from './markdown';

export interface UpdateStats {
  /** Blocks left exactly as they were. */
  kept: number;
  /** Blocks extended in place (same element). */
  grown: number;
  /** Blocks whose element was swapped for a new one. */
  replaced: number;
  /** New blocks added at the end. */
  appended: number;
  /** Blocks removed from the end. */
  removed: number;
}

/** What is drawn for one block, and how far its growing part has been formatted. */
interface Drawn {
  block: Block;
  el: HTMLElement;
  /** Paragraph only: the raw text that is in `tail` (the unfinished end of the last line). */
  tailText?: string;
  /** Paragraph only: the text node holding the unfinished end. */
  tail?: Text;
  /** Paragraph only: how many characters of `src` are already formatted and in place. */
  done?: number;
  /** Code only: the text node holding the body while it is growing. */
  codeText?: Text;
}

function elementFrom(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.firstElementChild as HTMLElement;
}

export class StreamView {
  readonly el: HTMLElement;
  private drawn: Drawn[] = [];
  private hard = false;
  /** Totals since this view was created. */
  readonly totals: UpdateStats = { kept: 0, grown: 0, replaced: 0, appended: 0, removed: 0 };

  constructor(el: HTMLElement) {
    this.el = el;
  }

  /** The source text currently drawn, block by block (for tests and debugging). */
  get sources(): string[] {
    return this.drawn.map((d) => d.block.src);
  }

  /** The element of each block, in order. */
  get elements(): HTMLElement[] {
    return this.drawn.map((d) => d.el);
  }

  /**
   * Show `text`. `streaming` means more may follow, so the last block is kept open for cheap appends;
   * call once more with `streaming: false` when the message is complete to finish its last block.
   */
  update(text: string, opts: { hard?: boolean; streaming?: boolean } = {}): UpdateStats {
    const hard = Boolean(opts.hard);
    const stats: UpdateStats = { kept: 0, grown: 0, replaced: 0, appended: 0, removed: 0 };
    if (hard !== this.hard && this.drawn.length) this.clear(stats);
    this.hard = hard;
    const blocks = parseBlocks(text, hard, Boolean(opts.streaming));
    for (let i = 0; i < blocks.length; i++) {
      const next = blocks[i] as Block;
      const have = this.drawn[i];
      if (!have) {
        const d = this.draw(next);
        this.el.append(d.el);
        this.drawn.push(d);
        stats.appended++;
      } else if (have.block.t === next.t && have.block.src === next.src && have.block.open === next.open) {
        stats.kept++;
      } else if (this.grow(have, next)) {
        stats.grown++;
      } else {
        const d = this.draw(next);
        have.el.replaceWith(d.el);
        this.drawn[i] = d;
        stats.replaced++;
      }
    }
    while (this.drawn.length > blocks.length) {
      (this.drawn.pop() as Drawn).el.remove();
      stats.removed++;
    }
    for (const k of Object.keys(stats) as Array<keyof UpdateStats>) this.totals[k] += stats[k];
    return stats;
  }

  private clear(stats: UpdateStats): void {
    stats.removed += this.drawn.length;
    for (const d of this.drawn) d.el.remove();
    this.drawn = [];
  }

  /* ---------------------------------------------------------------- first draw */

  private draw(b: Block): Drawn {
    if (b.open && b.t === 'p') return this.drawOpenParagraph(b);
    if (b.open && b.t === 'code') return this.drawOpenCode(b);
    return { block: b, el: elementFrom(blockHtml(b, this.hard)) };
  }

  private paragraphParts(b: Extract<Block, { t: 'p' }>): { html: string; done: number; tail: string } {
    // Finished lines are formatted; so is the finished part of the last line. The rest waits as plain text.
    const sep = this.hard ? '<br>' : ' ';
    const lastLine = b.lines[b.lines.length - 1] ?? '';
    const cut = safeCut(lastLine);
    const head = b.lines.slice(0, -1).map((l) => inline(l));
    const before = head.join(sep) + (head.length ? sep : '');
    return { html: before + inline(lastLine.slice(0, cut)), done: b.src.length - (lastLine.length - cut), tail: lastLine.slice(cut) };
  }

  private drawOpenParagraph(b: Extract<Block, { t: 'p' }>): Drawn {
    const el = document.createElement('p');
    const parts = this.paragraphParts(b);
    el.innerHTML = parts.html;
    const tail = document.createTextNode(parts.tail);
    el.append(tail);
    return { block: b, el, tail, tailText: parts.tail, done: parts.done };
  }

  private drawOpenCode(b: Extract<Block, { t: 'code' }>): Drawn {
    const el = elementFrom(`<div class="cm-code"><div class="cm-code-head"><span>${esc(b.lang.trim() || 'text')}</span><button type="button" class="cm-copy">Copy</button></div><pre><code></code></pre></div>`);
    const codeText = document.createTextNode(b.body);
    (el.querySelector('code') as HTMLElement).append(codeText);
    return { block: b, el, codeText };
  }

  /* ---------------------------------------------------------------- growing in place */

  /** Bring `have` up to `next` without replacing its element. False when that is not possible. */
  private grow(have: Drawn, next: Block): boolean {
    const prev = have.block;
    if (prev.t !== next.t) return false;
    switch (next.t) {
      case 'p':
        return this.growParagraph(have, next);
      case 'code':
        return this.growCode(have, next);
      case 'ul':
      case 'ol':
        return this.growList(have, next);
      case 'table':
        return this.growTable(have, next);
      case 'h':
      case 'quote': {
        // one line that is still being typed: same element, new contents
        have.el.innerHTML = inline(next.text);
        if (next.t === 'h' && (prev as typeof next).level !== next.level) return false;
        have.block = next;
        return true;
      }
      case 'hr':
        have.block = next;
        return true;
    }
  }

  private growParagraph(have: Drawn, next: Extract<Block, { t: 'p' }>): boolean {
    const prev = have.block as Extract<Block, { t: 'p' }>;
    // Was open and the text only got longer: format what has become final, keep the rest as plain text.
    if (have.tail && have.done !== undefined && next.src.startsWith(prev.src)) {
      if (!next.open) return this.finishParagraph(have, next);
      const parts = this.paragraphParts(next);
      if (parts.done >= have.done) {
        const fresh = this.formattedBetween(next, have.done, parts.done);
        if (fresh !== null) {
          if (fresh) {
            const t = document.createElement('template');
            t.innerHTML = fresh;
            have.tail.before(t.content);
          }
          if (have.tail.data !== parts.tail) have.tail.data = parts.tail;
          have.tailText = parts.tail;
          have.done = parts.done;
          have.block = next;
          return true;
        }
      }
    }
    // Anything else (text changed, not just extended): redraw inside the same <p>.
    if (next.open) {
      const d = this.drawOpenParagraph(next);
      have.el.replaceChildren(...Array.from(d.el.childNodes));
      have.tail = d.tail;
      have.tailText = d.tailText;
      have.done = d.done;
    } else {
      have.el.innerHTML = blockHtml(next, this.hard).replace(/^<p>|<\/p>$/g, '');
      have.tail = undefined;
      have.done = undefined;
    }
    have.block = next;
    return true;
  }

  /** The formatted HTML for `src[from, to)` of a paragraph, where both ends sit on finished-markdown
   *  boundaries. Null when the range cannot be formatted on its own. */
  private formattedBetween(b: Extract<Block, { t: 'p' }>, from: number, to: number): string | null {
    if (to === from) return '';
    const piece = b.src.slice(from, to);
    const sep = this.hard ? '<br>' : ' ';
    // `src` joins lines with "\n"; each line is formatted on its own, as in a full draw.
    const lines = piece.split('\n');
    return lines.map((l) => inline(l)).join(sep);
  }

  private finishParagraph(have: Drawn, next: Extract<Block, { t: 'p' }>): boolean {
    const want = blockHtml(next, this.hard).replace(/^<p>|<\/p>$/g, '');
    const tail = have.tail as Text;
    // Usually only the unfinished end needs its formatting; everything before it is already right.
    const rest = next.src.slice(have.done ?? 0);
    const restHtml = rest.split('\n').map((l) => inline(l)).join(this.hard ? '<br>' : ' ');
    const t = document.createElement('template');
    t.innerHTML = restHtml;
    tail.replaceWith(t.content);
    if (have.el.innerHTML !== want) have.el.innerHTML = want;
    have.tail = undefined;
    have.tailText = undefined;
    have.done = undefined;
    have.block = next;
    return true;
  }

  private growCode(have: Drawn, next: Extract<Block, { t: 'code' }>): boolean {
    const prev = have.block as Extract<Block, { t: 'code' }>;
    if (prev.lang !== next.lang) return false;
    const code = have.el.querySelector('code') as HTMLElement;
    if (next.open) {
      if (have.codeText && next.body.startsWith(prev.body)) {
        if (next.body.length > prev.body.length) have.codeText.appendData(next.body.slice(prev.body.length));
      } else {
        have.codeText = document.createTextNode(next.body);
        code.replaceChildren(have.codeText);
      }
    } else {
      // finished: colour it once
      code.innerHTML = highlight(next.body.replace(/\n$/, ''));
      have.codeText = undefined;
    }
    have.block = next;
    return true;
  }

  /** Keep the child elements whose HTML is unchanged, rewrite the ones that differ, add and drop at the end. */
  private syncChildren(parent: Element, before: string[], after: string[]): void {
    const n = Math.min(before.length, after.length);
    for (let i = 0; i < n; i++) {
      if (before[i] === after[i]) continue;
      const child = parent.children[i];
      if (child) child.outerHTML = after[i] as string;
    }
    for (let i = parent.children.length - 1; i >= after.length; i--) (parent.children[i] as Element).remove();
    if (after.length > before.length) parent.insertAdjacentHTML('beforeend', after.slice(before.length).join(''));
  }

  private growList(have: Drawn, next: Extract<Block, { t: 'ul' | 'ol' }>): boolean {
    const prev = have.block as Extract<Block, { t: 'ul' | 'ol' }>;
    if (prev.start !== next.start) return false;
    this.syncChildren(have.el, prev.items.map(listItemHtml), next.items.map(listItemHtml));
    have.block = next;
    return true;
  }

  private growTable(have: Drawn, next: Extract<Block, { t: 'table' }>): boolean {
    const prev = have.block as Extract<Block, { t: 'table' }>;
    const a = tableRows(prev.rows);
    const b = tableRows(next.rows);
    const head = have.el.querySelector('thead');
    const body = have.el.querySelector('tbody');
    if (!head || !body) return false;
    if ((a[0] ?? '') !== (b[0] ?? '')) head.innerHTML = tableRowHtml(b[0] ?? '', true);
    this.syncChildren(body, a.slice(1).map((r) => tableRowHtml(r, false)), b.slice(1).map((r) => tableRowHtml(r, false)));
    have.block = next;
    return true;
  }
}
