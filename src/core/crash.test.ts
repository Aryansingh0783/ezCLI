import { describe, expect, it } from 'vitest';
import { crashPlan, hex, isCrash } from './crash';

const base = { agentId: 'gguf', modeId: 'gpu', modes: ['gpu', 'cpu'], alreadyFailedOver: false };

describe('crashPlan', () => {
  it('recognises the Windows access violation in both the forms the exit code arrives in', () => {
    expect(isCrash(3221225477)).toBe(true);
    expect(isCrash(-1073741819)).toBe(true);
    expect(isCrash('3221225477')).toBe(true);
    expect(hex(3221225477)).toBe('0xC0000005');
    expect(hex(-1073741819)).toBe('0xC0000005');
    expect(hex(139)).toBe('139');
  });

  it('moves a GPU crash to the CPU and says so', () => {
    const p = crashPlan({ ...base, exitCode: 3221225477 });
    expect(p.kind).toBe('failover');
    if (p.kind !== 'failover') return;
    expect(p.toMode).toBe('cpu');
    expect(p.notice).toContain('0xC0000005');
    expect(p.notice).toContain('-ngl 0');
  });

  it('fails over only once per session, so a model that crashes everywhere cannot loop', () => {
    expect(crashPlan({ ...base, exitCode: 139, alreadyFailedOver: true }).kind).toBe('advise');
  });

  it('never restarts after a crash on the CPU, and does not blame the GPU for it', () => {
    const p = crashPlan({ ...base, modeId: 'cpu', exitCode: -1073741819 });
    expect(p.kind).toBe('advise');
    if (p.kind === 'advise') expect(p.notice).toContain('not a GPU problem');
  });

  it('treats a custom mode as a GPU mode, and only advises when the agent has no CPU mode to fall back to', () => {
    expect(crashPlan({ ...base, modeId: 'my-mode', exitCode: 134 }).kind).toBe('failover');
    expect(crashPlan({ ...base, modes: ['gpu'], exitCode: 134 }).kind).toBe('advise');
  });

  it('leaves ordinary exits, user stops and other agents alone', () => {
    for (const exitCode of [0, 1, 130, 3221225786, null, undefined, 'x']) expect(crashPlan({ ...base, exitCode }).kind).toBe('none');
    expect(crashPlan({ ...base, agentId: 'ollama', exitCode: 3221225477 }).kind).toBe('none');
  });
});
