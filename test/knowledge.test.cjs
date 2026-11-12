const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

/** Load public/features/knowledge.js with stand-ins for the globals the app provides. */
function load({ prefs = {}, sources = [], hits = [] } = {}) {
  const calls = [];
  const hooks = { tabs: [], view: [], boot: [] };
  const ctx = {
    prefs,
    hooks,
    calls,
    document: { getElementById: () => null, querySelector: () => null },
    window: {},
    T: {},
    toast() {},
    savePrefs() {},
    active: () => null,
    WebSearch: { SMALLTALK: /^\s*(hi|hello|thanks?)\b[\s!.?]*$/i, applies: () => false },
    invoke: async (name, args) => {
      calls.push([name, args]);
      if (name === 'rag_sources') return sources;
      if (name === 'rag_search') return hits;
      return null;
    }
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'features', 'knowledge.js'), 'utf8')}\nthis.Knowledge = Knowledge;`, ctx);
  return ctx;
}

const hit = { source: 'C:\\notes\\gpu.md', text: 'The RTX 5070\nhas 12 GB of VRAM.', score: 2 };

test('passages become one block that names the file and tells the model not to guess', () => {
  const { Knowledge } = load();
  const block = Knowledge.format([hit]);
  assert.match(block, /^\[Knowledge from the user's own files \(1 passage\)\./);
  assert.ok(block.includes('(1) gpu.md - C:\\notes\\gpu.md - The RTX 5070 has 12 GB of VRAM.'));
  assert.match(block, /say so instead of guessing\.\]$/);
  assert.equal(Knowledge.format([]), '');
  assert.match(Knowledge.format([hit, hit]), /\(2 passages\)/);
});

test('a question is searched only when there are files, the switch is on and it is not small talk', async () => {
  const on = load({ sources: [{ path: 'a.md', passages: 1 }], hits: [hit] });
  await on.Knowledge.refresh();
  assert.ok((await on.Knowledge.block('how much VRAM does it have')).includes('gpu.md'));
  assert.equal(await on.Knowledge.block('hello'), '');
  assert.equal(await on.Knowledge.block('hm?'), '');

  const off = load({ prefs: { kbMode: 'off' }, sources: [{ path: 'a.md', passages: 1 }], hits: [hit] });
  await off.Knowledge.refresh();
  off.calls.length = 0;
  assert.equal(await off.Knowledge.block('how much VRAM does it have'), '');
  assert.equal(off.calls.length, 0, 'a switched-off index must not even be searched');

  const empty = load({ hits: [hit] });
  await empty.Knowledge.refresh();
  assert.equal(await empty.Knowledge.block('how much VRAM does it have'), '');
});

test('a backend that answers nothing leaves an empty list instead of breaking the button', async () => {
  const k = load({ sources: null });
  await k.Knowledge.refresh();
  assert.equal(k.Knowledge.files, 0);
  assert.equal(k.Knowledge.usable(), false);
});

test('the KNOW tool answers with passages, or says the files had nothing', async () => {
  const found = await load({ hits: [hit] }).Knowledge.lookup('vram');
  assert.match(found.msg, /passages from my files for "vram"/);
  assert.equal(found.note, 'Searched your files for “vram”');
  assert.equal(found.detail, '1. C:\\notes\\gpu.md');
  const none = await load({ hits: [] }).Knowledge.lookup('tax law');
  assert.match(none.msg, /My files have nothing about "tax law"/);
  assert.equal(none.note, 'Your files had nothing for “tax law”');
});
