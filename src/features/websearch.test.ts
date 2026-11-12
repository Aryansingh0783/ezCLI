import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

/** The module under test with stand-ins for what the app provides. */
async function load({ prefs = {} }: { prefs?: Record<string, unknown> } = {}) {
  const calls: [string, unknown][] = [];
  vi.resetModules();
  vi.doMock('../app', () => ({
    prefs,
    hooks: { tabs: [], view: [], boot: [], idle: [] },
    T: {},
    toast() {},
    savePrefs() {},
    active: () => null,
    agent: () => null,
    confirmDialog: async () => false,
    effortLabel: () => '',
    pick: async () => null,
    restartSession: async () => false,
    sendText: async () => {},
    sleep: async () => {},
    invoke: async (name: string, args: unknown) => {
      calls.push([name, args]);
      
      return null;
    }
  }));
  vi.doMock('../late', () => ({ late: {} }));
  return (await import('./websearch')).WebSearch as any;
}
const W = await load();
const session = (...texts) => ({ chat: { turns: texts.map((text) => ({ text })) } });

test('every tool line is recognised, including BROWSE and KNOW', async () => {
  for (const k of ['SEARCH', 'BROWSE', 'SKILL', 'RUN', 'KNOW']) assert.equal(W.request(`${k}: something here`).kind, k);
  assert.deepEqual({ ...W.request('browse: https://example.com/a') }, { kind: 'BROWSE', arg: 'https://example.com/a' });
});

test('the dressing small models add around a tool line is tolerated', async () => {
  assert.equal(W.request('**SEARCH:** "rtx 5070 vram"').arg, 'rtx 5070 vram');
  assert.equal(W.request('`BROWSE: https://example.com`').arg, 'https://example.com');
  assert.equal(W.request('I will look that up.\n- SEARCH: tauri 2 csp').arg, 'tauri 2 csp');
});

test('an answer that only mentions a tool is not a request', async () => {
  assert.equal(W.request('Sure.\nYou can type things like\nSEARCH: weather\nand I will look.\nAnything else?'), null);
  assert.equal(W.request(`${'This is a long explanation. '.repeat(30)}\nSEARCH: x`), null);
  assert.equal(W.request('SEARCH: <query>'), null, 'the placeholder from the instructions is not a query');
  assert.equal(W.request('The answer is 4.'), null);
});

test('BROWSE only opens real web addresses', async () => {
  assert.equal(W.browseUrl('https://example.com/page).'), 'https://example.com/page');
  assert.equal(W.browseUrl('example.com/docs and read it'), 'https://example.com/docs');
  assert.equal(W.browseUrl('the tauri documentation'), '');
  assert.equal(W.browseUrl('file:///C:/secret.txt'), '');
});

test('a question that stands alone is searched as written, with nothing from earlier messages', async () => {
  const s = session('How do I merge two pandas DataFrames in Python 3.12?', 'What is the weather in Delhi tomorrow?');
  assert.equal(W.queryFor(s, 'What is the weather in Delhi tomorrow?'), 'What is the weather in Delhi tomorrow?');
});

test('a follow-up borrows only the names and numbers of the previous message', async () => {
  const s = session('Tell me about cooking rice', 'How much VRAM does the RTX 5070 have?', 'is it better than the 4070?');
  const q = W.queryFor(s, 'is it better than the 4070?');
  assert.equal(q, 'VRAM RTX 5070 is it better than the 4070?');
  assert.ok(!/rice|cooking/i.test(q));
});

test('the web is searched only when asked for unless the user chose always', async () => {
  assert.equal((await load()).mode(), 'auto');
  assert.equal((await load({ prefs: { webMode: 'always' } })).mode(), 'always');
});
