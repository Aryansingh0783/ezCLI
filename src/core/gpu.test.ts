import { describe, expect, it } from 'vitest';
import { memoryStatus, neededMib, parseSpeed, preflight } from './gpu';

const GB = 1024 ** 3;

describe('parseSpeed', () => {
  it("reads llama.cpp's speed line, the last one when there are several", () => {
    expect(parseSpeed('answer\r\n[ Prompt: 464.2 t/s | Generation: 18.8 t/s ]\r\n> ')).toEqual({ prompt: 464.2, generation: 18.8 });
    expect(parseSpeed('[ Prompt: 1 t/s | Generation: 2 t/s ] … [ Prompt: 886.6 t/s | Generation: 53 t/s ]')?.generation).toBe(53);
  });
  it('ignores text that only looks similar', () => {
    expect(parseSpeed('Generation: fast')).toBeNull();
    expect(parseSpeed('[ Prompt: x t/s | Generation: y t/s ]')).toBeNull();
    expect(parseSpeed('')).toBeNull();
  });
});

describe('preflight', () => {
  const card = (usedMib: number) => ({ usedMib, totalMib: 12227 });

  it('says nothing when the model fits in what is free', () => {
    expect(preflight(card(1500), 5 * GB)).toBeNull();
    expect(preflight(card(1200), 8.1 * 1e9)).toBeNull();
  });
  it('warns with the numbers when other programs have taken the room', () => {
    const w = preflight(card(4200), 8.1 * 1e9);
    expect(w).toContain('other programs are using 4.1 GB');
    expect(w).toContain('7.8 GB is free');
    expect(w).toContain('Q4_K_M');
  });
  it('says the card itself is too small when that is the case', () => {
    expect(preflight(card(500), 16 * GB)).toContain('the card has 11.9 GB');
  });
  it('stays silent without a reading or a size', () => {
    expect(preflight(null, 8 * GB)).toBeNull();
    expect(preflight(card(100), 0)).toBeNull();
    expect(preflight({ usedMib: 0, totalMib: 0 }, 8 * GB)).toBeNull();
  });
  it('counts working room on top of the file', () => {
    expect(neededMib(8 * GB)).toBe(Math.round(8192 * 1.05) + 1024);
  });
});

describe('memoryStatus', () => {
  it('reports use and flags a full card', () => {
    expect(memoryStatus({ usedMib: 8400, totalMib: 12227 })).toEqual({ text: 'GPU memory: 8.2 of 11.9 GB', full: false });
    expect(memoryStatus({ usedMib: 12100, totalMib: 12227 })).toEqual({ text: 'GPU memory full: 11.8 of 11.9 GB', full: true });
    expect(memoryStatus(null)).toBeNull();
  });
});
