/* README screenshots. Loads the built front end in headless Chromium with the same stand-in backend the UI
 * smoke test uses, so every picture shows demo data and nothing from a real PC.
 *
 *   npm run build && PW_CHROME=/usr/bin/google-chrome node scripts/screenshots.mjs <picture.b64>
 *
 * <picture.b64> is a data: URL for the demo picture shown as "made by the agent". Output goes to docs/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { agents, mockScript, serve } from './ui-smoke.mjs';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const pic = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : '';
const srv = await serve();
const url = `http://127.0.0.1:${srv.address().port}/`;
const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});

async function open(theme, height = 900) {
  const page = await browser.newPage({ viewport: { width: 1440, height }, deviceScaleFactor: 1 });
  await page.addInitScript(mockScript(agents));
  if (pic) await page.addInitScript((p) => { window.__pic = p; }, pic);
  await page.goto(url);
  await page.waitForTimeout(900);
  const skip = await page.$('text=/explore on my own/');
  if (skip) await skip.click({ timeout: 2000 }).catch(() => {});
  const later = await page.$('text=/^Not now$/');
  if (later) await later.click({ timeout: 2000 }).catch(() => {}); // the ask-for-a-name prompt
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; document.documentElement.dataset.palette = t === 'dark' ? 'claude-dark' : 'claude'; }, theme);
  await page.waitForTimeout(300);
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(out, name) });

// home, both themes
for (const [theme, name] of [['light', 'screenshot-launcher.png'], ['dark', 'screenshot-launcher-dark.png']]) {
  const page = await open(theme);
  await shot(page, name);
  await page.close();
}

// a session: a streamed reply, a picture the agent made, and the explorer docked beside it
{
  const page = await open('light', 1100);
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const s = await window.ezcli.createSession('gguf', { modelId: 'M:\\AI\\models\\Qwen3.8-27B-Uncensored-Q4_K_M.gguf' });
    await wait(700);
    const emit = (t) => window.__emit('pty-data:' + s.ptyId, t);
    emit('llama.cpp chat\r\n> ');
    const box = document.getElementById('ptyInput');
    box.value = 'Make a picture of a lighthouse at sunset';
    box.dispatchEvent(new Event('input'));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(1200);
    emit('Make a picture of a lighthouse at sunset\r\n\r\n');
    emit('# Lighthouse at sunset\r\n\r\nI made one with your local ComfyUI and saved it to your Pictures folder.\r\n\r\n- Warm sky fading into a deep blue sea\r\n- A red-banded lighthouse on the rocks\r\n\r\n');
    await wait(2800);
    window.__emit('media-made', { path: 'C:/Users/demo/Pictures/ezCLI/ezCLI_00002_.png', prompt: 'a lighthouse at sunset', mime: 'image/png', pty: s.ptyId });
    await wait(1200);
  });
  await page.click('#explorerToggle').catch(() => {});
  await page.waitForTimeout(900);
  await shot(page, 'screenshot-session.png');
  await page.close();
}

// Settings and the new Create panel
for (const [btn, name] of [['settingsBtn', 'screenshot-settings.png'], ['createBtn', 'screenshot-create.png']]) {
  const page = await open('light');
  await page.click('#' + btn);
  await page.waitForTimeout(700);
  if (btn === 'createBtn') {
    await page.fill('#createPrompt', 'a lighthouse at sunset, warm light over a calm sea');
    await page.click('#createGo');
    await page.waitForSelector('#createResult img', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  await shot(page, name);
  await page.close();
}
await browser.close();
srv.close();
console.log('screenshots written to docs/');
