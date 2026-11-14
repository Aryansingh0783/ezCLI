/* Markdown for chat messages, as blocks.
 *
 * `parseBlocks` turns a message into a list of blocks (paragraph, list, code, table…). Each block carries
 * the exact source text it was made from, so two parses of a growing message can be compared block by
 * block: blocks that are finished keep the same source and never need to be drawn again. Only the last
 * block can still be growing (`open`). `blockHtml` draws one block; `renderMarkdown` draws a whole message
 * in one go (exports, tests, finished messages).
 *
 * The dialect is the one the chat has always shown: headings, bullets and numbered lists (a bullet
 * indented under a numbered item nests inside it; a numbered list keeps its own first number), block
 * quotes, tables, rules, fenced code, and inline bold, italic, code, and links. */
import { esc } from './html';

export type Block =
  | { t: 'p'; src: string; open: boolean; lines: string[] }
  | { t: 'h'; src: string; open: boolean; level: number; text: string }
  | { t: 'hr'; src: string; open: boolean }
  | { t: 'ul' | 'ol'; src: string; open: boolean; start: number; items: ListItem[] }
  | { t: 'quote'; src: string; open: boolean; text: string }
  | { t: 'table'; src: string; open: boolean; rows: string[] }
  | { t: 'code'; src: string; open: boolean; lang: string; body: string };

export interface ListItem {
  text: string;
  /** Bullets nested under a numbered item. */
  sub: string[];
}

/* ------------------------------------------------------------------ inline */

const FILE_EXT = /^(js|mjs|cjs|jsx|ts|tsx|json|md|mdx|css|scss|less|html|htm|vue|svelte|rs|py|go|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|toml|yaml|yml|lock|txt|sh|ps1|bat|cmd|sql|xml|ini|cfg|conf|gradle|dart|lua|zig|ex|exs|scala|dockerfile|env|csv|svg|png|jpg|gif)$/i;

/** Text that names a file: a path with a folder, or a name with a known extension. */
export function looksLikePath(text: unknown): boolean {
  const x = String(text || '').trim();
  if (!x || x.length > 260 || /\s/.test(x) || /^(https?:|www\.)/i.test(x) || /^v?\d+(\.\d+)+$/.test(x)) return false;
  const m = /^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]*[A-Za-z_][\w@-]*\.([A-Za-z][A-Za-z0-9]{0,5})(?::\d+(?::\d+)?)?$/.exec(x);
  if (!m) return false;
  // `src/app.js` is a file; `console.log` is code. Without a folder, only known file types count.
  return /[\\/]/.test(x) || FILE_EXT.test(m[1] ?? '');
}

/** Inline code; a file path becomes a link that opens it in the explorer. */
export function codeSpan(text: string): string {
  if (!looksLikePath(text)) return `<code>${esc(text)}</code>`;
  return `<code class="cm-path" role="link" tabindex="0" data-path="${esc(text)}" title="Open in the explorer">${esc(text)}</code>`;
}

/** Bold, italic, code spans and links within one line. Code spans are set aside first, so bold or a link
 *  can wrap one (`**Using `extend()`**`) and nothing inside a code span is formatted. */
export function inline(src: string): string {
  const codes: string[] = [];
  let t = esc(String(src).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`));
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\s][^*\n]*)\*(?![*\w])/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)\u0000]+)/g, '$1<a href="$2">$2</a>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => codeSpan(codes[Number(i)] ?? ''));
}

/**
 * Where a line that is still being written can be cut so that everything before the cut is finished
 * inline markdown: no bold, italic, code span or link left open. Returns the index after the last such
 * whitespace (0 when there is none). Text before it can be formatted now and will not change.
 */
export function safeCut(line: string): number {
  let code = false;
  let bold = false;
  let italic = false;
  let bracket = 0;
  let paren = false;
  let safe = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '`') code = !code;
    else if (code) continue;
    else if (ch === '*') {
      if (line[i + 1] === '*') {
        bold = !bold;
        i++;
      } else if (italic || /\S/.test(line[i + 1] ?? '')) italic = !italic; // "2 * 3" is not emphasis
    } else if (ch === '[') bracket++;
    else if (ch === ']') {
      if (bracket > 0) bracket--;
      if (line[i + 1] === '(') paren = true;
    } else if (ch === ')') paren = false;
    else if ((ch === ' ' || ch === '\t') && !bold && !italic && bracket === 0 && !paren) safe = i + 1;
  }
  return safe;
}

/* ------------------------------------------------------------------ code */

