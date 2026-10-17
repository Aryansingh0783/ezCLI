# ezCLI guide

How to install ezCLI, launch sessions, and use every part of the window.

## Contents

- [Install](#install)
- [The window](#the-window)
- [Start a session](#start-a-session)
- [Work in a session](#work-in-a-session)
- [Images and videos](#images-and-videos)
- [Compare agents](#compare-agents)
- [Team chat](#team-chat)
- [Sessions and memory](#sessions-and-memory)
- [Command palette and prompts](#command-palette-and-prompts)
- [Past sessions and export](#past-sessions-and-export)
- [Health check and updates](#health-check-and-updates)
- [Windows, tray and notifications](#windows-tray-and-notifications)
- [Remote view](#remote-view)
- [Web chat](#web-chat)
- [VS Code extension](#vs-code-extension)
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

The home screen has three labeled pills under the message box:

| Pill | What it picks |
| --- | --- |
| **Agent** | Which CLI to launch (Claude Code, Claude, Codex, ChatGPT). |
| **Model** | Which model that agent should use. Hidden when the agent only has one. |
| **Mode** | Launch flags such as `--permission-mode plan` or `--full-auto`. |

Click any pill to open its menu — the current value is shown right under the caption, so
you always see what will launch. Mode is tucked away for power users; Model is right next
to Agent because that's the switch people actually flip.

To start a session:

1. Pick the agent, model and mode.
2. Optionally type a first message. ezCLI sends it once the CLI is ready.
3. Press the up-arrow, click "Start a session", or press `Enter` in the composer.

A new pseudo-terminal opens and the real CLI boots inside it, exactly as it would in your
own shell. The session head along the top of the terminal shows the model in use and
lets you Stop, Restart, or (when a model is changed) relaunch with the new choice.

## Resume parked sessions

ezCLI remembers every open tab across restarts. The CLI process itself cannot survive the
app dying, but the tab configuration (agent, model, mode, folder, title) comes back as a
**parked** session on next launch. Click **Resume** in the session head to relaunch it in
the exact same configuration. Close it instead if you don't need it anymore.

Per-space active tab is also remembered, so switching spaces drops you back where you
were.

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

## Images and videos

Three ways to give the AI a picture or a clip:

- Click **Attach** in the composer and pick images or videos.
- Take a screenshot (`Win+Shift+S`) or copy an image, then press `Ctrl+V` in the composer.
- Drag files from Explorer onto the window. Images and videos are attached;
  other files are added as `@file` mentions.

Attachments show as pills above the message box. Remove one with its ×. Press
`Enter` to send them with your message. ezCLI never uploads anything: the files
stay on your PC and the CLI reads them, so what the model can see depends on the
agent you picked.

| Agent | Images | Videos |
| --- | --- | --- |
| Claude Code, Claude, Codex | Attached in the CLI's own composer as `[Image #n]` | Six still frames |
| Gemini CLI | `@path` mention | The video file itself |
| OpenCode | `@path` mention | Six still frames |
| Ollama | Image path in the prompt; needs a vision model such as `llava` or `gemma3` | Six still frames |
| ChatGPT, Freebuff | Not available | Not available |

Frames are sampled evenly across the clip with your installed `ffmpeg`. If it is
missing, ezCLI tells you to run `winget install Gyan.FFmpeg`. Gemini and
OpenCode only read files inside the session folder, so for them ezCLI copies
attachments into a `.ezcli-attachments` folder there. That folder contains its
own `.gitignore`, so git never picks it up, and you can delete it at any time.
Pasted images and frames for the other agents live in `~/.ezcli/attachments`
and are cleared after a week.

## Compare agents

Press `Ctrl+Alt+M`, or the two-column button in the home box.

1. Type a prompt, or leave it empty to type later.
2. Add agents with the buttons under the list. Add the same agent twice to compare two
   of its models, and pick each model from the row's menu. **All ready agents** fills
   the list with every installed agent, up to six.
3. Press **Start**.

Each pick launches as its own session, with its own CLI process, account and usage
limits. While one of them is open, the terminal area shows the whole group side by side;
the outlined pane is the one your keyboard goes to. With **Send to all** on, every
message from the composer goes to all running sessions in the group. Attachments go to
the focused session only. **Show one at a time** switches back to normal tabs.

## Command palette and prompts

`Ctrl+Alt+P`, or the magnifier in the titlebar, opens the command palette: every
action, open tab, folder and installed agent in one searchable list. Type a few letters
of any word and press `Enter`.

`Ctrl+Alt+L` opens the prompt library. It starts with a few useful prompts. Write
`{{name}}` in a prompt where a value should be filled in; when you use it, ezCLI asks
for each value and puts the finished text in the message box for you to check. Nothing
is sent automatically. **Manage prompts** adds, edits and deletes them, and **Save
current text as a prompt** turns whatever is in the message box into a new one.

## Past sessions and export

When a session exits or its tab closes, ezCLI saves the terminal text to
`~/.ezcli/transcripts` on this PC. Saved text is kept for 30 days. `Ctrl+Alt+F` searches
all of it; open a result to read the whole session, copy it, or delete it. Settings ›
Desktop turns saving off, and **Delete all saved sessions** removes everything.

`Ctrl+Alt+E`, or **Export** in the session head, saves the current tab as a Markdown
file. The Export menu also offers an HTML page that opens in any browser. Both contain
the terminal's plain text, without colours.

## Health check and updates

Settings › Desktop › **Health check** lists every agent with its version, where ezCLI
found it, and whether it looks signed in. Anything missing shows its install command
with a Copy button. ezCLI checks sign-in by looking for the CLI's own auth file or API
key variable; it never reads them. Where it cannot tell (Ollama Cloud), it says so.

At startup ezCLI asks GitHub whether a newer release exists; an **Update** badge
appears in the titlebar if one does. **Download and install** fetches the installer,
checks it against the SHA-256 published with the release, starts it, and closes ezCLI.
If the release has no checksum, ezCLI opens the release page instead. The check can be
turned off in the Updates sheet.

## Windows, tray and notifications

- **New window**: from the command palette or the tray menu. Each window has its own tabs.
- **Move a tab**: right-click a running tab › **Move to new window**. The CLI keeps
  running; the new window replays its recent output and takes over.
- **Tray**: ezCLI has a tray icon with Show, New window and Quit. Turn on **Keep running
  in the tray** in Settings to hide the window on close instead of quitting.
- **Notifications**: when a tab you are not looking at finishes a task that ran for more
  than 15 seconds, Windows shows a notification. Turn it off in Settings.
- **Per-folder defaults**: each folder remembers the agent, model and mode it last
  launched with, and selects them when you switch to it.
- **Voice typing**: `Ctrl+Alt+D` or the microphone button opens Windows voice typing in
  the message box. Windows does the recognition.

## Remote view

Settings › Desktop › **Remote view** › **Turn on**. ezCLI shows a QR code and a link;
open it on a phone or tablet on the same Wi-Fi to watch this window's sessions live.
The link contains a long random code, so only people you give it to can open it.

The view is read-only. **Allow typing from the phone** adds a message box and a Ctrl+C
button; ezCLI asks you to confirm first, because typing into a CLI can edit files and
run commands. The connection is plain HTTP on your local network. **Turn off** ends the
link immediately, and the next one is different. Windows may ask once whether ezCLI
can accept network connections.

## Web chat

For plans with no CLI access, such as Claude Free, **Web chat** under the agent list
opens the provider's own website (Claude, ChatGPT, Gemini or Copilot) in a separate
window. You sign in there yourself. That window has no ezCLI permissions, and ezCLI does
not read or script anything in it. This is experimental and is not a session: it has no
tab, history or compare support.

## VS Code extension

Install `ezcli-x.y.z.vsix` from the release page (Extensions › … › Install from VSIX).
It reads the same `~/.ezcli/agents.json`, so open the ezCLI app once first. Then, from
the Command Palette:

- **ezCLI: Start an agent in a terminal** picks an agent and model and starts it in a new
  terminal in your workspace.
- **ezCLI: Compare agents side by side** opens two to four agents in editor-area terminals.
- **ezCLI: Open this folder in the ezCLI app** opens the folder in the app, or in the copy
  that is already running.

The first two are also in the Explorer's right-click menu for folders.

## Team chat

`Ctrl+Alt+G`, or **Team chat** on the home screen. One conversation, several agents.

1. Pick the agents under the title (Add agent). Add the same agent twice to use two of its models.
2. Choose how they work together:
   - **Round table**: each agent replies in turn and builds on the others, for 1 to 3 rounds. It stops early if every agent says DONE.
   - **Draft and review**: the first agent does the work, the others review it (read only), then the first agent revises.
   - **Compare and merge**: everyone answers on their own, then the first agent combines the answers and applies them.
3. Tick **Agents may edit files** if they should change the folder. They always take turns, so edits never collide.
4. Describe the task and press Enter. **Stop** ends the current run.

Each turn is a real one-shot run of that agent's CLI, using your own account and limits. If a model is overloaded or rate limited, ezCLI tries a comparable one and notes it on the message. Team chats are saved in Sessions.

## Sessions and memory

`Ctrl+Alt+H` opens Sessions: every tab ezCLI ran, plus the chats Claude Code and Codex keep. Select one to read it. **Resume** reopens a Claude Code or Codex conversation exactly where it stopped; **Continue in** starts any other agent in the same folder with a summary of it. Closing the app never loses a tab: it comes back with its text and Resume continues it. Sessions are stored in `~/.ezcli/transcripts` and are never deleted by age.

## Files pane

The **Files** tab browses the session's working folder. Click a folder to go in,
or `..` to go up. Click a file to preview it on the right. Preview covers text files
up to 256 KB. Binary files and larger files report their type or size instead of
dumping bytes.

## Changes pane

The **Changes** tab runs `git` in the session folder. It shows the current branch,
every file in the working tree that differs from the last commit, and a colored diff
when you pick a file. New untracked files show as an all-added diff, and a new folder
shows as one row with its file count.

Hover a row for its actions: **+** stages it, **−** unstages it, and the curved arrow
discards it. Discarding asks first, because it cannot be undone from ezCLI: a tracked
file goes back to its last commit, and a new file is deleted. The box above the list
commits what is staged, or every tracked change when nothing is staged. **Stage all**
stages everything at once.

If the folder is not a git repository, or `git` is not installed, the pane says so
instead of failing silently.

## Switch the working folder

New sessions start in the folder shown next to the home title, which defaults to your
home folder. To change it, click the folder chip and either pick one in the native
dialog or type a path. Existing sessions keep the folder they started in.

## Usage view

Open **Settings → Open usage view** to see what ezCLI can honestly measure: how many
sessions you've started per agent, their cumulative active time, and when you last used
each. Two buttons sit next to it:

- **Anthropic Console** — opens `console.anthropic.com/settings/usage` in your real
  browser.
- **OpenAI Dashboard** — opens `platform.openai.com/usage`.

ezCLI never calls model APIs, so it can't see your real spend. The counters here are
local and shared only with you; the real totals live with each provider.

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

**An agent card is disabled.** Open the Health check (Settings › Desktop) to see why. The `command` is not on PATH. ezCLI runs command line
tools, so a provider's desktop app (Claude Desktop, the ChatGPT app) does not count.
Install the CLI (for example `npm install -g @anthropic-ai/claude-code` or
`npm install -g @openai/codex`), then click **Reload agents** in Settings. ezCLI reads
the current PATH from the registry, so a fresh install is found without signing out.
You can also set `command` to the CLI's full path.

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
