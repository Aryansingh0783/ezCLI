/* Ambient types for things the window provides that TypeScript cannot see.
 *
 * 1. xterm and its add-ons are loaded as plain <script> files from public/vendor (the Rust side also embeds
 *    the same files for the remote page), so they arrive as globals rather than imports.
 * 2. The code that came over from the old script files reads form and element properties straight off
 *    `event.target` and `getElementById` results. The interfaces below widen those types so that code
 *    compiles as written. New code should narrow properly (`instanceof HTMLInputElement`) instead of
 *    leaning on this; each property removed from here is a place that then has to say what it means. */

interface XtermBufferLine {
  translateToString(trimRight?: boolean, start?: number, end?: number): string;
  isWrapped: boolean;
}
interface XtermBuffer {
  type: 'normal' | 'alternate';
  length: number;
  baseY: number;
  viewportY: number;
  cursorX: number;
  cursorY: number;
  getLine(y: number): XtermBufferLine | undefined;
}
interface XtermMarker {
  line: number;
  isDisposed: boolean;
  dispose(): void;
}
/* eslint-disable @typescript-eslint/no-explicit-any */
declare class Terminal {
  constructor(options?: Record<string, unknown>);
  cols: number;
  rows: number;
  element?: HTMLElement;
  textarea?: HTMLTextAreaElement;
  options: Record<string, any>;
  modes: { bracketedPasteMode: boolean; [mode: string]: boolean };
  buffer: { active: XtermBuffer; normal: XtermBuffer; alternate: XtermBuffer };
  unicode: { activeVersion: string };
  parser: any;
  open(parent: HTMLElement): void;
  loadAddon(addon: unknown): void;
  write(data: string | Uint8Array, done?: () => void): void;
  writeln(data: string): void;
  focus(): void;
  blur(): void;
  clear(): void;
  reset(): void;
  dispose(): void;
  refresh(start: number, end: number): void;
  resize(cols: number, rows: number): void;
  scrollToBottom(): void;
  scrollLines(n: number): void;
  select(column: number, row: number, length: number): void;
  selectAll(): void;
  clearSelection(): void;
  hasSelection(): boolean;
  getSelection(): string;
  paste(data: string): void;
  registerMarker(offset?: number): XtermMarker;
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void;
  onData(handler: (data: string) => void): { dispose(): void };
  onResize(handler: (size: { cols: number; rows: number }) => void): { dispose(): void };
  onTitleChange(handler: (title: string) => void): { dispose(): void };
  onSelectionChange(handler: () => void): { dispose(): void };
  onScroll(handler: (y: number) => void): { dispose(): void };
  onBell(handler: () => void): { dispose(): void };
  onWriteParsed(handler: () => void): { dispose(): void };
  onRender(handler: (range: { start: number; end: number }) => void): { dispose(): void };
  [member: string]: any;
}
declare const FitAddon: { FitAddon: new () => { fit(): void; proposeDimensions(): { cols: number; rows: number } | undefined } };
declare const WebLinksAddon: { WebLinksAddon: new (handler?: (event: MouseEvent, uri: string) => void, options?: unknown) => unknown };
declare const Unicode11Addon: { Unicode11Addon: new () => unknown };
declare const WebglAddon: { WebglAddon: new () => { onContextLoss(handler: () => void): void; dispose(): void } };

interface Window {
  /** Injected by Tauri (`withGlobalTauri`). Absent in a plain browser, where the smoke test supplies a stand-in. */
  __TAURI__: {
    core: { invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> };
    event: { listen<T = unknown>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> };
    [plugin: string]: any;
  };
  getCurrentWindow?: unknown;
}

/** Element properties the migrated code reads without narrowing first. See the note at the top. */
interface LooseElementProps {
  value: string;
  checked: boolean;
  disabled: boolean;
  placeholder: string;
  files: FileList | null;
  selectionStart: number | null;
  selectionEnd: number | null;
  href: string;
  src: string;
  open: boolean;
  type: string;
  name: string;
  select(): void;
  setSelectionRange(start: number, end: number): void;
  showModal(): void;
  close(): void;
}
interface HTMLElement extends LooseElementProps {}
interface Element extends LooseElementProps {
  dataset: DOMStringMap;
  style: CSSStyleDeclaration;
  title: string;
  innerText: string;
  offsetWidth: number;
  offsetHeight: number;
  offsetTop: number;
  offsetLeft: number;
  offsetParent: Element | null;
  isContentEditable: boolean;
  focus(options?: FocusOptions): void;
  blur(): void;
  click(): void;
}
interface EventTarget extends LooseElementProps {
  closest(selector: string): Element | null;
  matches(selector: string): boolean;
  contains(other: Node | null): boolean;
  querySelector(selector: string): Element | null;
  querySelectorAll(selector: string): NodeListOf<Element>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): DOMRect;
  focus(options?: FocusOptions): void;
  blur(): void;
  classList: DOMTokenList;
  dataset: DOMStringMap;
  style: CSSStyleDeclaration;
  tagName: string;
  id: string;
  textContent: string | null;
  parentElement: Element | null;
  isContentEditable: boolean;
  result: string | ArrayBuffer | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}
interface Event {
  /** Keyboard, mouse and clipboard fields read from handlers typed as a plain Event. */
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  clientX: number;
  clientY: number;
  dataTransfer: DataTransfer | null;
  clipboardData: DataTransfer | null;
  detail: any;
}