const TOKENS =
  /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|(?<![^\s])#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b(const|let|var|function|return|if|else|for|while|import|from|export|default|class|new|async|await|try|catch|throw|def|fn|pub|use|impl|struct|enum|match|self|None|True|False|null|true|false|undefined|in|of|and|or|not|with|as|type|interface|extends|switch|case|break|continue|echo|git|npm|cd)\b/g;

/** Light colouring for code: comments, strings, numbers and common keywords. */
export function highlight(body: string): string {
  if (body.length > 20000) return esc(body);
  let out = '';
  let last = 0;
  TOKENS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKENS.exec(body))) {
    out += esc(body.slice(last, m.index));
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : 'k';
    out += `<span class="tk-${cls}">${esc(m[0])}</span>`;
    last = TOKENS.lastIndex;
    if (!m[0].length) TOKENS.lastIndex++;
  }
  return out + esc(body.slice(last));
}

export function codeHtml(lang: string, body: string, highlighted = true): string {
  return `<div class="cm-code"><div class="cm-code-head"><span>${esc(lang.trim() || 'text')}</span><button type="button" class="cm-copy">Copy</button></div><pre><code>${highlighted ? highlight(body) : esc(body)}</code></pre></div>`;
}

/* ------------------------------------------------------------------ wrapped text */

/** A CLI that wraps its own output at the terminal width leaves a line break in the middle of every
 *  sentence. Join those lines (a line that runs to the wrap width continues on the next). */
export function joinWrapped(text: string): string {
  const lines = text.split('\n');
  const width = Math.max(0, ...lines.map((l) => l.length));
  if (width < 40) return text;
  const startsBlock = /^\s*([-*+•]\s|\d+[.)]\s|#{1,6}\s|>|\||\s{2,}\S)/;
  const never = /^\s*(#{1,6}\s|\||>)/;
  const out: string[] = [];
  let prevLen = 0;
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.trim() && l.trim() && prevLen >= width * 0.8 && !startsBlock.test(l) && !never.test(prev)) out[out.length - 1] = `${prev.replace(/\s+$/, '')} ${l.trim()}`;
    else out.push(l);
    prevLen = l.length;
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ blocks */

const FENCE = /^\s*```/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/** The text blocks of a stretch with no code fences in it. `ended` says the stretch is complete (a code
 *  block or the end of a finished message follows), so its last block is not left open. */
function textBlocks(text: string, ended: boolean, out: Block[]): void {
  const lines = text.split('\n');
  let para: string[] = [];
  let list: Extract<Block, { t: 'ul' | 'ol' }> | null = null;
  let listSrc: string[] = [];
  const flushP = () => {
    if (para.length) out.push({ t: 'p', src: para.join('\n'), open: false, lines: para });
    para = [];
  };
  const flushL = () => {
    if (list) {
      list.src = listSrc.join('\n');
      out.push(list);
    }
    list = null;
    listSrc = [];
  };
  let closedByBlank = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? '';
    let m: RegExpExecArray | null;
    closedByBlank = false;
    if (!ln.trim()) {
      flushP();
      flushL();
      closedByBlank = true;
    } else if ((m = /^(#{1,4})\s+(.*)$/.exec(ln))) {
      flushP();
      flushL();
      out.push({ t: 'h', src: ln, open: false, level: (m[1] ?? '').length + 1, text: m[2] ?? '' });
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(ln)) {
      flushP();
      flushL();
      out.push({ t: 'hr', src: ln, open: false });
    } else if ((m = /^(\s*)[-*+•]\s+(.*)$/.exec(ln))) {
      flushP();
      const current: Extract<Block, { t: 'ul' | 'ol' }> | null = list;
      // a bullet indented under a numbered item belongs to that item
      const lastItem = current && current.t === 'ol' ? current.items[current.items.length - 1] : undefined;
      if (lastItem && (m[1] ?? '').length >= 2) {
        lastItem.sub.push(m[2] ?? '');
        listSrc.push(ln);
        continue;
      }
      if (!current || current.t !== 'ul') {
        flushL();
        list = { t: 'ul', src: '', open: false, start: 1, items: [] };
      }
      (list as Extract<Block, { t: 'ul' | 'ol' }>).items.push({ text: m[2] ?? '', sub: [] });
      listSrc.push(ln);
    } else if ((m = /^\s*(\d+)[.)]\s+(.*)$/.exec(ln))) {
      flushP();
      const current: Extract<Block, { t: 'ul' | 'ol' }> | null = list;
      if (!current || current.t !== 'ol') {
        flushL();
        // a numbered list keeps its own first number (so "2." after an interruption is not shown as "1.")
        list = { t: 'ol', src: '', open: false, start: Number(m[1]), items: [] };
      }
      (list as Extract<Block, { t: 'ul' | 'ol' }>).items.push({ text: m[2] ?? '', sub: [] });
      listSrc.push(ln);
    } else if ((m = /^\s*>\s?(.*)$/.exec(ln))) {
      flushP();
      flushL();
      out.push({ t: 'quote', src: ln, open: false, text: m[1] ?? '' });
    } else if (TABLE_ROW.test(ln)) {
      flushP();
      flushL();
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i] ?? '')) rows.push(lines[i++] ?? '');
      i--;
      out.push({ t: 'table', src: rows.join('\n'), open: false, rows });
    } else {
      const current: Extract<Block, { t: 'ul' | 'ol' }> | null = list;
      const lastItem = current ? current.items[current.items.length - 1] : undefined;
      if (lastItem && /^\s{2,}\S/.test(ln)) {
        lastItem.text += ' ' + ln.trim();
        listSrc.push(ln);
      } else {
        flushL();
        para.push(ln.trim());
      }
    }
  }
  flushP();
  flushL();
  const last = out[out.length - 1];
  if (last && !ended && !closedByBlank) last.open = true;
}

/**
 * A message as blocks. `hard` is for text read off a terminal (lines wrapped at the terminal width are
 * joined, and a line break inside a paragraph is kept). `streaming` leaves the last block open when the
 * text does not end at a clear boundary; a finished message has no open block.
 */
export function parseBlocks(source: string, hard = false, streaming = false): Block[] {
  const out: Block[] = [];
  const lines = String(source).split('\n');
  let text: string[] = [];
  const flushText = (ended: boolean) => {
    if (!text.length) return;
    const joined = text.join('\n');
    textBlocks(hard ? joinWrapped(joined) : joined, ended, out);
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? '';
    if (!FENCE.test(ln)) {
      text.push(ln);
      continue;
    }
    flushText(true);
    const lang = ln.replace(FENCE, '').replace(/`+\s*$/, '').trim();
    const body: string[] = [];
    let closed = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (FENCE.test(lines[j] ?? '')) {
        closed = true;
        break;
      }
      body.push(lines[j] ?? '');
    }
    out.push({ t: 'code', src: lines.slice(i, closed ? j + 1 : lines.length).join('\n'), open: !closed && streaming, lang, body: body.join('\n') });
    i = closed ? j : lines.length;
  }
  flushText(!streaming);
  if (!streaming) for (const b of out) b.open = false;
  return out;
}

