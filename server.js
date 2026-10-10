'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');

const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('@lydell/node-pty');

const execFileAsync = promisify(execFile);

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const isWindows = process.platform === 'win32';

const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_DIR_ENTRIES = 2000;
const MAX_SESSIONS = 24;

/* ------------------------------------------------------------ agent config */

function loadAgents() {
  const file = path.join(ROOT, 'agents.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`agents.json could not be read: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.agents)) {
    throw new Error('agents.json must contain an "agents" array.');
  }

  const seen = new Set();
  return parsed.agents.map((raw, i) => {
    const where = `agents[${i}]`;
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) {
      throw new Error(`${where} needs a non-empty string "id".`);
    }
    if (seen.has(raw.id)) throw new Error(`Duplicate agent id "${raw.id}".`);
    seen.add(raw.id);
    if (typeof raw.command !== 'string' || !raw.command.trim()) {
      throw new Error(`${where} ("${raw.id}") needs a non-empty string "command".`);
    }

    const variants = (list, fallbackLabel) => {
      const arr = Array.isArray(list) && list.length ? list : [{ id: 'default', label: fallbackLabel, args: [] }];
      return arr.map((v, j) => ({
        id: String((v && v.id) || `v${j}`),
        label: String((v && v.label) || (v && v.id) || `Option ${j + 1}`),
        args: Array.isArray(v && v.args) ? v.args.map(String) : []
      }));
    };

    return {
      id: raw.id,
      label: String(raw.label || raw.id),
      vendor: String(raw.vendor || ''),
      icon: String(raw.icon || 'term'),
      command: raw.command,
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      modes: variants(raw.modes, 'Default'),
      models: variants(raw.models, 'Default')
    };
  });
}

let agents = [];
let agentById = new Map();

try {
  agents = loadAgents();
  agentById = new Map(agents.map((a) => [a.id, a]));
} catch (err) {
  console.error(`\nezCLI could not start.\n  ${err.message}\n`);
  process.exit(1);
}

/* --------------------------------------------------------- PATH resolution */

// An npm-installed CLI on Windows is usually a .cmd shim, not an .exe, so the
// lookup has to walk PATHEXT rather than test the bare name.
const resolveCache = new Map();

function resolveCommand(cmd) {
  if (resolveCache.has(cmd)) return resolveCache.get(cmd);

  let found = null;
  if (cmd.includes(path.sep) || cmd.includes('/')) {
    found = isFile(cmd) ? cmd : null;
  } else {
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const exts = isWindows
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
    outer: for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, cmd + ext);
        if (isFile(candidate)) {
          found = candidate;
          break outer;
        }
      }
    }
  }

  resolveCache.set(cmd, found);
  return found;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------- express */

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/vendor/xterm', express.static(path.join(ROOT, 'node_modules/@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(ROOT, 'node_modules/@xterm/addon-fit')));
app.use('/vendor/addon-web-links', express.static(path.join(ROOT, 'node_modules/@xterm/addon-web-links')));

function describeAgents() {
  return agents.map((a) => {
    const resolved = resolveCommand(a.command);
    return { ...a, available: Boolean(resolved), resolved };
  });
}

app.get('/api/agents', (req, res) => {
  res.json({
    cwd: process.cwd(),
    home: os.homedir(),
    platform: process.platform,
    sep: path.sep,
    agents: describeAgents()
  });
});

