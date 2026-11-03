const assert = require('node:assert/strict');
const test = require('node:test');
const { splitThinking } = require('../public/thinking.js');

test('plain text is all answer', () => {
  assert.deepEqual(splitThinking('Hello there'), { think: '', answer: 'Hello there' });
});

test('Ollama style block', () => {
  const r = splitThinking('Thinking...\nwork it out\n...done thinking.\n\nThe answer');
  assert.equal(r.think, 'work it out');
  assert.equal(r.answer, 'The answer');
  assert.equal(r.open, false);
});

test('llama.cpp console markers, finished and still streaming', () => {
  const done = splitThinking('[Start thinking]\nstep 1\nstep 2\n[End thinking]\n\nFinal');
  assert.equal(done.think, 'step 1\nstep 2');
  assert.equal(done.answer, 'Final');
  const live = splitThinking('[Start thinking]\nstep 1');
  assert.equal(live.think, 'step 1');
  assert.equal(live.answer, '');
  assert.equal(live.open, true);
});

test('think tags, including text before them', () => {
  const r = splitThinking('Hi\n<think>hmm</think>\nAnswer');
  assert.equal(r.think, 'hmm');
  assert.equal(r.answer, 'Hi\nAnswer');
  assert.equal(splitThinking('<think>still going').open, true);
});
