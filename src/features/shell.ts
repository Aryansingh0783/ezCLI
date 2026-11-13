import { $, active, applyTheme, hooks, openMenu, prefs, savePrefs, space } from '../app';
/* The window frame: one title bar that names where you are and carries the session's controls,
 * and the look (system, dark, light).
 *
 * The session's own row of buttons is moved into the title bar at start, so there is a single
 * bar instead of tabs above a toolbar. The sidebar lists the sessions, so the tab strip is not shown. */

const DOTS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/></svg>';

function mountTitleBar() {
  const bar = document.querySelector('.tabbar');
  const head = document.querySelector('.session-head');
  const fill = bar && bar.querySelector('.drag-fill');
  if (!bar || !head || !fill || $('crumb')) return;
  const crumb = document.createElement('div');
  crumb.id = 'crumb';
  crumb.className = 'crumb';
  crumb.innerHTML = '<span class="crumb-proj" id="crumbProj"></span><span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-here" id="crumbHere">New session</span>';
  fill.before(crumb, head);

  const more = document.createElement('button');
  more.type = 'button';
  more.id = 'headMore';
  more.className = 'head-more';
  more.title = 'Session actions';
  more.setAttribute('aria-label', 'Session actions');
  more.setAttribute('aria-haspopup', 'menu');
  more.innerHTML = DOTS;
  more.addEventListener('click', () => {
    // The menu presses the session's own buttons, so every action keeps its one implementation.
    const press = (id: string) => () => {
      const b = $(id) as HTMLButtonElement | null;
      if (b) b.click();
    };
    const item = (id: string, fallback: string, danger = false) => {
      const b = $(id) as HTMLButtonElement | null;
      if (!b || b.hidden) return null;
      return { label: (b.textContent || fallback).trim() || fallback, run: press(id), disabled: b.disabled, danger };
    };
    const items = [item('actResume', 'Resume'), item('actRestart', 'Restart'), item('actStop', 'Stop', true), { sep: true }, item('actExport', 'Export'), item('openInPrimary', 'Open folder'), item('openInMenu', 'Open in…')].filter(Boolean);
    const openIn = items.find((x) => x && 'label' in x && x.label === 'Open in…');
    if (openIn && 'label' in openIn) openIn.label = 'Open in another app…';
    openMenu(more, { title: 'Session', items });
  });
  head.append(more);
}

function renderCrumb() {
  const s = active();
  const app = $('app');
  if (app) app.classList.toggle('in-session', Boolean(s));
  const sp = space(s ? s.spaceId : undefined) || space();
  const proj = $('crumbProj');
  if (proj) proj.textContent = sp ? sp.name : 'No folder';
}

function mountLook() {
  const sel = $('prefLook') as HTMLSelectElement | null;
  if (sel) {
    sel.value = prefs.look === 'dark' || prefs.look === 'light' ? prefs.look : 'system';
    sel.addEventListener('change', () => {
      prefs.look = sel.value;
      savePrefs();
      applyTheme();
    });
  }
  if (typeof matchMedia === 'function') matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme());
}

hooks.boot.push(() => {
  mountTitleBar();
  mountLook();
  const n = $('railNew');
  const label = n && n.querySelector('span');
  if (label) label.textContent = 'New session';
  if (n && !n.querySelector('kbd')) n.insertAdjacentHTML('beforeend', '<kbd>Ctrl Alt N</kbd>');
  renderCrumb();
});
hooks.view.push(renderCrumb);
hooks.tabs.push(renderCrumb);
