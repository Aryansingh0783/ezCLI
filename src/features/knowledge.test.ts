import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

/** The module under test with stand-ins for what the app provides. */
async function load({ prefs = {}, sources = [], hits = [] }: { prefs?: Record<string, unknown>; sources?: unknown; hits?: unknown } = {}) {
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
      if (name === 'rag_sources') return sources;
      if (name === 'rag_search') return hits;
      return null;
    }
  }));
  vi.doMock('../late', () => ({ late: {} }));
  const Knowledge = (await import('./knowledge')).Knowledge as any;
  return { Knowledge, calls, prefs };
}
const hit = { source: 'C:\\notes\\gpu.md', text: 'The RTX 5070\nhas 12 GB of VRAM.', score: 2 };

test('passages become one block that names the file and tells the model not to guess', async () => {
  const { Knowledge } = await load();
  const block = Knowledge.format([hit]);
  assert.match(block, /^\[Knowledge from the user's own files \(1 passage\)\./);
  assert.ok(block.includes('(1) gpu.md - C:\\notes\\gpu.md - The RTX 5070 has 12 GB of VRAM.'));
  assert.match(block, /say so instead of guessing\.\]$/);
  assert.equal(Knowledge.format([]), '');
  assert.match(Knowledge.format([hit, hit]), /\(2 passages\)/);
});

test('a question is searched only when there are files, the switch is on and it is not small talk', async () => {
  const on = await load({ sources: [{ path: 'a.md', passages: 1 }], hits: [hit] });
  await on.Knowledge.refresh();
  assert.ok((await on.Knowledge.block('how much VRAM does it have')).includes('gpu.md'));
  assert.equal(await on.Knowledge.block('hello'), '');
  assert.equal(await on.Knowledge.block('hm?'), '');

  const off = await load({ prefs: { kbMode: 'off' }, sources: [{ path: 'a.md', passages: 1 }], hits: [hit] });
  await off.Knowledge.refresh();
  off.calls.length = 0;
  assert.equal(await off.Knowledge.block('how much VRAM does it have'), '');
  assert.equal(off.calls.length, 0, 'a switched-off index must not even be searched');

  const empty = await load({ hits: [hit] });
  await empty.Knowledge.refresh();
  assert.equal(await empty.Knowledge.block('how much VRAM does it have'), '');
});

test('a backend that answers nothing leaves an empty list instead of breaking the button', async () => {
  const k = await load({ sources: null });
  await k.Knowledge.refresh();
  assert.equal(k.Knowledge.files, 0);
  assert.equal(k.Knowledge.usable(), false);
});

test('the KNOW tool answers with passages, or says the files had nothing', async () => {
  const found = await (await load({ hits: [hit] })).Knowledge.lookup('vram');
  assert.match(found.msg, /passages from my files for "vram"/);
  assert.equal(found.note, 'Searched your files for “vram”');
  assert.equal(found.detail, '1. C:\\notes\\gpu.md');
  const none = await (await load({ hits: [] })).Knowledge.lookup('tax law');
  assert.match(none.msg, /My files have nothing about "tax law"/);
  assert.equal(none.note, 'Your files had nothing for “tax law”');
});
