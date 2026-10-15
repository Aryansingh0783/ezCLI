const assert = require('node:assert/strict');
const test = require('node:test');
const usage = require('../public/usage-parser.js');

test('accumulates an explicit multi-metric text summary', () => {
  const state = usage.createUsageState();
  assert.equal(usage.ingest(state, 'Input tokens: 1,200 | Output tokens: 340 | Cached tokens: 800 | Cost: $0.015\r\n'), true);
  assert.equal(usage.ingest(state, 'Input: 20, Output: 5, Cached: 10, Cost: $0.001\r\n'), true);
  assert.deepEqual(state.total, { input: 1220, output: 345, cached: 810, cost: 0.016 });
  assert.deepEqual(state.turn, { input: 20, output: 5, cached: 10, cost: 0.001 });
});

test('collects a multi-line labelled summary only once the block is complete', () => {
  const state = usage.createUsageState();
  assert.equal(usage.ingest(state, 'Input tokens: 1.4k\n'), false);
  assert.equal(state.observed, false);
  assert.equal(usage.ingest(state, 'Output tokens: 300\n'), false);
  assert.equal(usage.ingest(state, '\n'), true);
  assert.deepEqual(state.total, { input: 1400, output: 300, cached: null, cost: null });
});

test('flushes a held multi-line summary only after terminal output goes quiet', () => {
  const state = usage.createUsageState();
  assert.equal(usage.ingest(state, 'Input tokens: 80\n'), false);
  assert.equal(usage.ingest(state, 'Output tokens: 20\n'), false);
  assert.equal(usage.ingest(state, '', true), true);
  assert.deepEqual(state.total, { input: 80, output: 20, cached: null, cost: null });
});

test('handles a Claude result record split across an ANSI sequence and keeps cumulative cost as a snapshot', () => {
  const state = usage.createUsageState();
  const first = JSON.stringify({
    type: 'result',
    usage: { input_tokens: 50, output_tokens: 25, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 },
    total_cost_usd: 0.02
  });
  const second = JSON.stringify({
    type: 'result',
    usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 3 },
    total_cost_usd: 0.03
  });
  const firstRecord = '\x1b[32m' + first + '\x1b[0m';
  const splitAt = Math.floor(firstRecord.length / 2);
  assert.equal(usage.ingest(state, firstRecord.slice(0, splitAt)), false);
  assert.equal(usage.ingest(state, firstRecord.slice(splitAt) + '\r'), true);
  assert.equal(usage.ingest(state, second + '\r'), true);
  assert.deepEqual(state.total, { input: 70, output: 30, cached: 15, cost: 0.03 });
  assert.deepEqual(state.turn, { input: 20, output: 5, cached: 3, cost: 0.01 });
});

test('reads a Codex turn.completed record and combines reasoning output', () => {
  const state = usage.createUsageState();
  const event = JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 8, reasoning_output_tokens: 12 }
  });
  assert.equal(usage.ingest(state, event + '\r\n'), true);
  assert.deepEqual(state.total, { input: 100, output: 20, cached: 70, cost: null });
});

test('ignores untyped JSON and one-metric prose, but counts a later identical turn', () => {
  const state = usage.createUsageState();
  assert.equal(usage.ingest(state, '{"input_tokens": 99}\r\n'), false);
  assert.equal(usage.ingest(state, 'Input tokens: 99\r\n'), false);
  assert.equal(state.observed, false);

  const summary = 'Input tokens: 10 | Output tokens: 5\r\n';
  assert.equal(usage.ingest(state, summary), true);
  assert.equal(usage.ingest(state, summary), false);
  state.lastFingerprintAt -= 1201;
  assert.equal(usage.ingest(state, summary), true);
  assert.equal(state.total.input, 20);
});

test('does not infer usage or cost from ordinary output', () => {
  const state = usage.createUsageState();
  assert.equal(usage.ingest(state, 'Writing input.txt and output.txt\n', true), false);
  assert.equal(state.observed, false);
  assert.equal(usage.formatTokens(1200), '1.2k');
  assert.equal(usage.formatCost(0.002), '$0.002');
  assert.equal(usage.tokenTotal({ input: 10, output: 5, cached: null }), 15);
});
