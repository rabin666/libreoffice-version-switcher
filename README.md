# libreoffice-version-switcher (`lovs`)

Download, install and switch between many LibreOffice versions side by side, from a **CLI** or a **local web UI**.
Built for testing documents against different LibreOffice releases.

- Browse every version in the [official archive](https://downloadarchive.documentfoundation.org/libreoffice/old/)
- See what is installed locally, including folders you already keep (e.g. `D:\LibreOfficePortable`)
- Install any version in one step, silently, without admin/root, next to the others
- Put a version on the persistent `PATH` (user or machine scope), or remove it
- Get the command that activates a version **for the current terminal only**, or run a single command with it
- Fast downloads: parallel connections built in, or hand off to **XDM** (Xtreme Download Manager)
- Windows, Ubuntu/Debian, RHEL / Oracle Linux; ships as a single executable (via `@yao-pkg/pkg`)

## Quick start

```sh
# use the standalone binary (release/lovs-win-x64.exe, lovs-linux-x64, lovs-linux-arm64)
# or from source: npm install && npm run build && npm link

lovs config add-scan-dir D:\LibreOfficePortable   # pick up versions you already have
lovs config set installDir D:\LibreOffice          # where new versions go (default ~/.lovs/versions)

lovs ls                      # local versions; * = this shell, > = new terminals
lovs remote                  # archive, newest 12 series (--all for everything)
lovs install 7.6             # newest 7.6.x build
lovs exec 7.6 -- soffice --headless --convert-to pdf report.docx
lovs path add 25.2.7         # persistent PATH (new terminals)
lovs ui                      # web interface at http://127.0.0.1:5178
```

## CLI reference

| Command | What it does |
| --- | --- |
| `lovs ls [--json] [--no-probe]` | Installed versions with where they are and whether they're on PATH |
| `lovs remote [filter] [--all] [--pre] [--refresh]` | Versions in the archive, grouped by series. `filter` like `7.6` or `24.8.7` |
| `lovs remote info <version>` | Downloadable packages of a version for this platform, with sizes |
| `lovs install <version> [-m method] [-d builtin\|xdm] [--force] [--keep-download]` | Download + install. `<version>` may be exact (`7.6.7.2`), a prefix (`7.6` = newest 7.6.x) or `latest`. `--force` reinstalls: only a copy lovs created is replaced, only once the new one is ready, and its profile is kept |
| `lovs uninstall <version> [--yes]` | Delete a version lovs installed: it must have lovs' `.lovs.json` marker and really (links resolved) sit directly in `installDir`. Anything else is never touched |
| `lovs path status` | LibreOffice entries in user/machine PATH and which `soffice` wins |
| `lovs path add <version> [--scope user\|machine] [--keep-others]` | Put a version first on the persistent PATH. Other LibreOffice entries in that scope are removed unless `--keep-others` |
| `lovs path remove [version] [--scope user\|machine]` | Remove one version, or every LibreOffice entry, from PATH |
| `lovs env <version> [--shell powershell\|cmd\|bash\|fish]` | Print the command that activates a version in the current shell only |
| `lovs exec <version> -- <command...>` | Run one command with that version first on PATH |
| `lovs shell <version>` | Open a sub-shell with that version first on PATH (`exit` to leave) |
| `lovs which` | The `soffice` the current shell resolves |
| `lovs config [list\|get\|set\|add-scan-dir\|remove-scan-dir]` | Settings (shared with the web UI) |
| `lovs doctor` | Platform, install methods, XDM / 7-Zip / unpack tools, PATH state |
| `lovs ui [--port] [--no-open]` | Start the web interface |

Wherever a `<version>` is expected for a local install you can also pass its folder path.

### Current terminal only

```powershell
# PowerShell
lovs env 7.6 --shell powershell | Invoke-Expression
```
```sh
# bash / zsh (Linux, or Git Bash on Windows)
eval "$(lovs env 7.6 --shell bash)"
```
```bat
:: cmd.exe
for /f "delims=" %i in ('lovs env 7.6 --shell cmd') do %i
```

Running `lovs env 7.6` in a terminal prints the plain commands for every shell. The web UI shows them with copy buttons under **Use in a terminal**.

## Web UI

`lovs ui` starts a local server (default port 5178; the next free port is used if taken) and opens the browser.

- **Installed**: every local version, what new terminals and the server's PATH resolve to, PATH add/remove (user or machine), shell commands, open folder, uninstall
- **Available**: the whole archive by series. Pick a build to see its packages and sizes, choose the downloader, install
- **Activity**: live progress (speed, ETA, phases, log) with cancel
- **Settings**: every config key, plus detected XDM / 7-Zip

The server only listens on `127.0.0.1`, rejects foreign `Host` headers and requires a per-run session token on every API call. Other websites can't drive it. `lovs ui --host 0.0.0.0` makes it reachable from your network through this machine's own addresses or hostname. Anyone who can reach it can then use it, so only do this on a trusted network.

## How versions are installed

Nothing is registered with the OS, so any number of versions can coexist. Each lives in its own folder under `installDir`.

| Platform | Method | How |
| --- | --- | --- |
| Windows | `msi` (default) | Official MSI unpacked with `msiexec /a` (administrative install): files only, no registry, no admin |
| Windows | `portable` | PortableApps `.paf.exe`, unpacked silently with 7-Zip. Without 7-Zip its installer window opens with the destination pre-filled |
| Ubuntu / Debian | `deb` (default) | Official deb tarball. The `.deb`s are unpacked (`dpkg-deb -x`) into one folder, no root |
| RHEL / Oracle Linux | `rpm` (default) | Official rpm tarball, unpacked with `rpm2cpio \| cpio`. Needs both tools (`sudo dnf install cpio`). The `deb` method also works there |

- Downloads are checked against the archive's published SHA-256.
- **Separate profile per version** (`isolateProfile`, on by default): MSI/deb/rpm installs keep their user profile in `<install>/user-profile` instead of sharing `%APPDATA%\LibreOffice` / `~/.config/libreoffice`, so switching versions never corrupts a profile. Portable installs get `UserInstallation` set to `<portable>/Data/settings` (the launcher's location) explicitly, because PATH and `lovs exec` run the inner `soffice` without the PortableApps launcher. The "own profile" flag shown for any install is read from its actual `bootstrap.ini`/`bootstraprc`.
- Linux builds still need the usual system libraries. If `soffice` fails to start, installing the distro's `libreoffice` package once pulls them in.
- Windows Installer needs free space on the system drive (C:) even when installing elsewhere.

## PATH: user vs machine

- **Windows**: `user` = `HKCU\Environment\Path`, `machine` = `HKLM\...\Session Manager\Environment\Path`. Machine scope shows a UAC prompt when not elevated. Values stay `REG_EXPAND_SZ`, so entries like `%USERPROFILE%\bin` survive. A settings-change broadcast makes new terminals pick the change up straight away.
  > Windows puts the **machine PATH before the user PATH**. If the machine PATH already has a LibreOffice folder, a user-PATH entry is hidden. `lovs path status` and the web UI warn about this. Fix it with `lovs path remove --scope machine`, or add with `--scope machine`.
- **Linux**: `user` = `~/.config/lovs/path.sh`, sourced from `~/.bashrc`/`~/.profile` (and `~/.zshrc`, `~/.bash_profile` if present). `machine` = `/etc/profile.d/lovs.sh` (run with `sudo`; pass the install folder instead of a version, since root has its own config).

PATH changes apply to terminals opened afterwards. For the current one, use `lovs env` / `lovs exec`.

## Faster downloads with XDM

The built-in downloader already uses parallel range requests (`connections`, default 6). To use [XDM](https://xtremedownloadmanager.com/) instead:

```sh
lovs config set downloader xdm          # or 'auto' (default): XDM when found, built-in otherwise
lovs config set xdmPath "C:\Program Files (x86)\XDM"   # only if not auto-detected; folder, xdman.jar or launcher
```

lovs starts XDM in the background if it isn't running and queues the download through XDM's local control port (9614). It waits for the finished file, verifies the SHA-256 and continues the install. This has been tested with XDM 7.2.x. lovs turns XDM's "quiet mode" on for its own request and off again a few seconds later.

## Configuration

`~/.lovs/config.json` (set `LOVS_HOME` to move everything). `lovs config` lists all keys:

`installDir`, `scanDirs`, `downloadDir`, `keepDownloads`, `downloader` (`auto|builtin|xdm`), `xdmPath`, `sevenZipPath`, `connections`, `isolateProfile`, `windowsMethod` (`msi|portable`), `linuxMethod` (`auto|deb|rpm`), `includePrereleases`, `port`.

Installs are discovered in `installDir`, every `scanDirs` folder (up to 6 levels deep) and the standard system locations (`C:\Program Files\LibreOffice`, `/opt/libreoffice*`, `/usr/lib/libreoffice`, …).

## Development

```sh
npm install
npm run dev          # API on :5178 (auto-restart) + Vite on :5173 with /api proxied
npm test             # vitest (test/)
npm run build        # web UI -> dist/ui, CLI+API bundle -> dist/lovs.cjs
node index.js ls     # run the CLI from source
```

### Standalone executables (yao-pkg)

```sh
npm run pkg          # release/lovs-win-x64.exe, lovs-linux-x64, lovs-linux-arm64
npm run pkg:win      # Windows only
npm run pkg:linux    # Linux x64 + arm64
```

`scripts/build.mjs` bundles everything into one CommonJS file with esbuild. pkg then embeds it together with `dist/ui`. Builds use `--no-bytecode`, so all targets cross-compile from any OS. Set `PKG_CACHE_PATH` to move pkg's Node binary cache (default `~/.pkg-cache`). The Linux binaries need glibc 2.28+ (RHEL/Oracle Linux 8+, Ubuntu 20.04+).

### Releasing

```sh
npm version 0.1.0 && git push --follow-tags   # tag v0.1.0 -> GitHub Actions builds and publishes the release
```

The [Release workflow](.github/workflows/release.yml) tests on Linux and Windows, builds all executables plus a Node bundle and `SHA256SUMS.txt`, smoke-tests them, and attaches them to the GitHub release. Running it manually is a dry run.

### Layout

```
index.js            entry point (CLI)
cli/                commander definitions (program.js) and handlers per area (commands/)
api/                web server, router, route table, background jobs
utils/              core: install/unpack/lock/ownership, local scan, archive, downloaders, PATH, shell
web_interface/      React + Vite UI (components/<area>, hooks, lib; built into dist/ui)
scripts/            esbuild bundle + dev runner
test/               vitest suites
```

Architecture, flows (with diagrams), on-disk data, security model, conventions and how-tos for contributors are in [readme.help.md](readme.help.md).
