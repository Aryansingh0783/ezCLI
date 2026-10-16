'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const A = require('../agents');

const agents = A.loadAgents(path.join(__dirname, '..', '..', 'agents.json'));
const byId = (id) => agents.find((a) => a.id === id);

test('launch order matches the app: base, effort, model, mode', () => {
  const codex = byId('codex');
  assert.deepStrictEqual(A.buildArgs(codex, { effortId: 'high', modelId: 'gpt-6-luna', modeId: 'auto' }), [
    '--no-daemon', '-c', 'model_reasoning_effort="high"', '-m', 'gpt-6-luna', '--full-auto'
  ]);
});

test('subcommand catalogs launch as `ollama run <model>`', () => {
  assert.deepStrictEqual(A.buildArgs(byId('ollama'), { modelId: 'llama3.2:3b' }), ['run', 'llama3.2:3b']);
});

test('a flag-like model id is never passed through', () => {
  assert.deepStrictEqual(A.buildArgs(byId('codex'), { modelId: '--yolo' }), ['--no-daemon']);
});

test('catalog parsers keep only real model ids', () => {
  assert.deepStrictEqual(A.parseCatalog('codex', '{"models":[{"slug":"a","visibility":"list"},{"slug":"b","visibility":"hide"},{"slug":"-x"}]}'), ['a']);
  assert.deepStrictEqual(A.parseCatalog('ollama', 'NAME ID SIZE\nllama3:8b a80c4f17acd5 4 GB\nkimi:cloud 1f2e3d4c5b6a -\n'), ['llama3:8b']);
  assert.deepStrictEqual(A.parseCatalog(undefined, 'banner\nopencode/big-pickle\n--bad/x\n'), ['opencode/big-pickle']);
});

test('PowerShell quoting is literal', () => {
  assert.strictEqual(A.quote("it's here", 'powershell'), "'it''s here'");
  assert.strictEqual(A.quote('plain-arg', 'powershell'), 'plain-arg');
  assert.strictEqual(A.commandLine(byId('claude-code'), { modelId: 'opus' }, 'powershell'), '& claude --model opus');
});
