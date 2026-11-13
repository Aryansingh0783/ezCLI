import { $, active, hooks, invoke, toast } from '../app';
import { late } from '../late';
import { memoryStatus, parseSpeed, preflight, type GpuMemory } from '../core/gpu';
/* Local models: show the reply speed and the GPU's memory in the status bar, and say before a model
 * loads when it will not fit in the memory that is free. See core/gpu.ts for why. */

const LOCAL = new Set(['gguf', 'ollama', 'lmstudio']);
const isLocal = (s) => Boolean(s && LOCAL.has(s.agentId));

let memory: GpuMemory | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

async function readMemory() {
  try {
    memory = (await invoke('gpu_memory')) as GpuMemory | null;
  } catch {
    memory = null;
  }
  render();
}

function render() {
  const s = active();
  const speed = $('stSpeed');
  const mem = $('stVram');
  if (!speed || !mem) return;
  const local = isLocal(s);
  speed.hidden = !(local && s.genSpeed);
  if (!speed.hidden) speed.textContent = `${Math.round(s.genSpeed * 10) / 10} tokens/s`;
  const m = local ? memoryStatus(memory) : null;
  mem.hidden = !m;
  if (m) {
    mem.textContent = m.text;
    mem.classList.toggle('warn', m.full);
    mem.title = m.full ? 'The graphics card has no memory left. A model that does not fit runs partly from system memory and is several times slower.' : 'Memory in use on the graphics card, by every program together.';
  }
}

/** Read memory while a local model is on screen and running; stop when it is not. */
function sync() {
  const s = active();
  const want = isLocal(s) && s.status === 'running' && !document.hidden;
  if (want && !timer) {
    readMemory();
    timer = setInterval(readMemory, 5000);
  } else if (!want && timer) {
    clearInterval(timer);
    timer = null;
  }
  render();
}

hooks.output.push((s, chunk) => {
  if (!isLocal(s)) return;
  // the speed line can arrive split over two chunks
  s.speedTail = ((s.speedTail || '') + String(chunk)).slice(-160);
  const sp = parseSpeed(s.speedTail);
  if (sp && sp.generation !== s.genSpeed) {
    s.genSpeed = sp.generation;
    if (s === active()) render();
  }
});

/** As a llama.cpp model starts: will it fit in the GPU memory that is free right now? */
hooks.launched.push(async (s) => {
  if (!s || s.agentId !== 'gguf' || s.modeId === 'cpu') return;
  const found = (late.Models && late.Models.pc && late.Models.pc.found) || [];
  const file = found.find((f) => f.path === s.modelId);
  if (!file) return;
  let mem: GpuMemory | null = null;
  try {
    mem = (await invoke('gpu_memory')) as GpuMemory | null;
  } catch {
    return;
  }
  const warning = preflight(mem, Number(file.bytes) || 0);
  if (!warning) return;
  s.term.write(`\r\n\x1b[38;2;226;169;63m${warning}\x1b[0m\r\n`);
  toast(`${s.title}: not enough free GPU memory, so it will be slow. Details are in the terminal.`, 'error');
});

hooks.boot.push(() => {
  document.addEventListener('visibilitychange', sync);
  sync();
});
hooks.view.push(sync);
hooks.tabs.push(sync);
hooks.exit.push(sync);
