import { describe, expect, it } from 'vitest';
import { connect, disconnect, findConnector, view } from './voicestudio';

const URL = 'http://127.0.0.1:3900/mcp/';
const strata = { id: 'a', name: 'Strata', url: 'https://strata.example/mcp', enabled: true };

describe('VoiceStudio connector', () => {
  it('is added once, switched on, and other connectors are left alone', () => {
    const one = connect([strata], URL, () => 'new');
    expect(one).toEqual([strata, { id: 'new', name: 'VoiceStudio', url: URL, enabled: true }]);
    expect(connect(one, URL, () => 'again')).toEqual(one);
    const off = one.map((c) => (c.id === 'new' ? { ...c, enabled: false } : c));
    expect(connect(off, URL, () => 'x')[1]).toMatchObject({ id: 'new', enabled: true });
  });

  it('is recognised however the address was typed, and never confused with a remote server', () => {
    for (const url of ['http://127.0.0.1:3900/mcp', 'http://localhost:3900/mcp/', ' HTTP://127.0.0.1:3900/mcp/ ']) {
      expect(findConnector([{ id: 'v', name: 'voice', url, enabled: true }], URL)?.id).toBe('v');
    }
    expect(findConnector([strata], URL)).toBeUndefined();
    expect(findConnector([{ id: 'p', name: 'other port', url: 'http://127.0.0.1:4000/mcp/', enabled: true }], URL)).toBeUndefined();
    expect(findConnector([{ id: 'r', name: 'remote', url: 'http://evil.example:3900/mcp/', enabled: true }], URL)).toBeUndefined();
  });

  it('is removed without touching the rest', () => {
    expect(disconnect(connect([strata], URL, () => 'n'), URL)).toEqual([strata]);
    expect(disconnect([strata], URL)).toEqual([strata]);
  });

  it('offers the right next step in each state', () => {
    const on = { id: 'v', name: 'VoiceStudio', url: URL, enabled: true };
    expect(view(true, undefined).actions).toEqual(['connect']);
    expect(view(true, on)).toMatchObject({ actions: ['disconnect'], tone: 'ok' });
    expect(view(false, on)).toMatchObject({ actions: ['check', 'disconnect'], tone: 'warn' });
    expect(view(false, undefined).actions).toEqual(['check', 'get']);
    expect(view(true, { ...on, enabled: false }).actions).toEqual(['connect']);
  });
});
