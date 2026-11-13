import { describe, expect, it } from 'vitest';
import { splitThinking } from './thinking';

describe('splitThinking', () => {
  it('returns plain text as the answer', () => {
    expect(splitThinking('Hello there')).toEqual({ think: '', answer: 'Hello there' });
  });

  it('reads the Ollama markers', () => {
    expect(splitThinking('Thinking...\nwork it out\n...done thinking.\n\nThe answer')).toEqual({ think: 'work it out', answer: 'The answer', open: false });
  });

  it('reads the llama.cpp console markers, finished and still streaming', () => {
    expect(splitThinking('[Start thinking]\nstep 1\nstep 2\n[End thinking]\n\nFinal')).toMatchObject({ think: 'step 1\nstep 2', answer: 'Final', open: false });
    expect(splitThinking('[Start thinking]\nstep 1')).toMatchObject({ think: 'step 1', answer: '', open: true });
  });

  it('reads <think> tags, including text before them', () => {
    expect(splitThinking('Hi\n<think>hmm</think>\nAnswer')).toMatchObject({ think: 'hmm', answer: 'Hi\nAnswer' });
    expect(splitThinking('<think>still going').open).toBe(true);
  });

  it('does not mistake the word "Thinking..." inside a sentence for a marker', () => {
    expect(splitThinking('I was Thinking... about it')).toEqual({ think: '', answer: 'I was Thinking... about it' });
  });
});

describe('splitThinking under chaotic stream cuts', () => {
  const cases = [
    '<think>first I consider\nthe options</think>\nThe answer is 4.',
    '[Start thinking]\nstep 1\nstep 2\n[End thinking]\n\nFinal answer here.',
    'Thinking...\nwork it out\n...done thinking.\n\nThe answer',
    'Intro line\n<think>mid thought</think>\nrest of it'
  ];

  it('never shows part of a marker, in the answer or in the reasoning, at any cut', () => {
    for (const full of cases) {
      const done = splitThinking(full);
      for (let n = 0; n <= full.length; n++) {
        const r = splitThinking(full.slice(0, n), true);
        // whatever is shown is a piece of the final text, never a stray "<thi" or "[End thin"
        expect(done.answer.startsWith(r.answer) || r.answer === '', `answer at ${n}: ${JSON.stringify(r.answer)}`).toBe(true);
        expect(done.think.startsWith(r.think), `reasoning at ${n}: ${JSON.stringify(r.think)}`).toBe(true);
      }
    }
  });

  it('moves from thinking to answering once and never back', () => {
    for (const full of cases) {
      let closed = false;
      for (let n = 0; n <= full.length; n++) {
        const r = splitThinking(full.slice(0, n), true);
        if (r.open === false) closed = true;
        if (closed) expect(r.open, `reopened at ${n}`).toBe(false);
      }
      expect(closed).toBe(true);
    }
  });

  it('gives the same final split however the text was cut', () => {
    for (const full of cases) expect(splitThinking(full, true)).toEqual(splitThinking(full));
  });
});
