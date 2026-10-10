# ezCLI

A desktop-style window for the Claude and OpenAI coding CLIs, with a UI modeled on
Freebuff.

ezCLI is not a harness. Each session spawns the real CLI in a real pseudo-terminal, so
the agent's own text UI renders unchanged. Nothing is proxied, re-prompted, or rewritten.
The window adds the parts a bare terminal lacks: tabs, an agent switcher, a file and diff
browser, and model and mode flags you pick before launch.

![ezCLI launcher](docs/screenshot-launcher.jpg)

## Run it

```bash
cd ezCLI
npm install
npm start
```

Then open http://127.0.0.1:3000.

To use a different port:

```bash
PORT=4000 npm start
```

## What it does

| Area | Behaviour |
| --- | --- |
| Session tabs | One pseudo-terminal per tab. A colored dot shows running, exited, or failed. |
| Agent switcher | Claude Code, Claude, Codex and ChatGPT. A CLI that is not on PATH shows as disabled instead of failing on launch. |
| Model and mode chips | Map to real CLI flags from `agents.json`. You set them before launch; a running session locks them until you restart. |
| Terminal | xterm.js with the Freebuff dark palette and JetBrains Mono. Full color, cursor, and live resize. |
| Files pane | Browse the session folder and preview any text file, up to 256 KB. |
| Changes pane | Branch, working-tree status, and a colored diff for each changed file, straight from `git`. |
| Composer | A text box that writes to the process, with `Ctrl+C` and `Esc` buttons for the agent's own prompts. |
| Status bar | State, the resolved command line, the working directory, and the terminal size. |

Full operating instructions are in [GUIDE.md](GUIDE.md).

## Keyboard

The window claims only `Ctrl+Alt` combinations, so the agent's own terminal shortcuts
(`Ctrl+C`, `Ctrl+W`, `Ctrl+R`, and the rest) always reach the CLI.

| Keys | Action |
| --- | --- |
| `Ctrl+Alt+N` | New session |
| `Ctrl+Alt+W` | Close session |
| `Ctrl+Alt+B` | Show or hide the sidebar |
| `Ctrl+Alt+K` | Clear the terminal |
| `Ctrl+Alt+1` … `9` | Jump to a session |
| `Enter` | Send the composer |
| `Shift+Enter` | New line in the composer |

## Configuring agents

`agents.json` lists every launchable CLI. Each entry gives a `command` resolved on PATH,
plus `modes` and `models` whose `args` are appended to the launch line. Edit the file,
then choose "Reload agents.json" from the gear menu. No restart needed.

```json
{
  "id": "claude-code",
  "label": "Claude Code",
  "command": "claude",
  "modes": [
    { "id": "plan", "label": "Plan", "args": ["--permission-mode", "plan"] }
  ],
  "models": [
    { "id": "opus", "label": "Opus", "args": ["--model", "opus"] }
  ]
}
```

Detected on a typical setup:

- Claude Code, from `claude`
- Claude, from `claude`
- Codex, from `codex --no-daemon`
- ChatGPT, disabled until a `chatgpt` binary is on PATH

### Why Codex passes `--no-daemon`

Codex normally detaches a background server. When ezCLI runs inside a Windows job object
that forbids breakaway, that detach fails and Codex exits at once. The flag keeps Codex in
the foreground. Remove it from `agents.json` if your setup does not need it.

## How it works

```
server.js     express + ws. PATH resolution, PTY spawn, resize, file and git endpoints.
agents.json   agent, model, and mode definitions.
public/
  index.html  window markup
  styles.css  Freebuff design tokens and components
  app.js      session manager, xterm wiring, file and diff panes, menus, shortcuts
```

The browser opens one WebSocket per session to `/pty`. The server resolves the command on
PATH (walking `PATHEXT` on Windows, where an npm CLI is usually a `.cmd` shim), spawns it
with `@lydell/node-pty`, and streams bytes both ways. Launch arguments come only from
`agents.json`, never from the page, and the WebSocket upgrade is refused unless the request
originates from loopback on the server's own port.

## Requirements

- Node.js 18 or newer
- `git` on PATH, for the Changes pane
- At least one of the agent CLIs installed

## Design source

Colors, radii, type scale, and spacing come from the live Freebuff dark shell and sit as
tokens at the top of `public/styles.css`: background `#000`, sidebar `#1c1d1c`, border
`#2f322f`, text `#dedfdd`, brand `#b5cea5`. The frontend passes the Impeccable design
detector with no findings.

## License

MIT. See [LICENSE](LICENSE).
