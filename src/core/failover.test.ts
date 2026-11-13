import { describe, expect, it } from 'vitest';
import { MAX_SWITCHES, failoverPlan, handoffText, modelKey, transcript } from './failover';

const agents = [
  { id: 'opencode', free: true, available: true, sameService: false, needsModel: false },
  { id: 'claude', free: false, available: true, sameService: false, needsModel: false },
  { id: 'gemini', free: true, available: true, sameService: false, needsModel: false },
  { id: 'ollama', free: true, available: true, sameService: false, needsModel: true },
  { id: 'freebuff', free: true, available: false, sameService: false, needsModel: false }
];
const base = {
  agentId: 'opencode',
  modelId: 'deepseek-flash',
  models: [
    { id: 'big-paid', free: false },
    { id: 'deepseek-flash', free: true },
    { id: 'qwen-free', free: true },
    { id: 'glm-free', free: true }
  ],
  agents,
  tried: [] as string[],
  canResume: true
};

describe('failoverPlan', () => {
  it('moves to the next free model of the same agent and resumes the conversation there', () => {
    expect(failoverPlan(base)).toEqual({ kind: 'model', modelId: 'qwen-free', resume: true });
  });

  it('never picks a paid model, and skips models this conversation already ran out on', () => {
    const p = failoverPlan({ ...base, modelId: 'qwen-free', tried: [modelKey('opencode', 'deepseek-flash')] });
    expect(p).toEqual({ kind: 'model', modelId: 'glm-free', resume: true });
  });

  it('goes to another free agent when the agent has no free model left, skipping paid, missing and unconfigured ones', () => {
    const tried = ['deepseek-flash', 'qwen-free'].map((m) => modelKey('opencode', m));
    expect(failoverPlan({ ...base, modelId: 'glm-free', tried })).toEqual({ kind: 'agent', agentId: 'gemini' });
  });

  it('does not move to an agent on the same account, which has the same limit', () => {
    const p = failoverPlan({ ...base, models: [], agents: [{ id: 'opencode-zen', free: true, available: true, sameService: true, needsModel: false }] });
    expect(p).toEqual({ kind: 'none', why: 'nothing-free' });
  });

  it('leaves a paid subscription that hit its limit to the user when nothing free is installed', () => {
    const p = failoverPlan({ ...base, agentId: 'claude', modelId: 'opus', models: [{ id: 'sonnet', free: false }], agents: agents.filter((a) => !a.free || a.needsModel) });
    expect(p).toEqual({ kind: 'none', why: 'nothing-free' });
  });

  it('stops after a few switches so a service that limits everything cannot loop', () => {
    const tried = Array.from({ length: MAX_SWITCHES }, (_, k) => modelKey('opencode', `m${k}`));
    expect(failoverPlan({ ...base, tried })).toEqual({ kind: 'none', why: 'limit' });
  });

  it('says whether the CLI can reopen its conversation', () => {
    expect(failoverPlan({ ...base, canResume: false })).toMatchObject({ kind: 'model', resume: false });
  });
});

describe('handoff', () => {
  const turns = [
    { text: 'Add a retry to the upload', reply: 'Done: upload() now retries three times.' },
    { text: 'Now add a test for it', reply: null }
  ];

  it('carries both sides of the conversation, oldest first, and ends on what to do next', () => {
    const t = handoffText('OpenCode', turns);
    expect(t.indexOf('Add a retry')).toBeLessThan(t.indexOf('Now add a test'));
    expect(t).toContain('Assistant: Done: upload() now retries three times.');
    expect(t).toContain('ran out of usage');
    expect(t.trim().endsWith('before changing them.')).toBe(true);
  });

  it('keeps the newest turns when the conversation is longer than the budget', () => {
    const long = Array.from({ length: 40 }, (_, k) => ({ text: `question ${k}`, reply: 'x'.repeat(900) }));
    const t = transcript(long, 3000);
    expect(t).toContain('question 39');
    expect(t).not.toContain('question 3\n');
    expect(t.length).toBeLessThan(5000);
  });

  it('still works with nothing to carry', () => {
    expect(transcript([])).toBe('');
    expect(handoffText('Codex', [])).toContain('you are taking over');
  });
});
