# ezCLI guide

How to install ezCLI, launch sessions, and use every part of the window.

## Contents

- [Install](#install)
- [The window](#the-window)
- [Start a session](#start-a-session)
- [Work in a session](#work-in-a-session)
- [Files pane](#files-pane)
- [Changes pane](#changes-pane)
- [Switch the working folder](#switch-the-working-folder)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Add or change an agent](#add-or-change-an-agent)
- [Build from source](#build-from-source)
- [Troubleshooting](#troubleshooting)

## Install

Grab the latest `ezCLI_x.y.z_x64_en-US.msi` from the
[Releases page](https://github.com/Aryansingh0783/ezCLI/releases) and double-click.
Windows 11 ships with the WebView2 runtime the installer needs. On Windows 10 the
installer silently fetches it from Microsoft the first time it runs.

The app writes its editable config to `~/.ezcli/agents.json` on first launch, so
nothing lives inside Program Files.

## The window

Three columns, left to right:

1. **Icon rail.** Launcher, sessions, settings, and the keyboard-shortcut sheet.
2. **Sidebar.** Agent switcher, open-session list, and the working-folder picker.
   Hide it with the button at the top left or `Ctrl+Alt+B`.
3. **Main area.** The launcher before any session exists, then the session itself,
   with a status bar along the bottom.

The row of window tabs across the top shows one tab per session. The dot on each tab
is green while the process runs and red once it exits.

## Start a session

1. Pick an agent from the cards on the launcher or the sidebar list.
2. Optionally set the model and mode with the chips at the top left. They lock
   once the session starts, so set them first.
3. Optionally type a first message in the composer. ezCLI sends it as soon as the
   CLI is ready.
4. Press the up-arrow button, click "Start a session", or press `Enter` in the composer.

A new pseudo-terminal opens and the real CLI boots inside it, exactly as it would in
your own shell.

## Work in a session

The **Terminal** pane is the live CLI. Click into it and type, and every keystroke
reaches the process. Arrow keys, `Tab`, `Ctrl+C`, and the agent's own slash commands
all work.

The **composer** below the terminal is a convenience for longer input. Type a block
of text, press `Enter`, and ezCLI sends it followed by a return. `Shift+Enter` adds a
line without sending. Two buttons sit beside it:

- **Ctrl+C** interrupts the running process.
- **Esc** sends a single Escape, which many text UIs use to dismiss a prompt.

The actions at the top right act on the current session:

- **Stop** ends the process but keeps the tab, so you can read the final output.
- **Restart** ends it and launches the same agent again with the same model and mode.
- **Clear** wipes the terminal scrollback. It does not touch the process.

## Files pane

The **Files** tab browses the session's working folder. Click a folder to go in,
or `..` to go up. Click a file to preview it on the right. Preview covers text files
up to 256 KB. Binary files and larger files report their type or size instead of
dumping bytes.

## Changes pane

The **Changes** tab runs `git` in the session folder. It shows the current branch,
every file in the working tree that differs from the last commit, and a colored diff
when you pick a file. New untracked files show as an all-added diff.

If the folder is not a git repository, or `git` is not installed, the pane says so
instead of failing silently.

## Switch the working folder

New sessions start in the folder shown at the bottom of the sidebar, which defaults
to your home folder. To change it, click that row or the folder chip on the
launcher, and enter a path. Existing sessions keep the folder they started in.

## Keyboard shortcuts

ezCLI claims only `Ctrl+Alt` combinations, so nothing it does steals a shortcut from
the CLI running inside the terminal.

| Keys | Action |
| --- | --- |
| `Ctrl+Alt+N` | New session with the selected agent |
| `Ctrl+Alt+W` | Close the current session |
| `Ctrl+Alt+B` | Show or hide the sidebar |
| `Ctrl+Alt+K` | Clear the terminal |
| `Ctrl+Alt+1` … `9` | Jump to the first through ninth session |
| `Enter` | Send the composer to the CLI |
| `Shift+Enter` | Add a new line in the composer |

Open the same list any time from the question-mark button at the bottom of the icon
rail.

## Add or change an agent

Every launchable CLI lives in `~/.ezcli/agents.json`. An entry looks like this:

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

- `command` is resolved on PATH. On Windows ezCLI also walks `PATHEXT`, so a `.cmd` or
  `.ps1` shim resolves the same as an `.exe`.
- `args` always apply. The selected `mode` and `model` append their own `args` after.
- `icon` is `code`, `chat`, or `term`.

After editing, open the gear menu on the icon rail and choose "Reload agents.json".
The backend re-reads the file and rechecks PATH. No app restart.

## Build from source

Prerequisites: Rust (stable), the Tauri CLI, and WebView2 (shipped with Windows 11).
On Windows the GNU toolchain works without the full MSVC Build Tools:

```bash
rustup toolchain install stable-gnu
rustup default stable-gnu
rustup component add rust-mingw
```

Install the Tauri CLI once (either compiled or as a prebuilt binary from
[tauri releases](https://github.com/tauri-apps/tauri/releases)):

```bash
cargo install tauri-cli --version "^2.0"
```

Then clone and build:

```bash
git clone https://github.com/Aryansingh0783/ezCLI.git
cd ezCLI
cargo tauri dev        # live window, Rust rebuilds on save
cargo tauri build      # produces src-tauri/target/release/bundle/msi/*.msi
```

The MSI lands in `src-tauri/target/release/bundle/msi/`.

## Troubleshooting

**An agent card is disabled.** The `command` is not on PATH. Install the CLI, or
set `command` to its full path, then reload agents.

**Codex exits immediately with a daemon error.** Codex tried to detach a background
server and the host blocked it. Keep `--no-daemon` in the Codex entry's `args`, which
is the default here.

**The Changes pane says git is not installed.** Install git and make sure it is
on PATH.

**The window opens but the sidebar is black.** Your WebView2 runtime is out of date.
Install the Evergreen bootstrapper from
<https://developer.microsoft.com/microsoft-edge/webview2/>.

**Cargo build fails with "program not found: dlltool.exe".** Install the rust-mingw
component: `rustup component add rust-mingw`, then prepend
`%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained`
to your `PATH` for the shell you build in.
