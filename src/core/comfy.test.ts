import { describe, expect, it } from 'vitest';
import { imageSettings, imageSize, imageWorkflow, isComfy, parseHistory, parseList, parseQueued, queueDepth, readiness, videoFrames, videoModel, videoWorkflow } from './comfy';

const none = { checkpoints: [], diffusion: [], encoders: [], vaes: [] };
const wan = { checkpoints: [], diffusion: ['wan2.2_ti2v_5B_fp16.safetensors'], encoders: ['umt5_xxl_fp8_e4m3fn_scaled.safetensors'], vaes: ['ae.safetensors', 'wan2.2_vae.safetensors'] };

/** Every link in a job points at a step that exists, the way ComfyUI checks it. */
function linksResolve(job: Record<string, { inputs: Record<string, unknown> }>) {
  for (const step of Object.values(job)) {
    for (const v of Object.values(step.inputs)) {
      if (Array.isArray(v)) expect(Object.keys(job)).toContain(v[0]);
    }
  }
}

describe('finding ComfyUI', () => {
  it('tells ComfyUI from another program on the port', () => {
    expect(isComfy('{"system":{"os":"nt","comfyui_version":"0.21.1"},"devices":[]}')).toBe(true);
    expect(isComfy('<html>dev server</html>')).toBe(false);
    expect(isComfy(null)).toBe(false);
  });
  it('reads a model list and survives a bad one', () => {
    expect(parseList('["a.safetensors","sub/b.ckpt"]')).toEqual(['a.safetensors', 'sub/b.ckpt']);
    expect(parseList('not json')).toEqual([]);
    expect(parseList('{"a":1}')).toEqual([]);
  });
});

describe('pictures', () => {
  it('picks settings from the checkpoint name', () => {
    expect(imageSettings('v1-5-pruned-emaonly.safetensors').base).toBe(512);
    expect(imageSettings('sd_xl_base_1.0.safetensors').base).toBe(1024);
    expect(imageSettings('flux1-schnell-fp8.safetensors')).toMatchObject({ cfg: 1, steps: 4, negative: false });
    expect(imageSettings('dreamshaperXL_lightning.safetensors')).toMatchObject({ base: 1024, steps: 6 });
  });
  it('sizes are multiples of 64', () => {
    expect(imageSize(1024, 'square')).toEqual([1024, 1024]);
    expect(imageSize(1024, 'wide')).toEqual([1280, 768]);
    expect(imageSize(512, 'tall')).toEqual([384, 640]);
  });
  it('builds a job whose links all resolve and that saves under ezCLI', () => {
    const job = imageWorkflow({ ckpt: 'sd_xl_base_1.0.safetensors', prompt: 'a red bicycle', shape: 'wide', seed: 7 });
    linksResolve(job);
    expect(job['1'].inputs.ckpt_name).toBe('sd_xl_base_1.0.safetensors');
    expect(job['2'].inputs.text).toBe('a red bicycle');
    expect(job['4'].inputs).toMatchObject({ width: 1280, height: 768 });
    expect(job['7']).toMatchObject({ class_type: 'SaveImage', inputs: { filename_prefix: 'ezCLI' } });
  });
});

describe('video', () => {
  it('needs all three files and names the missing ones', () => {
    expect(videoModel(wan).model).toEqual({ unet: 'wan2.2_ti2v_5B_fp16.safetensors', clip: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', vae: 'wan2.2_vae.safetensors' });
    const part = videoModel({ ...wan, vaes: ['ae.safetensors'] });
    expect(part.model).toBeNull();
    expect(part.missing.map((m) => m.folder)).toEqual(['vae']);
    expect(videoModel(none).missing).toHaveLength(3);
  });
  it('frame counts are 4n+1', () => {
    expect(videoFrames(3)).toBe(73);
    expect(videoFrames(5)).toBe(121);
  });
  it('builds a job whose links all resolve', () => {
    const job = videoWorkflow({ model: videoModel(wan).model!, prompt: 'waves at dusk', shape: 'wide', seconds: 3, seed: 1 });
    linksResolve(job);
    expect(job['7'].inputs).toMatchObject({ width: 1280, height: 704, length: 73 });
    expect(job['10'].class_type).toBe('SaveWEBM');
  });
});

describe('replies', () => {
  it('reads the job id', () => {
    expect(parseQueued('{"prompt_id":"abc","number":1,"node_errors":{}}')).toEqual({ id: 'abc' });
  });
  it('turns a refusal into words', () => {
    const body = JSON.stringify({
      error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' },
      node_errors: { '1': { class_type: 'CheckpointLoaderSimple', errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "ckpt_name: 'x.safetensors' not in []" }] } },
    });
    const r = parseQueued(body) as { error: string };
    expect(r.error).toContain('Prompt outputs failed validation');
    expect(r.error).toContain("ckpt_name: 'x.safetensors' not in []");
    expect(parseQueued('<html>') as { error: string }).toHaveProperty('error');
  });
  it('says an old ComfyUI needs updating when a step is unknown', () => {
    const body = JSON.stringify({ error: { type: 'missing_node_type', message: "Node 'Wan22ImageToVideoLatent' not found." }, node_errors: {} });
    expect((parseQueued(body) as { error: string }).error).toMatch(/Update ComfyUI/);
  });
  it('reads a job that is waiting, done and failed', () => {
    expect(parseHistory('{}', 'a')).toEqual({ state: 'waiting' });
    const done = JSON.stringify({ a: { outputs: { '7': { images: [{ filename: 'ezCLI_00001_.png', subfolder: '', type: 'output' }, { filename: 'tmp.png', subfolder: '', type: 'temp' }] } }, status: { status_str: 'success', completed: true, messages: [] } } });
    expect(parseHistory(done, 'a')).toEqual({ state: 'done', files: [{ filename: 'ezCLI_00001_.png', subfolder: '' }] });
    const oom = JSON.stringify({ a: { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: 'CUDA out of memory. Tried to allocate 2 GiB' }]] } } });
    expect((parseHistory(oom, 'a') as { why: string }).why).toMatch(/ran out of memory/);
  });
  it('counts the queue', () => {
    expect(queueDepth('{"queue_running":[[1]],"queue_pending":[[2],[3]]}')).toBe(3);
    expect(queueDepth(null)).toBe(0);
  });
});

describe('what the panel says before it can make anything', () => {
  it('covers not running, no model, and ready', () => {
    expect(readiness(false, none, 'image')).toMatchObject({ ready: false, needed: [] });
    expect(readiness(true, none, 'image').needed[0].folder).toBe('checkpoints');
    expect(readiness(true, { ...none, checkpoints: ['a.safetensors'] }, 'image').ready).toBe(true);
    expect(readiness(true, none, 'video').needed).toHaveLength(3);
    expect(readiness(true, wan, 'video').ready).toBe(true);
  });
});
