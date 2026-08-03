# Happy Agent

CLI client for controlling Happy Codex sessions remotely.

Unlike `happy-cli` which both runs and controls Codex, `happy-agent` only controls it — listing machines, spawning sessions on a machine, creating sessions, sending messages, reading history, monitoring state, and stopping sessions.

## Installation

From the monorepo during development:

```bash
yarn workspace happy-agent build
```

Or link globally:

```bash
cd packages/happy-agent && npm link
```

## Authentication

Happy Agent uses account authentication via QR code, the same flow as linking a device in the Happy mobile app.

```bash
# Authenticate by scanning QR code with the Happy mobile app
happy-agent auth login

# Check authentication status
happy-agent auth status

# Clear stored credentials
happy-agent auth logout
```

Credentials are stored at `~/.happy/agent.key`.

## Commands

### List sessions

```bash
# List all sessions
happy-agent list

# List only active sessions
happy-agent list --active

# Output as JSON
happy-agent list --json
```

### List machines

```bash
# List all machines
happy-agent machines

# List only active machines
happy-agent machines --active

# Output as JSON
happy-agent machines --json
```

### Spawn on a machine

```bash
# Spawn a session on a specific machine
happy-agent spawn --machine <machine-id> --path ~/project

# Let the daemon create the directory if needed
happy-agent spawn --machine <machine-id> --path ~/new-project --create-dir

# Output as JSON
happy-agent spawn --machine <machine-id> --path ~/project --json
```

### Session status

```bash
# Get live session state (supports ID prefix matching)
happy-agent status <session-id>

# Output as JSON
happy-agent status <session-id> --json
```

### Send a message

```bash
# Send a message to a session
happy-agent send <session-id> "Fix the login bug"

# Send with yolo permissions
happy-agent send <session-id> "Ship it" --yolo

# Send and wait for the agent to finish
happy-agent send <session-id> "Run the tests" --wait

# Output as JSON
happy-agent send <session-id> "Hello" --json
```

### Message history

```bash
# View message history
happy-agent history <session-id>

# Limit to last N messages
happy-agent history <session-id> --limit 10

# Output as JSON
happy-agent history <session-id> --json
```

### Stop a session

```bash
happy-agent stop <session-id>
```

### Wait for idle

```bash
# Wait for agent to become idle (default 300s timeout)
happy-agent wait <session-id>

# Custom timeout
happy-agent wait <session-id> --timeout 60
```

Exit code 0 when agent becomes idle, 1 on timeout.

## Environment Variables

- `HAPPY_SERVER_URL` - API server URL (default: `https://api.cluster-fluster.com`)
- `HAPPY_HOME_DIR` - Home directory for credential storage (default: `~/.happy`)

## Session ID Matching

All commands that accept a `<session-id>` support prefix matching. You can provide the first few characters of a session ID and the CLI will resolve the full ID.

Machine-aware commands such as `spawn --machine <machine-id>` also support ID prefix matching.

## Encryption

All machine and session data is end-to-end encrypted. New records use AES-256-GCM with per-record keys. Existing records created by other clients are decrypted using the appropriate key scheme (AES-256-GCM or legacy NaCl secretbox).

## Requirements

- Node.js >= 20.0.0
- A Happy mobile app account for authentication

## Publishing to npm

Version bumps on `main` trigger the GitHub Actions package workflow. It runs
source checks, builds and packs the archive, installs that archive into a clean
directory, then exercises a real HTTP and Socket.IO machine-RPC exchange with
the default `codex` agent. The workflow uploads one installable `.tgz` artifact;
registry publishing remains a separate, explicitly authorized operation.

## License

MIT
