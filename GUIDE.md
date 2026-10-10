# ezCLI guide

How to run ezCLI and use every part of it.

## Contents

- [Start the server](#start-the-server)
- [The window](#the-window)
- [Start a session](#start-a-session)
- [Work in a session](#work-in-a-session)
- [Files pane](#files-pane)
- [Changes pane](#changes-pane)
- [Switch the working folder](#switch-the-working-folder)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Add or change an agent](#add-or-change-an-agent)
- [Troubleshooting](#troubleshooting)

## Start the server

```bash
cd ezCLI
npm install
npm start
```

The terminal prints the address and which CLIs it found:

```
  ezCLI  →  http://127.0.0.1:3000

  ✓  Claude Code  C:\Users\you\AppData\Roaming\npm\claude.CMD
  ✓  Codex        C:\Users\you\AppData\Roaming\npm\codex.CMD
  ✗  ChatGPT      chatgpt not on PATH
```

A check mark means the CLI is ready. A cross means ezCLI could not find it on PATH, so its
card stays disabled until you install it or point `agents.json` at the right executable.

Open the printed address in a browser. The server binds to `127.0.0.1`, so only your own
machine can reach it.

## The window

Three columns, left to right:

1. **Icon rail.** Launcher, sessions, settings, and a keyboard-shortcut sheet.
2. **Sidebar.** The agent switcher, a list of open sessions, and the working-folder picker.
   Hide it with the button at the top left or `Ctrl+Alt+B`.
3. **Main area.** The launcher before any session exists, then the session itself, with a
   status bar along the bottom.

The row of window tabs across the top is one tab per session. The dot on each tab is green
while the process runs and red once it exits.

## Start a session

1. Pick an agent, from the cards on the launcher or the sidebar list.
2. Optionally set the model and mode with the chips at the top left. They stay fixed once
   the session starts, so set them first.
3. Optionally type a first message in the composer. ezCLI sends it once the CLI is ready.
4. Press the up-arrow button, click "Start a session", or press `Enter` in the composer.

A new pseudo-terminal opens and the real CLI boots inside it, exactly as it would in your
own shell.

## Work in a session

The **Terminal** pane is the live CLI. Click into it and type, and every keystroke reaches
the process. Arrow keys, `Tab`, `Ctrl+C`, and the agent's own slash commands all work.

The **composer** below the terminal is a convenience for longer input. Type a block of
text, press `Enter`, and ezCLI sends it followed by a return. `Shift+Enter` adds a line
without sending. Two buttons sit beside it:

- **Ctrl+C** interrupts the running process.
- **Esc** sends a single Escape, which many text UIs use to dismiss a prompt.

The actions at the top right act on the current session:

- **Stop** ends the process but keeps the tab, so you can read the final output.
- **Restart** ends it and launches the same agent again with the same model and mode.
- **Clear** wipes the terminal scrollback. It does not touch the process.

## Files pane

The **Files** tab browses the session's working folder. Click a folder to go in, or `..`
to go up. Click a file to preview it on the right. Preview covers text files up to 256 KB.
Binary files and larger files report their type or size instead of dumping bytes.

## Changes pane

The **Changes** tab reads `git` in the session folder. It shows the current branch, every
file in the working tree that differs from the last commit, and a colored diff when you
pick a file. New untracked files show as an all-added diff.

If the folder is not a git repository, or `git` is not installed, the pane says so instead
of failing silently.

## Switch the working folder

New sessions start in the folder shown at the bottom of the sidebar, which defaults to
where you ran `npm start`. To change it, click that row, or the folder chip on the
launcher, and enter a path. Existing sessions keep the folder they started in.

## Keyboard shortcuts

ezCLI claims only `Ctrl+Alt` combinations, so nothing it does steals a shortcut from the
CLI running inside the terminal.

| Keys | Action |
| --- | --- |
| `Ctrl+Alt+N` | New session with the selected agent |
| `Ctrl+Alt+W` | Close the current session |
| `Ctrl+Alt+B` | Show or hide the sidebar |
| `Ctrl+Alt+K` | Clear the terminal |
| `Ctrl+Alt+1` … `9` | Jump to the first through ninth session |
| `Enter` | Send the composer to the CLI |
| `Shift+Enter` | Add a new line in the composer |

Open the same list any time from the question-mark button at the bottom of the icon rail.

## Add or change an agent

Every launchable CLI lives in `agents.json`. An entry looks like this:

```json
{
  "id": "codex",
  "label": "Codex",
  "vendor": "openai",
  "icon": "code",
  "command": "codex",
  "args": ["--no-daemon"],
  "modes": [
    { "id": "default", "label": "Default", "args": [] },
    { "id": "auto", "label": "Full auto", "args": ["--full-auto"] }
  ],
  "models": [
    { "id": "gpt-5-codex", "label": "gpt-5-codex", "args": ["-m", "gpt-5-codex"] }
  ]
}
```

- `command` is resolved on PATH. On Windows ezCLI also tries the `PATHEXT` extensions, so a
  `.cmd` or `.ps1` shim is found the same as an `.exe`.
- `args` always apply. The selected `mode` and `model` append their own `args` after them.
- `icon` is `code`, `chat`, or `term`.

After editing, open the gear menu on the icon rail and choose "Reload agents.json". The
server re-reads the file and rechecks PATH. No restart needed.

## Troubleshooting

**An agent card is disabled.** The `command` is not on PATH. Install the CLI, or set
`command` to its full path, then reload agents.

**Codex exits immediately with a daemon error.** Codex tried to detach a background
server and the host blocked it. Keep `--no-daemon` in the Codex entry's `args`, which is
the default here.

**Port 3000 is in use.** Start on another port with `PORT=4000 npm start`.

**The Changes pane says git is not installed.** Install git and make sure it is on PATH.

**Colors or layout look wrong.** The vendored xterm assets are served from `node_modules`.
Run `npm install` so they exist.
