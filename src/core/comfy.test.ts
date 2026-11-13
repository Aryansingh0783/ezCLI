import { describe, expect, it } from 'vitest';
import { bytesText, chatReply, totalGib, view } from './comfy';
import type { StudioInfo } from './ipc.gen';

const models = [
  { id: 'sdxl', kind: 'image', label: 'Stable Diffusion XL', name: 'sd_xl_base_1.0.safetensors', gib: 6.9, present: false },
  { id: 'wan-model', kind: 'video', label: 'Wan 2.2 video model', name: 'wan2.2_ti2v_5B_fp16.safetensors', gib: 10, present: false },
  { id: 'wan-text', kind: 'video', label: 'Wan text encoder', name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', gib: 6.7, present: true },
  { id: 'wan-vae', kind: 'video', label: 'Wan 2.2 decoder', name: 'wan2.2_vae.safetensors', gib: 1.4, present: false },
];
const info = (over: Partial<StudioInfo['status']>, checkpoints: string[] = [], videoReady = false): StudioInfo => ({
  status: { supported: true, installed: false, running: false, port: 0, managed: false, models, folder: 'C:\\Users\\a\\.ezcli\\studio', ...over },
  checkpoints,
  videoReady,
});

describe('what the Create panel shows', () => {
  it('offers to set it up where ezCLI can, and says to bring ComfyUI where it cannot', () => {
    expect(view(info({}), 'image').stage).toBe('setup');
    expect(view(info({ supported: false }), 'image').stage).toBe('bring');
  });
  it('starts an installed engine that is not answering', () => {
    expect(view(info({ installed: true }), 'video').stage).toBe('start');
  });
  it('asks for the models of the chosen kind only, and downloads them only into its own engine', () => {
    const own = view(info({ installed: true, running: true, managed: true, port: 8317 }), 'image');
    expect(own).toMatchObject({ stage: 'models', canDownload: true });
    expect(own.needed.map((m) => m.id)).toEqual(['sdxl']);
    const video = view(info({ installed: true, running: true, managed: true, port: 8317 }), 'video');
    expect(video.needed.map((m) => m.id)).toEqual(['wan-model', 'wan-vae']);
    expect(totalGib(video.needed)).toBe('11.4 GB');
    const theirs = view(info({ running: true, port: 8188 }), 'image');
    expect(theirs).toMatchObject({ stage: 'models', canDownload: false });
  });
  it('is ready when the engine has a model for the kind', () => {
    expect(view(info({ running: true, port: 8188 }, ['a.safetensors']), 'image').stage).toBe('ready');
    expect(view(info({ running: true, port: 8188 }, ['a.safetensors']), 'video').stage).toBe('models');
    expect(view(info({ running: true, port: 8188 }, [], true), 'video').stage).toBe('ready');
  });
  it('writes download sizes plainly', () => {
    expect(bytesText(430 * 1024 ** 2)).toBe('430 MB');
    expect(bytesText(3.24 * 1024 ** 3)).toBe('3.2 GB');
  });
});

describe('what a local model is told', () => {
  it('gets the path of a finished picture and is told not to describe it', () => {
    const r = chatReply('image', { state: 'done', path: 'C:\\Pictures\\ezCLI\\a.png' });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('a.png');
    expect(r.text).toMatch(/have not seen it/);
  });
  it('is told a video is under way, and why something failed', () => {
    expect(chatReply('video', { state: 'working' })).toMatchObject({ ok: true });
    const bad = chatReply('image', { state: 'failed', why: 'There is no image model yet.' });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('There is no image model yet.');
  });
});
