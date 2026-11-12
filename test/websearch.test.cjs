const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

/** Load public/features/websearch.js with stand-ins for the globals the app provides. */
function load({ prefs = {} } = {}) {
  const hooks = { tabs: [], view: [], boot: [], idle: [] };
  const ctx = { prefs, hooks, document: { getElementById: () => null, querySelector: () => null }, toast() {}, savePrefs() {}, active: () => null, agent: () => null, invoke: async () => null };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'features', 'websearch.js'), 'utf8')}\nthis.WebSearch = WebSearch;`, ctx);
  return ctx.WebSearch;
}
const W = load();
const session = (...texts) => ({ chat: { turns: texts.map((text) => ({ text })) } });

test('every tool line is recognised, including BROWSE and KNOW', () => {
  for (const k of ['SEARCH', 'BROWSE', 'SKILL', 'RUN', 'KNOW']) assert.equal(W.request(`${k}: something here`).kind, k);
  assert.deepEqual({ ...W.request('browse: https://example.com/a') }, { kind: 'BROWSE', arg: 'https://example.com/a' });
});

test('the dressing small models add around a tool line is tolerated', () => {
  assert.equal(W.request('**SEARCH:** "rtx 5070 vram"').arg, 'rtx 5070 vram');
  assert.equal(W.request('`BROWSE: https://example.com`').arg, 'https://example.com');
  assert.equal(W.request('I will look that up.\n- SEARCH: tauri 2 csp').arg, 'tauri 2 csp');
});

test('an answer that only mentions a tool is not a request', () => {
  assert.equal(W.request('Sure.\nYou can type things like\nSEARCH: weather\nand I will look.\nAnything else?'), null);
  assert.equal(W.request(`${'This is a long explanation. '.repeat(30)}\nSEARCH: x`), null);
  assert.equal(W.request('SEARCH: <query>'), null, 'the placeholder from the instructions is not a query');
  assert.equal(W.request('The answer is 4.'), null);
});

test('BROWSE only opens real web addresses', () => {
  assert.equal(W.browseUrl('https://example.com/page).'), 'https://example.com/page');
  assert.equal(W.browseUrl('example.com/docs and read it'), 'https://example.com/docs');
  assert.equal(W.browseUrl('the tauri documentation'), '');
  assert.equal(W.browseUrl('file:///C:/secret.txt'), '');
});

test('a question that stands alone is searched as written, with nothing from earlier messages', () => {
  const s = session('How do I merge two pandas DataFrames in Python 3.12?', 'What is the weather in Delhi tomorrow?');
  assert.equal(W.queryFor(s, 'What is the weather in Delhi tomorrow?'), 'What is the weather in Delhi tomorrow?');
});

test('a follow-up borrows only the names and numbers of the previous message', () => {
  const s = session('Tell me about cooking rice', 'How much VRAM does the RTX 5070 have?', 'is it better than the 4070?');
  const q = W.queryFor(s, 'is it better than the 4070?');
  assert.equal(q, 'VRAM RTX 5070 is it better than the 4070?');
  assert.ok(!/rice|cooking/i.test(q));
});

test('the web is searched only when asked for unless the user chose always', () => {
  assert.equal(load().mode(), 'auto');
  assert.equal(load({ prefs: { webMode: 'always' } }).mode(), 'always');
});
