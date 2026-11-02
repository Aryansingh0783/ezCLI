#!/usr/bin/env bash
# Everything ezCLI uses on Windows, set up on Arch Linux (and Arch-based: CachyOS, Manjaro, EndeavourOS...).
#
#   ./scripts/arch-setup.sh              # install it all
#   ./scripts/arch-setup.sh --dry-run    # show the plan, change nothing
#   ./scripts/arch-setup.sh --no-agents  # system packages and tools only, skip the agent CLIs
#   ./scripts/arch-setup.sh --build      # also add what is needed to build ezCLI from source
#
# What Windows needs, and what this installs instead:
#   WebView2 runtime ............ webkit2gtk-4.1, gtk3, libayatana-appindicator (the window and tray)
#   git, Node.js + npm, ffmpeg .. git, nodejs, npm, ffmpeg (the same tools ezCLI's Health check looks for)
#   Ollama ...................... ollama (+ ollama-cuda for NVIDIA, ollama-rocm for AMD), from pacman
#   Graphify (Brain) ............ uv, or a private Python venv
#   Agents ...................... Claude Code, Codex, OpenCode, Gemini CLI, Freebuff (npm, into ~/.local, no root)
#                                 and Antigravity (its own installer)
#
# Run it as your normal user: it uses sudo only for pacman. Every pacman package is checked to exist
# first, so a renamed or missing one is reported and skipped instead of stopping the rest.
set -u -o pipefail

DRY=0; AGENTS=1; BUILD=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --no-agents) AGENTS=0 ;;
    --build) BUILD=1 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a (see --help)"; exit 2 ;;
  esac
done

b() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
FAILED=()
run() { if [ "$DRY" = 1 ]; then printf '  [dry run] %s\n' "$*"; else "$@"; fi; }

[ "$(id -u)" = 0 ] && { echo "Run this as your normal user, not root (npm agents install into your home folder)."; exit 1; }
if ! command -v pacman >/dev/null 2>&1; then
  [ "$DRY" = 1 ] && note "(pacman not found: showing the plan only; this is not an Arch system)" || { echo "pacman not found: this script is for Arch-based systems. On Debian/Ubuntu use scripts/install-linux.sh."; exit 1; }
fi

# ---------------------------------------------------------------- this machine
gpu="other"
if [ -e /proc/driver/nvidia/version ]; then gpu="nvidia"
elif command -v lspci >/dev/null 2>&1; then
  g="$(lspci -nn 2>/dev/null | grep -Ei 'vga|3d|display' || true)"
  case "$g" in *10de:*) gpu="nvidia" ;; *1002:*) gpu="amd" ;; esac
fi
b "ezCLI setup for Arch"
note "gpu: $gpu   session: ${XDG_SESSION_TYPE:-unknown}   desktop: ${XDG_CURRENT_DESKTOP:-unknown}"
echo

# ---------------------------------------------------------------- pacman packages
have_pkg() { pacman -Si "$1" >/dev/null 2>&1; }
install_group() { # label pkg...
  local label="$1"; shift
  local ok=() missing=() p
  for p in "$@"; do
    if [ "$DRY" = 1 ] && ! command -v pacman >/dev/null 2>&1; then ok+=("$p")
    elif have_pkg "$p"; then ok+=("$p"); else missing+=("$p"); fi
  done
  b "$label"
  [ "${#missing[@]}" -gt 0 ] && { note "not in your repos (skipped): ${missing[*]}"; FAILED+=("pacman: ${missing[*]}"); }
  if [ "${#ok[@]}" -gt 0 ]; then
    run sudo pacman -S --needed --noconfirm "${ok[@]}" || FAILED+=("pacman group: $label")
  fi
  echo
}

[ "$DRY" = 0 ] && { b "Refreshing package databases"; sudo pacman -Sy || FAILED+=("pacman -Sy"); echo; }

install_group "The window (what WebView2 is on Windows)" gtk3 webkit2gtk-4.1 libayatana-appindicator
install_group "Tools ezCLI's Health check looks for" git nodejs npm ffmpeg
install_group "Helpers (downloads, opening links, graphical sudo prompts)" curl xdg-utils polkit python
ollama_pkgs=(ollama)
[ "$gpu" = nvidia ] && ollama_pkgs+=(ollama-cuda)
[ "$gpu" = amd ] && ollama_pkgs+=(ollama-rocm)
install_group "Ollama (local and cloud models)" "${ollama_pkgs[@]}"
install_group "Graphify (Brain)" uv
install_group "AppImage support (optional)" fuse2
[ "$BUILD" = 1 ] && install_group "To build ezCLI from source" base-devel rust librsvg openssl pkgconf

# ---------------------------------------------------------------- agents
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$HOME/.local}"
if [ "$AGENTS" = 1 ]; then
  b "Agent CLIs (npm, into $NPM_CONFIG_PREFIX)"
  if ! command -v npm >/dev/null 2>&1 && [ "$DRY" = 0 ]; then
    note "npm is missing, so the npm agents are skipped."; FAILED+=("npm agents (no npm)")
  else
    run mkdir -p "$NPM_CONFIG_PREFIX/bin" "$NPM_CONFIG_PREFIX/lib"
    # one at a time: a failing package does not stop the others. npm 11.16+ skips install scripts unless
    # allowed, and OpenCode needs its own.
    for pkg in @anthropic-ai/claude-code @openai/codex opencode-ai @google/gemini-cli freebuff; do
      note "$pkg"
      run npm install -g "$pkg" --allow-scripts="$pkg" || FAILED+=("npm: $pkg")
    done
  fi
  echo
  b "Antigravity CLI (its own installer, goes to ~/.local/bin)"
  run bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash' || FAILED+=("antigravity")
  echo
fi

# ---------------------------------------------------------------- graphify
b "Graphify"
if command -v uv >/dev/null 2>&1 || [ "$DRY" = 1 ]; then
  run uv tool install graphifyy || FAILED+=("graphify")
else
  # no uv: Arch's Python refuses pip --user (PEP 668), so use a private venv
  run python3 -m venv "$HOME/.local/share/ezcli/graphify-venv" \
    && run "$HOME/.local/share/ezcli/graphify-venv/bin/pip" install graphifyy \
    && run mkdir -p "$HOME/.local/bin" \
    && run ln -sf "$HOME/.local/share/ezcli/graphify-venv/bin/graphify" "$HOME/.local/bin/graphify" || FAILED+=("graphify")
fi
echo

# ---------------------------------------------------------------- check
b "Check"
export PATH="$HOME/.local/bin:$PATH"
for c in git node npm ffmpeg ollama claude codex opencode gemini freebuff agy graphify ezcli; do
  if command -v "$c" >/dev/null 2>&1; then printf '  \033[32m✓\033[0m %-9s %s\n' "$c" "$(command -v "$c")"
  else printf '  \033[31m✗\033[0m %-9s not found\n' "$c"; fi
done
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) note "Add ~/.local/bin to your PATH in your shell config so the agents work in a terminal too (ezCLI finds it by itself)." ;; esac
[ "$gpu" = nvidia ] && note "NVIDIA: for GPU models in Ollama also install the driver stack (nvidia-utils); ezCLI sets the right WebKit options on its own."
if [ "${#FAILED[@]}" -gt 0 ]; then echo; b "Needs attention"; for f in "${FAILED[@]}"; do note "$f"; done; fi
echo; [ "$DRY" = 1 ] && b "Dry run: nothing was changed." || b "Done. Install or update ezCLI itself with scripts/install-linux.sh."
