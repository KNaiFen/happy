# Happy

Use Codex from your phone, browser, or terminal.

Free. Open source. Code anywhere.

## Installation

```bash
npm install -g happy
```

> Migrated from the `happy-coder` package. Thanks to [@franciscop](https://github.com/franciscop) for donating the `happy` package name!

## Usage

### Codex (default)

```bash
happy
# or
happy codex
```

This will:
1. Start a Codex session through the official app-server protocol
2. Display a QR code to connect from your mobile device or browser
3. Allow real-time session control — all communication is end-to-end encrypted
4. Start new sessions directly from your phone or web while your computer is online

## Daemon

The daemon is a background service that stays running on your machine. It lets you spawn and manage coding sessions remotely — from your phone or the web app — without needing an open terminal.

```bash
happy daemon start
happy daemon stop
happy daemon status
happy daemon list
```

The daemon starts automatically when you run `happy`, so you usually don't need to manage it manually.

### Keeping the daemon running across reboots

If you want the daemon to come back automatically after a reboot — without opening a `happy` session first — start it from your shell profile so it inherits your normal user session context (PATH, keychain access, OAuth credentials):

```bash
# ~/.zshrc or ~/.bashrc
if [[ -o interactive ]] && [[ -z "$HAPPY_DAEMON_CHECKED" ]]; then
    export HAPPY_DAEMON_CHECKED=1
    () {
        local state=$HOME/.happy/daemon.state.json
        local pid=$(grep -oE '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$state" 2>/dev/null | grep -oE '[0-9]+')
        if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
            happy daemon start >/dev/null 2>&1
        fi
    } &!
fi
```

The first interactive shell after a reboot triggers the start; subsequent shells short-circuit because the daemon is already running.

> **macOS users:** prefer this shell-init approach over a `launchd` LaunchAgent. A LaunchAgent may not inherit the same shell PATH, `CODEX_HOME`, or interactive login state as your terminal.

## Authentication

```bash
happy auth login
happy auth logout
```

Happy uses cryptographic key pairs for authentication — your private key stays on your machine. All session data is end-to-end encrypted before leaving your device.

To inspect the Codex connection:

```bash
happy connect codex
happy connect status
```

## Commands

| Command | Description |
|---------|-------------|
| `happy` | Start Codex mode (default) |
| `happy codex` | Start Codex mode explicitly |
| `happy resume <id>` | Resume a previous session |
| `happy notify` | Send push notification to your devices |
| `happy doctor` | Diagnostics & troubleshooting |

---

## Advanced

### Environment Variables

| Variable | Description |
|----------|-------------|
| `HAPPY_SERVER_URL` | Custom server URL (default: `https://api.cluster-fluster.com`) |
| `HAPPY_WEBAPP_URL` | Custom web app URL (default: `https://app.happy.engineering`) |
| `HAPPY_HOME_DIR` | Custom home directory for Happy data (default: `~/.happy`) |
| `HAPPY_DISABLE_CAFFEINATE` | Disable macOS sleep prevention |
| `HAPPY_EXPERIMENTAL` | Enable experimental features |

### Sandbox (experimental)

Happy can run agents inside an OS-level sandbox to restrict file system and network access.

```bash
happy sandbox configure
happy sandbox status
happy sandbox disable
```

### Source-level development

```bash
git clone https://github.com/slopus/happy
cd happy
pnpm install --frozen-lockfile
pnpm --filter happy typecheck
pnpm --filter happy exec tsx src/index.ts --help
```

Release archives are built and installed in GitHub Actions. Routine local
development does not build or globally link the CLI package.

## Requirements

- Node.js >= 20.0.0
- `codex` CLI 0.145.0 or newer installed and logged in

## License

MIT
