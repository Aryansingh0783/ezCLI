'use strict';
/* UI smoke test. Loads the app's own front end in headless Chromium with a stand-in for the Tauri backend,
 * opens each main screen at three window sizes, and fails on: a script error, a console error, a page that
 * scrolls sideways, or an open dialog with something drawn outside the window.
 *
 *   npm install --no-save playwright && npx playwright install chromium   (once)
 *   node scripts/ui-smoke.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..', 'public');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const agents = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents.json'), 'utf8')).agents.map((a) => ({ ...a, available: true }));

const SIZES = [[1280, 800], [900, 600], [760, 480]];
const SCREENS = [['modelsBtn', 'Local models'], ['settingsBtn', 'Settings'], ['helpBtn', 'Keys'], ['brainBtn', 'Brain']];

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = path.join(root, p);
      if (!file.startsWith(root)) return res.writeHead(403).end();
      fs.readFile(file, (e, d) => {
        if (e) return res.writeHead(404).end();
        res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }).end(d);
      });
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/** The backend as the front end sees it: plausible answers, never an error. Plain data, so it can be sent to the page. */
function mockScript(agentList) {
  const answers = {
    list_agents: { agents: agentList, cwd: '/home/demo/project', sep: '/', config_path: '' },
    git_status: { repo: false, files: [] },
    graphify_status: { installed: true, installer: '', agents: ['claude'], version: '1' },
    brain_status: { projects: 0, built: false },
    llama_status: { installed: false, path: '', plan: 'the Vulkan build' },
    detect_system_profile: { logicalCpuCores: 8, totalMemoryGib: 32, gpuName: 'Demo GPU', gpuVramMib: 12288 },
    local_models_scan: [{ path: '/m/a-Q4_K_M.gguf', name: 'a-Q4_K_M', bytes: 5e9, quant: 'Q4_K_M', source: 'Downloads' }],
    hub_default_dir: '/home/demo/.ezcli/models',
    hub_status: [],
    hub_files: [{ path: 'm-Q4_K_M.gguf', size: 2.5e9, sha256: 'a', quant: 'Q4_K_M' }],
    hub_search: [{ id: 'demo/Model-GGUF', downloads: 10, likes: 1 }],
    lms_action: '[]'
  };
  return `(() => {
    const answers = ${JSON.stringify(answers)};
    const win = { label: 'main', onResized: async () => () => {}, isMaximized: async () => false, show: async () => {}, setFocus: async () => {}, listen: async () => () => {}, onCloseRequested: async () => () => {} };
    window.__TAURI__ = {
      core: { invoke: async (n) => { await new Promise((r) => setTimeout(r, 150)); if (n in answers) return answers[n]; if (/^(list|detect|sessions|spaces)/.test(n)) return []; return null; }, convertFileSrc: (x) => x },
      event: { listen: async () => () => {}, emit: async () => {} },
      window: { getCurrentWindow: () => win },
      webviewWindow: { getCurrentWebviewWindow: () => win }, dialog: {}, opener: {}
    };
  })();`;
}

(async () => {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const problems = [];
  for (const [w, h] of SIZES) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      const tag = `${w}x${h} ${theme}`;
      page.on('pageerror', (e) => problems.push(`${tag}: script error: ${e.message}`));
      page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && problems.push(`${tag}: console error: ${m.text().slice(0, 160)}`));
      await page.addInitScript(mockScript(agents));
      await page.goto(url);
      await page.waitForTimeout(900);
      const skip = await page.$('text=/explore on my own/');
      if (skip) await skip.click({ timeout: 2000 }).catch(() => {}); // first-run card, when it is showing
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; document.documentElement.dataset.palette = t === 'dark' ? 'claude-dark' : 'claude'; }, theme);
      const overflow = async (name) => {
        const bad = await page.evaluate(() => {
          const out = [];
          const vw = innerWidth;
          if (document.documentElement.scrollWidth > vw + 1) out.push('page scrolls sideways');
          for (const e of document.querySelectorAll('dialog[open] *')) {
            const b = e.getBoundingClientRect();
            if (b.width < 2 || b.height < 2 || getComputedStyle(e).visibility === 'hidden') continue;
            if (b.right > vw + 2 || b.left < -2) out.push(`${e.id || e.className || e.tagName} is outside the window`);
          }
          return out.slice(0, 4);
        });
        for (const b of bad) problems.push(`${tag} ${name}: ${b}`);
      };
      await overflow('home');
      for (const [btn, name] of SCREENS) {
        const el = await page.$('#' + btn);
        if (!el) { problems.push(`${tag}: button #${btn} is missing`); continue; }
        try {
          await el.click({ timeout: 3000 });
        } catch {
          problems.push(`${tag}: #${btn} (${name}) cannot be clicked: it is hidden or covered`);
          continue;
        }
        await page.waitForTimeout(450);
        if (!(await page.$('dialog[open]'))) problems.push(`${tag}: ${name} did not open`);
        await overflow(name);
        if (btn === 'modelsBtn') {
          // every tab of the Models panel: it must open, draw something, and stay inside the window
          for (const tabId of ['mine', 'lmstudio', 'discover']) {
            const tab = await page.$(`[data-tab="${tabId}"]`);
            if (!tab) { problems.push(`${tag}: Models tab "${tabId}" is missing`); continue; }
            await tab.click({ timeout: 3000 }).catch(() => problems.push(`${tag}: Models tab "${tabId}" cannot be clicked`));
            await page.waitForTimeout(250);
            if (!(await page.$('.models-body > *'))) problems.push(`${tag}: Models tab "${tabId}" is empty`);
            await overflow(`Models/${tabId}`);
          }
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(120);
      }
      await page.close();
    }
  }
  await browser.close();
  srv.close();
  if (problems.length) {
    console.error(`UI smoke test failed (${problems.length}):\n- ${[...new Set(problems)].join('\n- ')}`);
    process.exit(1);
  }
  console.log(`UI smoke test passed: ${SCREENS.length} screens x ${SIZES.length} sizes x 2 themes, no errors, no overflow.`);
})();
