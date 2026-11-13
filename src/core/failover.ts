/* What to switch to when an agent says it has run out of usage.
 *
 * The switch is automatic, so it only ever goes to something that costs nothing: another free model
 * of the same agent first (the conversation can usually be resumed there), then another free agent.
 * A paid model or a paid agent is never chosen without the user; those stay a button in the banner.
 * A chain of switches is capped, so a service that reports a limit on every model cannot loop. */

export interface FailoverModel {
  id: string;
  free: boolean;
}
export interface FailoverAgent {
  id: string;
  free: boolean;
  available: boolean;
  /** Same CLI and vendor as the limited agent: the same account, so the same limit. */
  sameService: boolean;
  /** Needs a model chosen before it can start, and none is saved. */
  needsModel: boolean;
}
export interface FailoverInput {
  agentId: string;
  modelId: string;
  /** The agent's models in the order it lists them, best first. */
  models: readonly FailoverModel[];
  agents: readonly FailoverAgent[];
  /** What this conversation has already been moved off: "agent" and "agent|model" keys. */
  tried: readonly string[];
  /** The CLI can reopen its own conversation after a restart. */
  canResume: boolean;
}
export type FailoverPlan =
  | { kind: 'model'; modelId: string; resume: boolean }
  | { kind: 'agent'; agentId: string }
  | { kind: 'none'; why: 'limit' | 'nothing-free' };

/** Switches allowed in one conversation before the app stops and asks. */
export const MAX_SWITCHES = 4;

export const modelKey = (agentId: string, modelId: string) => `${agentId}|${modelId}`;

export function failoverPlan(i: FailoverInput): FailoverPlan {
  const tried = new Set(i.tried);
  if (i.tried.length >= MAX_SWITCHES) return { kind: 'none', why: 'limit' };
  const model = i.models.find((m) => m.free && m.id !== i.modelId && !tried.has(modelKey(i.agentId, m.id)));
  if (model) return { kind: 'model', modelId: model.id, resume: i.canResume };
  const other = i.agents.find((a) => a.id !== i.agentId && a.available && a.free && !a.sameService && !a.needsModel && !tried.has(a.id));
  if (other) return { kind: 'agent', agentId: other.id };
  return { kind: 'none', why: 'nothing-free' };
}

export interface Turn {
  text: string;
  reply?: string | null;
}

/** The conversation so far, for an agent that was not part of it: the latest turns, newest kept whole. */
export function transcript(turns: readonly Turn[], budget = 6000): string {
  const out: string[] = [];
  let used = 0;
  for (let k = turns.length - 1; k >= 0 && used < budget; k--) {
    const t = turns[k];
    if (!t) continue;
    const ask = String(t.text || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
    const reply = String(t.reply || '').replace(/\s+\n/g, '\n').trim();
    if (!ask && !reply) continue;
    const room = Math.max(200, budget - used - ask.length);
    const block = `Me: ${ask}${reply ? `\nAssistant: ${reply.length > room ? reply.slice(0, room) + ' […]' : reply}` : ''}`;
    out.unshift(block);
    used += block.length;
  }
  return out.join('\n\n');
}

export function handoffText(from: string, turns: readonly Turn[]): string {
  const body = transcript(turns);
  return (
    `I was working with ${from} and it ran out of usage, so you are taking over the same conversation. ` +
    (body ? `This is what was said so far:\n\n${body}\n\n` : '') +
    'Continue from the last message: if it was a request that was not finished, finish it; check the current state of the files before changing them.'
  );
}