/* ------------------------------------------------------------------ drawing */

export function listItemHtml(item: ListItem): string {
  return `<li>${inline(item.text)}${item.sub.length ? `<ul>${item.sub.map((b) => `<li>${inline(b)}</li>`).join('')}</ul>` : ''}</li>`;
}

const cells = (row: string): string[] => row.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
/** A table's rows without the `|---|---|` line: the first is the header. */
export function tableRows(rows: string[]): string[] {
  return rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
}
export function tableRowHtml(row: string, header: boolean): string {
  const tag = header ? 'th' : 'td';
  return `<tr>${cells(row).map((x) => `<${tag}>${inline(x)}</${tag}>`).join('')}</tr>`;
}

/** One block as HTML. `hard` keeps line breaks inside a paragraph. */
export function blockHtml(b: Block, hard = false): string {
  switch (b.t) {
    case 'p':
      return `<p>${b.lines.map((l) => inline(l)).join(hard ? '<br>' : ' ')}</p>`;
    case 'h':
      return `<h${b.level}>${inline(b.text)}</h${b.level}>`;
    case 'hr':
      return '<hr>';
    case 'ul':
    case 'ol':
      return `<${b.t}${b.t === 'ol' && b.start > 1 ? ` start="${b.start}"` : ''}>${b.items.map(listItemHtml).join('')}</${b.t}>`;
    case 'quote':
      return `<blockquote>${inline(b.text)}</blockquote>`;
    case 'table': {
      const body = tableRows(b.rows);
      return `<div class="cm-table"><table><thead>${tableRowHtml(body[0] ?? '', true)}</thead><tbody>${body.slice(1).map((r) => tableRowHtml(r, false)).join('')}</tbody></table></div>`;
    }
    case 'code':
      return codeHtml(b.lang, b.body.replace(/\n$/, ''));
  }
}

/** A whole, finished message as HTML. */
export function renderMarkdown(source: string, hard = false): string {
  return parseBlocks(source, hard, false).map((b) => blockHtml(b, hard)).join('');
}