app.post('/api/agents/reload', (req, res) => {
  try {
    const next = loadAgents();
    agents = next;
    agentById = new Map(agents.map((a) => [a.id, a]));
    resolveCache.clear();
    res.json({ ok: true, agents: describeAgents() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/files', (req, res) => {
  const dir = path.resolve(req.query.path || process.cwd());
  if (!isDir(dir)) return res.status(400).json({ error: `Not a directory: ${dir}` });

  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const entries = dirents.slice(0, MAX_DIR_ENTRIES).map((e) => {
    const full = path.join(dir, e.name);
    let size = null;
    if (e.isFile()) {
      try {
        size = fs.statSync(full).size;
      } catch {
        size = null;
      }
    }
    return { name: e.name, path: full, dir: e.isDirectory(), size };
  });

  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));

  const parent = path.dirname(dir);
  res.json({
    path: dir,
    parent: parent === dir ? null : parent,
    truncated: dirents.length > MAX_DIR_ENTRIES,
    entries
  });
});

app.get('/api/file', (req, res) => {
  const file = path.resolve(req.query.path || '');
  if (!isFile(file)) return res.status(400).json({ error: 'Not a file' });

  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(Math.min(stat.size, MAX_PREVIEW_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (buf.subarray(0, 8192).includes(0)) {
    return res.json({ path: file, size: stat.size, binary: true, text: '' });
  }

  res.json({
    path: file,
    size: stat.size,
    binary: false,
    truncated: stat.size > MAX_PREVIEW_BYTES,
    text: buf.toString('utf8')
  });
});

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

function gitReason(err) {
  const text = String((err && err.stderr) || (err && err.message) || err).trim();
  if (/ENOENT/.test(text)) return 'git is not installed or not on PATH.';
  if (/not a git repository/i.test(text)) return 'This folder is not a git repository.';
  return text.split('\n')[0];
}

app.get('/api/git', async (req, res) => {
  const cwd = path.resolve(req.query.path || process.cwd());
  if (!isDir(cwd)) return res.status(400).json({ error: 'Not a directory' });

  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    let branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (branch === 'HEAD') branch = 'detached HEAD';

    const porcelain = await git(cwd, ['status', '--porcelain=v1', '-uall']);
    const files = porcelain
      .split('\n')
      .filter((line) => line.length > 3)
      .map((line) => {
        const code = line.slice(0, 2);
        let name = line.slice(3);
        // Renames arrive as "old -> new"; keep the destination.
        const arrow = name.indexOf(' -> ');
        if (arrow !== -1) name = name.slice(arrow + 4);
        if (name.startsWith('"') && name.endsWith('"')) {
          try {
            name = JSON.parse(name);
          } catch {
            name = name.slice(1, -1);
          }
        }
        return { code, file: name, untracked: code === '??' };
      });

    res.json({ repo: true, root, branch, files });
  } catch (err) {
    res.json({ repo: false, reason: gitReason(err) });
  }
});

app.get('/api/diff', async (req, res) => {
  const cwd = path.resolve(req.query.path || process.cwd());
  const file = String(req.query.file || '');
  if (!isDir(cwd)) return res.status(400).json({ error: 'Not a directory' });
  if (!file) return res.status(400).json({ error: 'No file given' });

  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    const abs = path.resolve(root, file);

    if (String(req.query.untracked) === '1') {
      if (!isFile(abs)) return res.json({ diff: '', note: 'File no longer exists.' });
      const stat = fs.statSync(abs);
      if (stat.size > MAX_PREVIEW_BYTES) {
        return res.json({ diff: '', note: 'New file is too large to preview.' });
      }
      const body = fs.readFileSync(abs);
      if (body.subarray(0, 8192).includes(0)) {
        return res.json({ diff: '', note: 'New binary file.' });
      }
      const added = body
        .toString('utf8')
        .split('\n')
        .map((l) => `+${l}`)
        .join('\n');
      return res.json({ diff: `--- /dev/null\n+++ b/${file}\n${added}` });
    }

    let out = await git(cwd, ['diff', '--', file]);
    if (!out.trim()) out = await git(cwd, ['diff', '--cached', '--', file]);
    res.json({ diff: out, note: out.trim() ? null : 'No textual changes to show.' });
  } catch (err) {
    res.status(400).json({ error: gitReason(err) });
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message });
});

