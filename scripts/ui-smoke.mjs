/* UI smoke test. Loads the app's own front end in headless Chromium with a stand-in for the Tauri backend,
 * opens each main screen at three window sizes, and fails on: a script error, a console error, a page that
 * scrolls sideways, or an open dialog with something drawn outside the window.
 *
 *   npx playwright install chromium   (once)
 *   npm run build && npm run test:smoke
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The built window (npm run build), exactly what Tauri embeds.
const root = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error('dist/ is missing. Run `npm run build` first.');
  process.exit(1);
}
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
// The agents as the backend sends them to the screen (see AgentOut in agents.rs): a live model catalog is
// `dynamic_models`, and one with no safe default is `requiresModelSelection`.
export const agents = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents.json'), 'utf8')).agents.map((a) => ({
  ...a,
  available: true,
  dynamic_models: Boolean(a.modelsFrom),
  requiresModelSelection: Boolean(a.modelsFrom && a.modelsFrom.requireSelection),
  catalogAvailableWithoutCommand: false
}));
const WIN_MODEL = 'M:\\AI\\models\\Qwen3.8-27B-Uncensored-Q4_K_M.gguf';
const POSIX_MODEL = '/home/demo/models/Qwen3-8B-Q4_K_M.gguf';

const SIZES = [[1280, 800], [900, 600], [760, 480]];
const SCREENS = [['modelsBtn', 'Local models'], ['settingsBtn', 'Settings'], ['helpBtn', 'Keys'], ['brainBtn', 'Brain'], ['createBtn', 'Create']];

export function serve() {
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
export function mockScript(agentList) {
  const answers = {
    list_agents: { agents: agentList, cwd: '/home/demo/project', sep: '/', config_path: '' },
    git_status: { repo: false, files: [] },
    list_dir: { entries: [{ name: 'src', path: '/home/demo/project/src', dir: true, size: null }, { name: 'README.md', path: '/home/demo/project/README.md', dir: false, size: 1200 }, { name: 'package.json', path: '/home/demo/project/package.json', dir: false, size: 800 }] },
    open_targets: [{ id: 'files', label: 'File manager' }, { id: 'terminal', label: 'Terminal' }],
    graphify_status: { installed: true, installer: '', agents: ['claude'], version: '1' },
    brain_status: { projects: 0, built: false },
    llama_status: { installed: false, path: '', plan: 'the Vulkan build' },
    detect_system_profile: { logicalCpuCores: 8, totalMemoryGib: 32, gpuName: 'Demo GPU', gpuVramMib: 12288 },
    local_models_scan: [{ path: '/m/a-Q4_K_M.gguf', name: 'a-Q4_K_M', bytes: 5e9, quant: 'Q4_K_M', source: 'Downloads' }],
    llama_latest: 'b9999',
    model_delete: '/m/a-Q4_K_M.gguf',
    hub_default_dir: '/home/demo/.ezcli/models',
    hub_status: [],
    hub_files: [{ path: 'm-Q4_K_M.gguf', size: 2.5e9, sha256: 'a', quant: 'Q4_K_M' }],
    hub_search: [{ id: 'demo/Model-GGUF', downloads: 10, likes: 1 }],
    lms_action: '[]',
    local_skills: [],
    rag_sources: []
  };
  return `(() => {
    const answers = ${JSON.stringify(answers)};
    const win = { label: 'main', onResized: async () => () => {}, isMaximized: async () => false, show: async () => {}, setFocus: async () => {}, listen: async () => () => {}, onCloseRequested: async () => () => {} };
    window.__emit = (name, payload) => { for (const h of ((window.__handlers || {})[name] || [])) h({ payload }); };
    window.__TAURI__ = {
      core: { invoke: async (n, a) => {
        (window.__calls = window.__calls || []).push([n, a]);
        await new Promise((r) => setTimeout(r, 150));
        // the backend only offers (and launches) model files it found by scanning
        if (n === 'agent_models') return a && a.agentId === 'gguf' ? ${JSON.stringify([WIN_MODEL, POSIX_MODEL])} : [];
        // pictures and video: window.__studio picks the situation the Create panel is in
        if (n === 'studio_info') {
          const mode = window.__studio || 'ready';
          const models = [['sdxl', 'image', 'Stable Diffusion XL', 6.9], ['wan-model', 'video', 'Wan 2.2 video model', 10], ['wan-text', 'video', 'Wan text encoder', 6.7], ['wan-vae', 'video', 'Wan 2.2 decoder', 1.4]]
            .map(([id, kind, label, gib]) => ({ id, kind, label, name: id + '.safetensors', gib, present: mode === 'ready' && kind === 'image' }));
          const running = mode !== 'fresh';
          return { status: { supported: true, installed: running, running, port: running ? 8317 : 0, managed: running, models, folder: 'C:/Users/demo/.ezcli/studio' }, checkpoints: mode === 'ready' ? ['sd_xl_base_1.0.safetensors'] : [], videoReady: false };
        }
        if (n === 'media_make') return 'job1';
        if (n === 'media_job') return { state: 'done', seconds: 3, path: 'C:/Users/demo/Pictures/ezCLI/ezCLI_00001_.png', why: '' };
        if (n === 'media_read') return { path: a.path, mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' };
        if (n === 'studio_install' || n === 'studio_model') return 'studio';
        if (n === 'start_session') return { command: 'llama-cli', cwd: '/home/demo/project', pcControl: false, connectorsActive: [] };
        if (n in answers) return answers[n];
        if (/^(list|detect|sessions|spaces)/.test(n)) return [];
        return null;
      }, convertFileSrc: (x) => x },
      // events the test can fire: window.__emit('pty-data:<id>', text)
      event: {
        listen: async (name, handler) => {
          const map = (window.__handlers = window.__handlers || {});
          (map[name] = map[name] || []).push(handler);
          return () => { map[name] = (map[name] || []).filter((h) => h !== handler); };
        },
        emit: async () => {}
      },
      window: { getCurrentWindow: () => win },
      webviewWindow: { getCurrentWebviewWindow: () => win }, dialog: {}, opener: {}
    };
  })();`;
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) (async () => {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  // PW_CHROME lets a machine without Playwright's own download point at an installed Chrome.
  const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});
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
        if (btn === 'modelsBtn' && theme === 'light' && w === 1280) {
          // numbered lists: bullets under an item nest inside it, and a list that starts at 2 is not shown as 1
          const lists = await page.evaluate(() => ({
            nested: window.ezcli.ChatView.text('1. A\n   - x\n   - y\n2. B\n   - z\n3. C', true),
            restarted: window.ezcli.ChatView.text('2. B\n3. C', true),
            plain: window.ezcli.ChatView.text('- a\n- b', true)
          }));
          if ((lists.nested.match(/<ol/g) || []).length !== 1 || (lists.nested.match(/<li>C<\/li>/g) || []).length !== 1 || !/<li>A<ul><li>x<\/li><li>y<\/li><\/ul><\/li>/.test(lists.nested)) problems.push(`${tag}: bullets under numbered items did not nest: ${lists.nested}`);
          if (!/<ol start="2">/.test(lists.restarted)) problems.push(`${tag}: a numbered list starting at 2 lost its number: ${lists.restarted}`);
          if (lists.plain !== '<ul><li>a</li><li>b</li></ul>') problems.push(`${tag}: a plain bullet list changed: ${lists.plain}`);
        }
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
          // llama.cpp already installed: the panel offers update/reinstall, and a model file is deleted only on a second click
          const buttons = await page.evaluate(async () => {
            window.ezcli.Models.llama = { installed: true, plan: '', path: '/x/llama-cli', version: 'b6000' };
            window.ezcli.Models.tab = 'mine';
            window.ezcli.Models.render();
            const labels = () => [...document.querySelectorAll('.models-setup button, .models-body button')].map((b) => b.textContent.trim());
            const first = labels();
            document.querySelector('[data-gguf-del]').click();
            const afterOne = labels();
            const deletedEarly = (window.__calls || []).some((c) => c[0] === 'model_delete');
            document.querySelector('[data-gguf-del]').click();
            await new Promise((r) => setTimeout(r, 100));
            return { first, afterOne, deletedEarly, deleted: (window.__calls || []).some((c) => c[0] === 'model_delete') };
          });
          for (const want of ['Reinstall', 'CPU-only build', 'Check for update', 'Uninstall']) if (!buttons.first.includes(want)) problems.push(`${tag}: Models panel has no "${want}" button`);
          if (!buttons.afterOne.includes('Delete the file?')) problems.push(`${tag}: the first Uninstall click did not ask again`);
          if (buttons.deletedEarly) problems.push(`${tag}: a model file was deleted on the first click`);
          if (!buttons.deleted) problems.push(`${tag}: the second click did not delete the model file`);
        }
        if (btn === 'createBtn') {
          // set up and a model installed: a description becomes a job and the finished picture is shown
          await page.waitForTimeout(500);
          await page.fill('#createPrompt', 'a red bicycle');
          await page.click('#createGo');
          await page.waitForSelector('#createResult img', { timeout: 8000 }).catch(() => problems.push(`${tag}: Create did not show the finished picture`));
          const made = await page.evaluate(() => {
            const q = (window.__calls || []).filter((c) => c[0] === 'media_make').pop();
            return { asked: q ? q[1] : {}, saved: (document.querySelector('.create-saved') || {}).textContent || '' };
          });
          if (made.asked.kind !== 'image' || made.asked.prompt !== 'a red bicycle' || made.asked.checkpoint !== 'sd_xl_base_1.0.safetensors') problems.push(`${tag}: Create asked for the wrong thing: ${JSON.stringify(made.asked)}`);
          if (!/Pictures/.test(made.saved)) problems.push(`${tag}: Create did not say where the picture was saved`);
          await overflow('Create/made');
          // video without its model: the three files are listed with one Download button, and pressing it starts three downloads
          await page.click('#createKind [data-kind="video"]');
          await page.waitForTimeout(150);
          const need = await page.$$eval('#createNeeded li', (l) => l.length);
          if (need !== 3) problems.push(`${tag}: Create/video listed ${need} files to download, not 3`);
          await overflow('Create/video');
          await page.click('[data-create="models"]').catch(() => problems.push(`${tag}: Create/video has no Download button`));
          await page.waitForTimeout(700);
          const asked = await page.evaluate(() => (window.__calls || []).filter((c) => c[0] === 'studio_model').map((c) => c[1].id).join(','));
          if (asked !== 'wan-model,wan-text,wan-vae') problems.push(`${tag}: Create/video downloaded "${asked}"`);
          await page.evaluate(() => { for (const id of ['wan-model', 'wan-text', 'wan-vae']) window.__emit('model-download', { key: 'studio-model:' + id, state: 'done', bytes: 0, total: 0, path: '', error: '', note: '' }); });
          // not set up at all: one Set up button, and a download that reports its progress
          await page.evaluate(() => { window.__studio = 'fresh'; });
          await page.click('#createKind [data-kind="image"]');
          await page.waitForTimeout(700);
          await page.click('[data-create="setup"]').catch(() => problems.push(`${tag}: Create did not offer to set itself up`));
          await page.evaluate(() => window.__emit('model-download', { key: 'studio', state: 'downloading', bytes: 734003200, total: 0, path: '', error: '', note: '' }));
          await page.waitForTimeout(150);
          const prog = await page.$eval('.create-progress', (e) => e.textContent).catch(() => '');
          if (!/700 MB downloaded/.test(prog)) problems.push(`${tag}: Create set-up progress reads "${prog}"`);
          await overflow('Create/setup');
          await page.evaluate(() => { window.__studio = 'ready'; window.__emit('model-download', { key: 'studio', state: 'done', bytes: 0, total: 0, path: '', error: '', note: '' }); });
          await page.waitForTimeout(500);
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(120);
      }
      if (theme === 'light' && w === 1280) {
        // Starting a llama.cpp chat on a model FILE (a full path). The screen used to reject every path because
        // it only accepted provider/model names, so this agent could never start.
        const launch = await page.evaluate(async ([win, posix]) => {
          const errors = () => [...document.querySelectorAll('.toast.error')].map((e) => e.textContent);
          const started = () => (window.__calls || []).filter((c) => c[0] === 'start_session').map((c) => c[1].modelId);
          const out = {};
          const { prefs, createSession, modelLabel, agent } = window.ezcli;
          prefs.modelFolders = ['E:\\Stuff\\LLMs']; // a folder the user added earlier
          for (const [name, id] of [['windows', win], ['posix', posix]]) {
            document.querySelectorAll('.toast').forEach((t) => t.remove());
            const s = await createSession('gguf', { modelId: id });
            await new Promise((r) => setTimeout(r, 400));
            out[name] = { created: Boolean(s), sentToBackend: started().includes(id), errors: errors(), label: modelLabel(agent('gguf'), id) };
          }
          // a file the scan never found, and a name built to break out of quotes, must be refused
          for (const [name, id] of [['unknown', 'C:\\somewhere\\else.gguf'], ['quote', 'M:\\x"; calc.gguf']]) {
            document.querySelectorAll('.toast').forEach((t) => t.remove());
            const before = started().length;
            const s = await createSession('gguf', { modelId: id });
            await new Promise((r) => setTimeout(r, 300));
            out[name] = { created: Boolean(s), launched: started().length > before, errors: errors().length };
          }
          const asked = (window.__calls || []).filter((c) => c[0] === 'agent_models' && c[1] && c[1].agentId === 'gguf');
          out.foldersSent = asked.length > 0 && asked.every((c) => Array.isArray(c[1].folders) && c[1].folders.includes('E:\\Stuff\\LLMs'));
          out.otherAgentsGetNoFolders = (window.__calls || []).filter((c) => c[0] === 'agent_models' && c[1] && c[1].agentId !== 'gguf').every((c) => c[1].folders === null);
          return out;
        }, [WIN_MODEL, POSIX_MODEL]);
        if (!launch.foldersSent) problems.push('the saved model folders were not sent with the model-list request');
        if (!launch.otherAgentsGetNoFolders) problems.push('other agents must not receive model folders');
        for (const k of ['windows', 'posix']) {
          const r = launch[k];
          if (!r.created || !r.sentToBackend || r.errors.length) problems.push(`llama.cpp session on a ${k} model path did not start: ${JSON.stringify(r)}`);
        }
        if (launch.windows.label !== 'Qwen3.8-27B-Uncensored-Q4_K_M') problems.push(`model label should be the file name, got "${launch.windows.label}"`);
        for (const k of ['unknown', 'quote']) {
          const r = launch[k];
          if (r.created || r.launched || !r.errors) problems.push(`a ${k} model file must be refused: ${JSON.stringify(r)}`);
        }
      }
      await page.close();
    }
  }
  // A reply arriving in many small pieces: what is already on screen must stay the same nodes in the
  // same place. Finished blocks are compared by identity and by position; nothing above the text being
  // typed may move, and the page must not throw.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (e) => problems.push(`stream: script error: ${e.message}`));
    await page.addInitScript(mockScript(agents));
    await page.goto(url);
    await page.waitForTimeout(900);
    const skip = await page.$('text=/explore on my own/');
    if (skip) await skip.click({ timeout: 2000 }).catch(() => {});
    const result = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const s = await window.ezcli.createSession('gguf', { modelId: 'M:\\AI\\models\\Qwen3.8-27B-Uncensored-Q4_K_M.gguf' });
      await wait(700);
      const emit = (t) => window.__emit('pty-data:' + s.ptyId, t);
      emit('llama.cpp chat\r\n> ');
      const box = document.getElementById('ptyInput');
      box.value = 'Explain merging';
      box.dispatchEvent(new Event('input'));
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await wait(1200);
      emit('Explain merging\r\n\r\n');
      const reply = '# Merging lists\r\n\r\nThere are **two** common ways to do it.\r\n\r\n1. Concatenate\r\n2. Interleave\r\n\r\n```python\r\nprint(a + b)\r\n```\r\n\r\n' + Array.from({ length: 12 }, (_, i) => `Paragraph ${i} keeps the stream going with ordinary words.\r\n\r\n`).join('');
      const col = document.getElementById('chatCol');
      const seen = new Map();
      let moved = 0;
      let replaced = 0;
      let checks = 0;
      for (let i = 0; i < reply.length; i += 7) {
        emit(reply.slice(i, i + 7));
        // mostly fast, with a few long gaps: a slow machine draws half-arrived lines (an unfinished code fence, say)
        await wait(i % 140 === 0 ? 2500 : 12);
        if (!col) continue;
        const heading = col.querySelector('h1, h2, h3');
        const code = col.querySelector('.cm-code');
        for (const [key, el] of [['heading', heading], ['code', code]]) {
          if (!el) continue;
          const top = Math.round(el.getBoundingClientRect().top + col.parentElement.scrollTop);
          const was = seen.get(key);
          if (was) {
            checks++;
            if (was.el !== el) replaced++;
            if (was.top !== top) moved++;
          }
          seen.set(key, { el, top });
        }
      }
      await wait(600);
      return { hasCol: Boolean(col), checks, moved, replaced, paragraphs: col ? col.querySelectorAll('p').length : 0 };
    });
    if (!result.hasCol || result.checks < 20) problems.push(`stream: the chat view never showed the streamed reply: ${JSON.stringify(result)}`);
    if (result.replaced) problems.push(`stream: ${result.replaced} finished blocks were replaced while text was arriving`);
    if (result.moved) problems.push(`stream: finished blocks moved ${result.moved} times while text was arriving`);
    if (result.paragraphs < 12) problems.push(`stream: only ${result.paragraphs} of the streamed paragraphs were drawn`);
    await page.close();
  }
  await browser.close();
  srv.close();
  if (problems.length) {
    console.error(`UI smoke test failed (${problems.length}):\n- ${[...new Set(problems)].join('\n- ')}`);
    process.exit(1);
  }
  console.log(`UI smoke test passed: ${SCREENS.length} screens x ${SIZES.length} sizes x 2 themes, no errors, no overflow; a streamed reply replaced and moved nothing.`);
})();
