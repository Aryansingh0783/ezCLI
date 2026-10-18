# AGENTS.md

Instructions for an AI coding agent (Claude Code, Codex CLI, or similar) that
has been pointed at this repository and asked to install ezCLI on the
machine it is running on.

## Installing ezCLI on Arch Linux, CachyOS, SteamOS, or another Arch-based system

This repo ships a verified `PKGBUILD` at [`packaging/arch/PKGBUILD`](packaging/arch/PKGBUILD).
It downloads the official `.deb` from this repo's GitHub Releases and
repackages it for pacman — there is no Rust/Node toolchain to install, and no
AUR account is involved. Everything it needs (`gtk3`, `webkit2gtk-4.1`,
`libayatana-appindicator`) is in Arch's official `extra` repo.

**First, detect which of the two cases below applies** — read `/etc/os-release`:

```bash
cat /etc/os-release
```

### Case A — a normal, writable Arch-based system (Arch Linux, CachyOS, Manjaro, EndeavourOS, Garuda, …)

`ID` or `ID_LIKE` contains `arch`, and this is **not** a Steam Deck / SteamOS.
The root filesystem is writable and pacman works directly. Run:

```bash
sudo pacman -S --needed --noconfirm base-devel git
git clone --depth 1 https://github.com/Aryansingh0783/ezCLI.git /tmp/ezcli-src
cd /tmp/ezcli-src/packaging/arch
makepkg -si --noconfirm
```

`makepkg -si` builds the package and installs it with `pacman -U` in one step,
resolving `gtk3`/`webkit2gtk-4.1`/`libayatana-appindicator` automatically.
**Do not run `makepkg` as root** — if you are already root, create an
unprivileged user first (`useradd -m builder && su builder`), because
`makepkg` refuses to run as root by design (it builds under `fakeroot`
instead). `sudo` must be available and able to prompt (or be pre-authorized)
for the dependency install and the final `pacman -U`.

Verify the install:

```bash
command -v ezcli && echo "ezCLI installed: $(command -v ezcli)"
```

### Case B — SteamOS (Steam Deck or another Steam Machine)

SteamOS's root filesystem is **read-only by design**, and changes made by
disabling that (`steamos-readonly disable`) are reverted by the next system
update — don't use that approach, and don't suggest it to the user as a fix.
The durable, Valve-sanctioned way to run third-party CLI/desktop software on
SteamOS is **Distrobox**, which ships pre-installed and runs as a container
layered on top of the OS, so it survives OS updates untouched. (Flatpak is
the recommended route for Flathub apps, but ezCLI isn't packaged there; for
anything that needs its own system packages, SteamOS's own docs point at
Distrobox or Nix.) Run:

```bash
distrobox create --name ezcli-arch --image archlinux:latest
distrobox enter ezcli-arch -- bash -c '
  sudo pacman -Syu --noconfirm base-devel git
  git clone --depth 1 https://github.com/Aryansingh0783/ezCLI.git /tmp/ezcli-src
  cd /tmp/ezcli-src/packaging/arch
  makepkg -si --noconfirm
'
distrobox-export --app ezcli
```

`distrobox-export --app ezcli` copies ezCLI's `.desktop` entry out to the
**host's** `~/.local/share/applications/`, rewritten to launch through the
container — so it shows up in the SteamOS app menu / Desktop Mode launcher
like any native app, without ever touching the read-only root.

Verify the install:

```bash
distrobox enter ezcli-arch -- command -v ezcli
ls ~/.local/share/applications/ | grep -i ezcli
```

### If something goes wrong

- **`base-devel` or `sudo` isn't available / can't prompt**: tell the user —
  don't try to work around a missing `sudo` by running `makepkg` as root;
  it will refuse.
- **`distrobox: command not found` on SteamOS**: unusual, since it ships
  pre-installed; check `which distrobox` and tell the user if it's genuinely
  missing rather than installing a different container tool yourself.
- **A newer ezCLI version is out and the PKGBUILD's pinned `pkgver`/`sha256sums`
  are stale**: the PKGBUILD documents how to bump itself in its own header
  comment — update `pkgver`, reset `pkgrel=1`, and replace the first
  `sha256sums` entry with the value from that release's
  `ezCLI_<version>_amd64.deb.sha256` asset on the
  [Releases page](https://github.com/Aryansingh0783/ezCLI/releases).
- **Never** create accounts (AUR, GitHub, etc.), enter real credentials, or
  install software from anywhere other than this repo's own GitHub Releases
  on the user's behalf while doing this.
