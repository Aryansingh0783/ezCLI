'use strict';
/* Agent config and launch lines, shared with the ezCLI desktop app.
 *
 * Reads ~/.ezcli/agents.json (the app writes it on first run) and builds the
 * same command lines the app uses: base args, then mode args, then either
 * the static model's args or `<flag|launch...> <catalog model id>`, then
 * effort args. Kept free of the vscode module so it can be unit-tested. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CONFIG = path.join(os.homedir(), '.ezcli', 'agents.json');

function loadAgents(file = CONFIG) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (json.agents || []).filter((a) => a && a.id && a.command);
}

/** Resolve a command on PATH the way a terminal would. */
function resolve(command) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

/** A catalog model id must look like a plain id, never like a flag. */
const SAFE_MODEL = /^[A-Za-z0-9][\w.:/@-]{0,199}$/;

/** Read an agent's live model list, if it declares one. */
function catalog(agent) {
  const from = agent.modelsFrom;
  if (!from || from.catalog === 'ollama-cloud') return [];
  try {
    const out = execFileSync(agent.command, from.args || [], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, NO_COLOR: '1' }
    });
    return parseCatalog(from.catalog, out);
  } catch {
    return [];
  }
}

function parseCatalog(kind, out) {
  if (kind === 'codex') {
    try {
      return (JSON.parse(out).models || [])
        .filter((m) => !m.visibility || m.visibility === 'list')
        .map((m) => m.slug)
        .filter((s) => SAFE_MODEL.test(s));
    } catch {
      return [];
    }
  }
  if (kind === 'ollama') {
    return out
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length > 1 && /^[0-9a-f]{7,}$/i.test(c[1]) && !/[:-]cloud$/i.test(c[0]))
      .map((c) => c[0])
      .filter((s) => SAFE_MODEL.test(s));
  }
  if (kind === 'opencode-free') {
    // `opencode models --verbose` output: "ID  PROVIDER  CONTEXT  ..." table; keep free models only.
    return out
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((id) => id && /-free$/i.test(id) && SAFE_MODEL.test(id));
  }
  // Generic: first token of each line, must look like provider/model.
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((l) => l && /^[A-Za-z0-9][\w.-]*\/[\w.:/@-]+$/.test(l));
}

const variant = (list, id) => (list || []).find((v) => v.id === id);

/** The argument list for one launch, in the same order as the app's
 *  build_argv: base args, effort, model, mode. */
function buildArgs(agent, { modeId, modelId, effortId } = {}) {
  const mode = variant(agent.modes, modeId);
  const model = variant(agent.models, modelId);
  const effort = variant(agent.efforts, effortId);
  const from = agent.modelsFrom;
  const launch = from ? (from.launch && from.launch.length ? from.launch : from.flag ? [from.flag] : null) : null;
  const modelArgs = model
    ? model.args || []
    : modelId && SAFE_MODEL.test(modelId) && launch
      ? [...launch, modelId]
      : [];
  return [...(agent.args || []), ...(effort ? effort.args || [] : []), ...modelArgs, ...(mode ? mode.args || [] : [])];
}

/** Quote one argument for the terminal's shell. */
function quote(arg, shell = process.platform === 'win32' ? 'powershell' : 'posix') {
  const s = String(arg);
  if (/^[\w./:@=-]+$/.test(s)) return s;
  if (shell === 'powershell') return `'${s.replace(/'/g, "''")}'`;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function commandLine(agent, opts, shell) {
  const cmd = shell === 'powershell' ? `& ${quote(agent.command, shell)}` : quote(agent.command, shell);
  return [cmd, ...buildArgs(agent, opts).map((a) => quote(a, shell))].join(' ');
}

module.exports = { CONFIG, loadAgents, resolve, catalog, parseCatalog, buildArgs, commandLine, quote };
