import { describe, expect, it } from 'vitest';
import { echoKey } from './echo';

describe('recognising the first message on screen', () => {
  it('uses the start of the message with spaces collapsed', () => {
    expect(echoKey('Use your  create_image\ntool to make a picture')).toBe('Use your create_im');
    expect(echoKey('  hi  ')).toBe('hi');
    expect(echoKey(null)).toBe('');
  });
});
