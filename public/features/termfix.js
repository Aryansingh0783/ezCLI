'use strict';
/* Box drawing and block characters in the terminal.
 *
 * xterm's contrast fixer deliberately skips the box-drawing and block ranges (U+2500 to U+259F),
 * so a CLI that draws its frame or logo in white or pale green leaves it nearly invisible on a
 * light pane. And with a roomy line height, a vertical bar only covers part of its row, so a
 * frame reads as a dashed line. This pass runs on the HTML renderer only: it darkens those
 * characters until they read, and joins single vertical bars into one unbroken stroke. */

const TermFix = {
  pending: false,
  boxOnly: /^[\s─-▟]+$/,
  bar: /^[│┃]$/,

  rgb(css) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css || '');
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  },
  lum([r, g, b]) {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  },
  ratio(a, b) {
    const x = this.lum(a);
    const y = this.lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  },

  run() {
    this.pending = false;
    const cur = typeof active === 'function' ? active() : null;
    const host = cur && cur.host ? cur.host.querySelector('.xterm-rows') : null;
    if (!host) return;
    const root = document.documentElement.dataset;
    const light = root.termGlass === 'clear' && typeof resolvedTheme === 'function' && resolvedTheme() === 'light';
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim();
    const panel = this.rgb(raw.startsWith('#') ? hexToRgbCss(raw) : raw) || [255, 255, 255];
    const ink = [29, 29, 32];
    for (const span of host.querySelectorAll('span')) {
      const text = span.textContent;
      if (!text || !this.boxOnly.test(text) || !text.trim()) continue;
      const cs = getComputedStyle(span);
      let fg = this.rgb(cs.color);
      if (!fg) continue;
      if (light && this.ratio(fg, panel) < 3) {
        for (let i = 0; i < 8 && this.ratio(fg, panel) < 3; i++) fg = fg.map((v, k) => Math.round(v * 0.7 + ink[k] * 0.3));
        span.style.color = `rgb(${fg.join(',')})`;
      }
      if (this.bar.test(text)) {
        const h = span.parentElement ? span.parentElement.offsetHeight : 0;
        if (h) {
          span.classList.add('tl-bar');
          span.style.setProperty('--bar', span.style.color || cs.color);
          span.style.height = `${h}px`;
        }
      }
    }
  },

  schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => this.run());
  },

  mount() {
    const hosts = document.getElementById('termHosts');
    if (!hosts) return;
    new MutationObserver(() => this.schedule()).observe(hosts, { childList: true, subtree: true, characterData: true });
    this.schedule();
  }
};

/** "#rrggbb" or "#rgb" as an rgb() string, for the contrast maths above. */
function hexToRgbCss(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isNaN(n) ? '' : `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

hooks.boot.push(() => TermFix.mount());
hooks.view.push(() => TermFix.schedule());
