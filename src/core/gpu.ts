/* Speed and GPU memory for local models: the numbers that explain a slow reply.
 *
 * A model that does not fit in the graphics card's free memory still loads. Part of it goes to system
 * memory and every token then crosses that boundary, which is several times slower. Nothing in the
 * conversation shows it, so the app reads the two facts that do: what llama.cpp says its speed was,
 * and how much of the card's memory is in use. */

export interface GpuMemory {
  usedMib: number;
  totalMib: number;
}

const MIB = 1024 * 1024;
/** Memory a model needs beyond its file: the context cache and working buffers. */
export const WORKING_ROOM_MIB = 1024;

/** llama.cpp prints "[ Prompt: 464.2 t/s | Generation: 18.8 t/s ]" after each reply. */
export function parseSpeed(text: string): { prompt: number; generation: number } | null {
  let last: RegExpExecArray | null = null;
  const re = /\[\s*Prompt:\s*([\d.]+)\s*t\/s\s*\|\s*Generation:\s*([\d.]+)\s*t\/s\s*\]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) return null;
  const prompt = Number(last[1]);
  const generation = Number(last[2]);
  return Number.isFinite(prompt) && Number.isFinite(generation) ? { prompt, generation } : null;
}

const gb = (mib: number) => (mib / 1024).toFixed(1);

/** GPU memory a model file needs to run entirely on the card. */
export function neededMib(fileBytes: number): number {
  return Math.round((fileBytes / MIB) * 1.05) + WORKING_ROOM_MIB;
}

/** Before a model loads: will it fit in what is free right now? Null when it will, or when unknown. */
export function preflight(mem: GpuMemory | null, fileBytes: number): string | null {
  if (!mem || !mem.totalMib || !fileBytes) return null;
  const need = neededMib(fileBytes);
  const free = Math.max(0, mem.totalMib - mem.usedMib);
  if (need <= free) return null;
  if (need > mem.totalMib) {
    return `This model needs about ${gb(need)} GB of GPU memory and the card has ${gb(mem.totalMib)} GB. Part of it will run from system memory, which is several times slower. A smaller file of the same model (Q4_K_M) will be much faster.`;
  }
  return `This model needs about ${gb(need)} GB of GPU memory and ${gb(free)} GB is free: other programs are using ${gb(mem.usedMib)} GB. It will run several times slower than it can. Close programs that use the GPU (browsers, Discord, games) and restart this session, or use a smaller file of the same model (Q4_K_M).`;
}

/** The status bar's memory item, and whether the card is full. */
export function memoryStatus(mem: GpuMemory | null): { text: string; full: boolean } | null {
  if (!mem || !mem.totalMib) return null;
  const full = mem.usedMib / mem.totalMib >= 0.97;
  return { text: `${full ? 'GPU memory full' : 'GPU memory'}: ${gb(mem.usedMib)} of ${gb(mem.totalMib)} GB`, full };
}
