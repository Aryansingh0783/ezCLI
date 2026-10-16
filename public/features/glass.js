'use strict';
/* Liquid glass runtime: the aurora layer, the refraction filter, pointer
 * spotlights, a see-through terminal, and the Solid/Liquid glass setting. */

const Glass = (() => {
  const isGlass = () => (prefs.style || 'glass') === 'glass';

  function mountScene() {
    if (!document.querySelector('.ambient')) {
      const amb = document.createElement('div');
      amb.className = 'ambient';
      amb.setAttribute('aria-hidden', 'true');
      amb.innerHTML = '<i></i><i></i><i></i>';
      document.body.prepend(amb);
    }
    if (!$('liquid-lens')) {
      // A soft, low-frequency displacement: edges of what sits behind a
      // control bend slightly, the way thick glass does.
      const ns = 'http://www.w3.org/2000/svg';
      const s = document.createElementNS(ns, 'svg');
      s.setAttribute('width', '0');
      s.setAttribute('height', '0');
      s.setAttribute('aria-hidden', 'true');
      s.style.position = 'absolute';
      s.innerHTML = `<filter id="liquid-lens" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.018" numOctaves="2" seed="11" result="noise"/>
          <feGaussianBlur in="noise" stdDeviation="3" result="soft"/>
          <feDisplacementMap in="SourceGraphic" in2="soft" scale="26" xChannelSelector="R" yChannelSelector="G"/>
        </filter>`;
      document.body.prepend(s);
    }
  }

  /** In glass mode the terminal draws on a transparent canvas over the pane. */
  function terminalTheme() {
    const base = TERM_THEMES[resolvedTheme()];
    return isGlass() ? { ...base, background: 'rgba(0,0,0,0)' } : base;
  }

  function apply() {
    document.documentElement.dataset.style = isGlass() ? 'glass' : 'solid';
    for (const s of state.sessions) {
      s.term.options.allowTransparency = isGlass();
      s.term.options.theme = { ...terminalTheme(), cursor: s.term.options.theme && s.term.options.theme.cursor };
    }
    document.querySelectorAll('[data-style-opt]').forEach((b) => {
      const on = b.dataset.styleOpt === (prefs.style || 'glass');
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
  }

  function set(style) {
    prefs.style = style;
    savePrefs();
    apply();
  }

  /* Spotlight: one listener, coordinates written to whichever card is under the pointer. */
  function trackPointer(e) {
    const card = e.target.closest && e.target.closest('.spotlight');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  }

  function markSpotlights() {
    document.querySelectorAll('.suggested-prompt, .agent-option, .compare-row, .search-hit, .health-row').forEach((el) => el.classList.add('spotlight'));
  }

  return { mountScene, apply, set, terminalTheme, trackPointer, markSpotlights, isGlass };
})();

{
  const original = applyTheme;
  // eslint-disable-next-line no-global-assign
  applyTheme = function () {
    original();
    Glass.apply();
  };
}
{
  const original = renderHome;
  // eslint-disable-next-line no-global-assign
  renderHome = function (...args) {
    const r = original(...args);
    Glass.markSpotlights();
    return r;
  };
}

// New terminals pick up transparency as soon as they launch.
hooks.launched.push((s) => {
  s.term.options.allowTransparency = Glass.isGlass();
  s.term.options.theme = { ...Glass.terminalTheme(), cursor: s.term.options.theme && s.term.options.theme.cursor };
});

Glass.mountScene();
document.addEventListener('pointermove', Glass.trackPointer, { passive: true });
document.addEventListener('pointerover', () => Glass.markSpotlights(), { once: true });

hooks.boot.push(() => {
  const seg = $('styleSeg');
  if (seg) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-style-opt]');
      if (b) Glass.set(b.dataset.styleOpt);
    });
  }
  Glass.apply();
  Glass.markSpotlights();
});

registerCommand({ group: 'App', label: 'Style: liquid glass', run: () => Glass.set('glass') });
registerCommand({ group: 'App', label: 'Style: solid', run: () => Glass.set('solid') });
