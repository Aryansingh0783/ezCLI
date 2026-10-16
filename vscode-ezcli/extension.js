'use strict';
/* ezCLI for VS Code.
 *
 * Starts your coding CLIs in VS Code terminals with the agents, models and
 * modes from ~/.ezcli/agents.json, and hands a folder to the ezCLI desktop
 * app. Like the app, it never calls a model itself: each terminal runs the
 * real CLI, which uses your own account. */

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const A = require('./agents');

function folder(uri) {
  if (uri && uri.fsPath) return uri.fsPath;
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length ? ws[0].uri.fsPath : os.homedir();
}

function agentsOrExplain() {
  try {
    const list = A.loadAgents();
    if (list.length) return list;
  } catch {
    /* fall through */
  }
  vscode.window.showWarningMessage(
    'ezCLI has no agent list yet. Install the ezCLI desktop app and open it once, which writes ~/.ezcli/agents.json.',
    'Get ezCLI'
  ).then((pick) => pick && vscode.env.openExternal(vscode.Uri.parse('https://github.com/Aryansingh0783/ezCLI/releases/latest')));
  return null;
}

async function pickAgent(agents, placeHolder) {
  const items = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'ezCLI: finding installed CLIs' },
    async () =>
      agents.map((a) => {
        const path = A.resolve(a.command);
        return {
          label: a.label || a.id,
          description: path ? (a.tier === 'free' ? 'Free' : '') : 'not installed',
          detail: path ? path : a.install ? `Install with: ${a.install}` : `"${a.command}" is not on PATH`,
          agent: a,
          installed: Boolean(path)
        };
      })
  );
  items.sort((x, y) => Number(y.installed) - Number(x.installed));
  return vscode.window.showQuickPick(items, { placeHolder, matchOnDetail: true });
}

async function pickModel(agent) {
  const statics = (agent.models || []).filter((m) => !(agent.modelsFrom && agent.modelsFrom.requireSelection && m.id === 'default' && !(m.args || []).length));
  const live = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `ezCLI: reading ${agent.label}'s models` },
    async () => A.catalog(agent)
  );
  const items = [
    ...statics.map((m) => ({ label: m.label, id: m.id })),
    ...live.map((id) => ({ label: id.includes('/') ? id.slice(id.indexOf('/') + 1) : id, description: id.includes('/') ? id.slice(0, id.indexOf('/')) : '', id }))
  ];
  if (items.length <= 1) return items[0] ? items[0].id : 'default';
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `${agent.label}: choose a model` });
  return pick ? pick.id : undefined;
}

function startTerminal(agent, modelId, cwd, viewColumn) {
  const shell = process.platform === 'win32' ? 'powershell' : 'posix';
  const name = modelId && modelId !== 'default' ? `${agent.label} · ${modelId}` : agent.label;
  const term = vscode.window.createTerminal({
    name,
    cwd,
    location: viewColumn ? { viewColumn } : vscode.TerminalLocation.Panel,
    shellPath: process.platform === 'win32' ? 'powershell.exe' : undefined,
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' }
  });
  term.show(false);
  term.sendText(A.commandLine(agent, { modelId, modeId: 'default', effortId: 'default' }, shell), true);
  return term;
}

async function startAgent(uri) {
  const agents = agentsOrExplain();
  if (!agents) return;
  const pick = await pickAgent(agents, 'Start which agent?');
  if (!pick) return;
  if (!pick.installed) {
    const action = pick.agent.install ? 'Copy install command' : undefined;
    const r = await vscode.window.showWarningMessage(`${pick.label} is not installed. A desktop app is not the CLI.`, ...(action ? [action] : []));
    if (r === action) vscode.env.clipboard.writeText(pick.agent.install);
    return;
  }
  const model = await pickModel(pick.agent);
  if (model === undefined) return;
  startTerminal(pick.agent, model, folder(uri));
}

/** Pick several agents, then open each in its own editor-area terminal, side by side. */
async function compare(uri) {
  const agents = agentsOrExplain();
  if (!agents) return;
  const items = agents
    .map((a) => ({ label: a.label || a.id, agent: a, installed: Boolean(A.resolve(a.command)) }))
    .filter((i) => i.installed && !(i.agent.modelsFrom && i.agent.modelsFrom.requireSelection));
  const picks = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Pick two to four agents to run side by side' });
  if (!picks || picks.length < 2) return;
  const cwd = folder(uri);
  picks.slice(0, 4).forEach((p, i) => startTerminal(p.agent, 'default', cwd, vscode.ViewColumn.One + i));
}

function appPath() {
  const configured = vscode.workspace.getConfiguration('ezcli').get('appPath');
  const candidates = [
    configured,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ezCLI', 'ezcli.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ezCLI', 'ezcli.exe'),
    '/Applications/ezCLI.app/Contents/MacOS/ezcli',
    '/usr/bin/ezcli'
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

function openInApp(uri) {
  const exe = appPath();
  if (!exe) {
    vscode.window.showWarningMessage('ezCLI is not installed where this extension looks. Set "ezcli.appPath" in Settings, or install the app.', 'Get ezCLI')
      .then((r) => r && vscode.env.openExternal(vscode.Uri.parse('https://github.com/Aryansingh0783/ezCLI/releases/latest')));
    return;
  }
  // A running ezCLI receives the folder through its single-instance hand-off.
  spawn(exe, [folder(uri)], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('ezcli.startAgent', startAgent),
    vscode.commands.registerCommand('ezcli.compare', compare),
    vscode.commands.registerCommand('ezcli.openInApp', openInApp),
    vscode.commands.registerCommand('ezcli.openConfig', async () => {
      if (!fs.existsSync(A.CONFIG)) return agentsOrExplain();
      vscode.window.showTextDocument(await vscode.workspace.openTextDocument(A.CONFIG));
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