/* -------------------------------------------------------------- websocket */

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// The server listens on loopback, but any page in the user's browser can still
// reach loopback. Without an Origin check, a hostile site could open this
// socket and spawn an agent CLI with arbitrary arguments in any directory.
function originAllowed(origin) {
  if (!origin) return true; // non-browser client (curl, tests)
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  return localHosts.has(url.hostname) && (!url.port || url.port === String(PORT));
}

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (pathname !== '/pty') {
    socket.destroy();
    return;
  }
  if (!originAllowed(req.headers.origin)) {
    console.warn(`refused websocket from origin ${req.headers.origin}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

let liveSessions = 0;

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
}

wss.on('connection', (ws) => {
  let term = null;
  let counted = false;

  const dispose = () => {
    if (term) {
      try {
        term.kill();
      } catch {
        /* already gone */
      }
      term = null;
    }
    if (counted) {
      liveSessions--;
      counted = false;
    }
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'start') {
      if (term) return;

      if (liveSessions >= MAX_SESSIONS) {
        send(ws, 'fatal', { message: `Session limit reached (${MAX_SESSIONS}). Close a tab and try again.` });
        return;
      }

      const agent = agentById.get(msg.agentId);
      if (!agent) {
        send(ws, 'fatal', { message: `Unknown agent: ${msg.agentId}` });
        return;
      }

      const file = resolveCommand(agent.command);
      if (!file) {
        send(ws, 'fatal', {
          message:
            `"${agent.command}" was not found on your PATH.\n\n` +
            `Install it, or point agents.json at the right executable, then reload agents from the gear menu.`
        });
        return;
      }

      const mode = agent.modes.find((m) => m.id === msg.modeId);
      const model = agent.models.find((m) => m.id === msg.modelId);
      // Arguments come only from agents.json, never from the client, so a page
      // cannot talk this server into running an arbitrary command line.
      const args = [...agent.args, ...(mode ? mode.args : []), ...(model ? model.args : [])];

      const requested = typeof msg.cwd === 'string' ? path.resolve(msg.cwd) : '';
      const cwd = isDir(requested) ? requested : process.cwd();

      // A .ps1 shim cannot be exec'd directly; hand it to PowerShell.
      let spawnFile = file;
      let spawnArgs = args;
      if (isWindows && /\.ps1$/i.test(file)) {
        spawnFile = 'powershell.exe';
        spawnArgs = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args];
      }

      const cols = clampDim(msg.cols, 120);
      const rows = clampDim(msg.rows, 30);

      try {
        term = pty.spawn(spawnFile, spawnArgs, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '3', COLORTERM: 'truecolor' },
          useConpty: isWindows
        });
      } catch (err) {
        send(ws, 'fatal', { message: `Failed to launch ${agent.command}: ${err.message}` });
        return;
      }

      counted = true;
      liveSessions++;

      send(ws, 'started', { pid: term.pid, cwd, command: [agent.command, ...args].join(' ') });

      term.onData((chunk) => send(ws, 'data', { data: chunk }));
      term.onExit(({ exitCode, signal }) => {
        send(ws, 'exit', { exitCode, signal });
        dispose();
      });
      return;
    }

    if (!term) return;

    if (msg.type === 'input' && typeof msg.data === 'string') {
      term.write(msg.data);
    } else if (msg.type === 'resize') {
      try {
        term.resize(clampDim(msg.cols, 80), clampDim(msg.rows, 24));
      } catch {
        /* the pty can disappear between the resize and the write */
      }
    } else if (msg.type === 'kill') {
      dispose();
    }
  });

  ws.on('close', dispose);
  ws.on('error', dispose);
});

function clampDim(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1000, Math.max(2, Math.floor(n)));
}

/* ------------------------------------------------------------------ listen */

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${PORT} is already in use.\n` +
        `  Close the other process, or start ezCLI on a different port:\n` +
        `    PORT=4000 npm start\n`
    );
  } else {
    console.error(`\nezCLI failed to start: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ezCLI  →  http://${HOST}:${PORT}\n`);
  for (const a of agents) {
    const resolved = resolveCommand(a.command);
    console.log(`  ${resolved ? '✓' : '✗'}  ${a.label.padEnd(12)} ${resolved || `${a.command} not on PATH`}`);
  }
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const client of wss.clients) client.terminate();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
