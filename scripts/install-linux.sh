#!/usr/bin/env bash
# Install ezCLI on Linux, tailored to this machine: it looks at the distribution, the session
# (Wayland or X11), the desktop (KDE, Hyprland, GNOME...) and the GPU (NVIDIA or not), says what it
# found, and installs the way that fits.
#
#   curl -fsSL https://raw.githubusercontent.com/Aryansingh0783/ezCLI/main/scripts/install-linux.sh | bash
#   ./install-linux.sh --dry-run     # show the plan, change nothing
#
# Arch family (Arch, CachyOS, Manjaro, EndeavourOS...): builds the pacman package from packaging/arch.
# Debian family (Debian, Ubuntu, Mint, Pop!_OS...):     installs the release .deb with apt.
# Anything else:                                         puts the AppImage in ~/.local/bin.
# Every download is checked against the SHA-256 published next to it on the Releases page.
set -euo pipefail

REPO="Aryansingh0783/ezCLI"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

say() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then printf '  [dry run] %s\n' "$*"; else "$@"; fi; }

# ---------------------------------------------------------------- what this machine is
ID=""; ID_LIKE=""
[ -r /etc/os-release ] && . /etc/os-release
family="other"
case " ${ID:-} ${ID_LIKE:-} " in
  *" arch "*|*" cachyos "*|*" manjaro "*|*" endeavouros "*) family="arch" ;;
  *" debian "*|*" ubuntu "*) family="debian" ;;
esac
[ "$ID" = "steamos" ] && family="steamos"

session="${XDG_SESSION_TYPE:-}"
[ -z "$session" ] && [ -n "${WAYLAND_DISPLAY:-}" ] && session="wayland"
[ -z "$session" ] && session="x11"
desktop="${XDG_CURRENT_DESKTOP:-unknown}"
[ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ] && desktop="Hyprland"

gpu="unknown"
if [ -e /proc/driver/nvidia/version ]; then gpu="nvidia (proprietary driver loaded)"
elif command -v lspci >/dev/null 2>&1; then
  g="$(lspci -nn 2>/dev/null | grep -Ei 'vga|3d|display' || true)"
  case "$g" in
    *10de:*) gpu="nvidia (driver not loaded, or nouveau)" ;;
    *1002:*) gpu="amd" ;;
    *8086:*) gpu="intel" ;;
  esac
fi

say "ezCLI installer"
note "distribution: ${PRETTY_NAME:-unknown} (family: $family)"
note "session:      $session"
note "desktop:      $desktop"
note "gpu:          $gpu"

# ---------------------------------------------------------------- what that means
case "$gpu" in
  nvidia*)
    note "NVIDIA: ezCLI turns off WebKitGTK's DMA-BUF renderer at start-up, which avoids a blank or slow"
    note "window with NVIDIA's driver. Override with EZCLI_WEBKIT_SAFE=0 (off) or =1 (on for any GPU)."
    case "$gpu" in *"not loaded"*) note "The proprietary driver is not loaded; install your distribution's nvidia package for GPU rendering." ;; esac ;;
esac
[ "$session" = "wayland" ] && case "$desktop" in *Hyprland*|*hyprland*) note "Hyprland: a tiling compositor, so the app's own minimise/maximise buttons do nothing there; use your usual keybinds." ;; esac
echo

# ---------------------------------------------------------------- helpers
latest_version() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1
}
download_checked() { # url, dest ; checks <url>.sha256
  local url="$1" dest="$2" want got
  run curl -fSL --progress-bar -o "$dest" "$url"
  [ "$DRY" = 1 ] && return 0
  want="$(curl -fsSL "$url.sha256" 2>/dev/null | awk '{print $1}' || true)"
  got="$(sha256sum "$dest" | awk '{print $1}')"
  [ -n "$want" ] || die "no published checksum found at $url.sha256, so $(basename "$dest") was not installed"
  [ "$want" = "$got" ] || die "checksum mismatch for $(basename "$dest") (expected $want, got $got)"
  note "checksum ok"
}

[ "$(id -u)" = 0 ] && [ "$family" = "arch" ] && die "run this as your normal user, not root: makepkg refuses to run as root. It uses sudo where it needs it."
command -v curl >/dev/null 2>&1 || die "curl is required"
ver="$(latest_version)"; [ -n "$ver" ] || die "could not read the latest release from GitHub"
say "Installing ezCLI $ver"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

case "$family" in
  arch)
    run sudo pacman -S --needed --noconfirm base-devel git gtk3 webkit2gtk-4.1 libayatana-appindicator
    run curl -fsSL -o "$tmp/PKGBUILD" "https://raw.githubusercontent.com/$REPO/main/packaging/arch/PKGBUILD"
    if [ "$DRY" = 0 ]; then
      # the PKGBUILD in the repo can lag a release; point it at the latest .deb and its published checksum
      sum="$(curl -fsSL "https://github.com/$REPO/releases/download/v$ver/ezCLI_${ver}_amd64.deb.sha256" | awk '{print $1}')"
      [ -n "$sum" ] || die "no checksum published for $ver"
      sed -i -E "s/^pkgver=.*/pkgver=$ver/; s/^pkgrel=.*/pkgrel=1/; 0,/^  '[0-9a-f]{64}'/s//  '$sum'/" "$tmp/PKGBUILD"
      ( cd "$tmp" && makepkg -si --noconfirm )
    else
      note "[dry run] build with makepkg -si from packaging/arch/PKGBUILD, pinned to $ver"
    fi ;;
  debian)
    download_checked "https://github.com/$REPO/releases/download/v$ver/ezCLI_${ver}_amd64.deb" "$tmp/ezcli.deb"
    run sudo apt-get install -y "$tmp/ezcli.deb" ;;
  steamos)
    die "SteamOS has a read-only root. Use Distrobox as described in AGENTS.md (Case B) instead." ;;
  *)
    dest="$HOME/.local/bin"; run mkdir -p "$dest"
    download_checked "https://github.com/$REPO/releases/download/v$ver/ezCLI_${ver}_amd64.AppImage" "$tmp/ezCLI.AppImage"
    run install -m755 "$tmp/ezCLI.AppImage" "$dest/ezcli"
    note "Installed to $dest/ezcli (add that folder to PATH if it is not already). AppImages need FUSE 2 (libfuse2)." ;;
esac

echo
if [ "$DRY" = 1 ]; then say "Dry run finished; nothing was changed."; else
  command -v ezcli >/dev/null 2>&1 && say "Done: $(command -v ezcli)" || say "Done. Start it from your app menu, or run: ezcli"
fi
