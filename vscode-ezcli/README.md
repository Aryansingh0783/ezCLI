# ezCLI for VS Code

Start your coding CLIs in VS Code terminals with the same agents, models and modes you set up in the [ezCLI desktop app](https://github.com/Aryansingh0783/ezCLI).

The extension never calls a model itself. Each terminal runs the real CLI (Claude Code, Codex, OpenCode, Gemini CLI, Ollama, Freebuff and others), which uses your own account.

## Commands

Open the Command Palette and type "ezCLI".

| Command | What it does |
| --- | --- |
| ezCLI: Start an agent in a terminal | Pick an installed agent and a model, then start it in a new terminal in the workspace folder. |
| ezCLI: Compare agents side by side | Pick two to four agents. Each opens in its own terminal tab in the editor area. |
| ezCLI: Open this folder in the ezCLI app | Opens the folder in the desktop app, or in the copy that is already running. |
| ezCLI: Open agents.json | Edit the shared agent list. |

"Start an agent" and "Open in the ezCLI app" are also in the Explorer's right-click menu for folders.

## Setup

1. Install the ezCLI desktop app and open it once. It writes `~/.ezcli/agents.json`, which this extension reads.
2. Install at least one agent CLI. A provider's desktop app is not its CLI; the agent picker shows the install command for anything missing.

If ezCLI is installed somewhere unusual, set `ezcli.appPath` to the full path of `ezcli.exe`.
