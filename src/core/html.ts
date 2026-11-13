/** Text made safe to place inside HTML (element content or a quoted attribute). */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Label a setting button as "Name value" with the value emphasised: "Web: auto" becomes Web + auto. */
export function setKV(el: Element | null, text: string): void {
  if (!el) return;
  const at = text.indexOf(': ');
  el.textContent = '';
  if (at < 0) {
    el.textContent = text;
    return;
  }
  const k = document.createElement('span');
  k.className = 'kv-k';
  k.textContent = text.slice(0, at);
  const v = document.createElement('b');
  v.className = 'kv-v';
  v.textContent = text.slice(at + 2);
  el.append(k, ' ', v);
  el.setAttribute('aria-label', text);
}
