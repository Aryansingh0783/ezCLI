const assert = require('node:assert/strict');
const test = require('node:test');
const routing = require('../public/session-routing.js');

const codex = {
  modes: [
    { id: 'default', label: 'Default', args: [] },
    { id: 'auto', label: 'Full auto', args: ['--full-auto'] },
    { id: 'resume', label: 'Resume', args: ['resume', '--last'], resumesSession: true }
  ]
};

test('recognizes explicit and legacy continuation modes', () => {
  assert.equal(routing.isContinuationMode(codex, 'resume'), true);
  assert.equal(routing.isContinuationMode({ modes: [{ id: 'custom', args: ['--continue'] }] }, 'custom'), true);
  assert.equal(routing.isContinuationMode(codex, 'auto'), false);
});

test('fresh launches retain ordinary modes but replace resume with default', () => {
  assert.equal(routing.freshModeId(codex, 'auto'), 'auto');
  assert.equal(routing.freshModeId(codex, 'resume'), 'default');
});

test('a model switch keeps an ordinary mode but never carries resume forward', () => {
  assert.deepEqual(routing.modelSwitchPlan(codex, 'auto', 'gpt-5'), {
    modelId: 'gpt-5',
    modeId: 'auto'
  });
  assert.deepEqual(routing.modelSwitchPlan(codex, 'resume', 'gpt-5'), {
    modelId: 'gpt-5',
    modeId: 'default'
  });
});

test('uses a non-resume fallback when a custom agent has no default mode', () => {
  const custom = {
    modes: [
      { id: 'continue', args: ['--continue'] },
      { id: 'plan', args: ['--plan'] }
    ]
  };
  assert.equal(routing.freshModeId(custom, 'continue'), 'plan');
});

test('does not treat a custom continuation default as a fresh launch', () => {
  const custom = {
    modes: [
      { id: 'default', args: ['--continue'] },
      { id: 'fresh', args: [] }
    ]
  };
  assert.equal(routing.freshModeId(custom, 'default'), 'fresh');
});
