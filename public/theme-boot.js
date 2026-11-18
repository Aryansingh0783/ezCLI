// Apply the saved theme before first paint so the window never flashes.
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('ezcli.v2') || '{}');
    var t = s.theme || 'system';
    if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.style = s.style === 'solid' ? 'solid' : 'glass';
    var acc = { sky: ['#5cc8ff', '#0b6fb0'], violet: ['#b69cff', '#6a3fd0'], amber: ['#ffc04d', '#9a6200'], rose: ['#ff7aa2', '#b8325c'], mint: ['#4fe3c1', '#0f7f68'] }[s.accent];
    if (acc) document.documentElement.style.setProperty('--brand', acc[t === 'light' ? 1 : 0]);
  } catch (e) {}
})();
    
