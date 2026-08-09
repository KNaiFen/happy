# Happy Server

Minimal relay for open-source end-to-end encrypted Codex clients.

## What is Happy?

Happy Server is the synchronization backbone for secure Codex clients. It lets
multiple devices share encrypted conversations without decrypting session
payloads. Routing metadata and session-event notification copy use separate,
unencrypted paths documented in the repository [privacy policy](../../PRIVACY.md).

## Features

- 🔐 **Zero Knowledge Sync** - The server stores encrypted session payloads but has no ability to decrypt them
- 🎯 **Minimal Surface** - Only essential features for secure sync, nothing more  
- 🕵️ **Privacy First** - The Relay does not run product analytics or mine encrypted session payloads; App analytics are documented separately and can be disabled
- 📖 **Open Source** - Transparent implementation you can audit and self-host
- 🔑 **Cryptographic Auth** - No passwords stored, only public key signatures
- ⚡ **Real-time Sync** - WebSocket-based synchronization across all your devices
- 📱 **Multi-device** - Seamless session management across phones, tablets, and computers
- 🔔 **Push Notifications** - Notify when Codex finishes tasks or needs permissions; notification copy is not an encrypted sync payload and may pass through the Relay before Expo delivery
- 🌐 **Distributed Ready** - Built to scale horizontally when needed

## How It Works

Happy clients generate encryption keys locally and use Happy Server as a secure
relay. Session messages are end-to-end encrypted before leaving your device;
the server stores and synchronizes their ciphertext plus the routing metadata
needed to deliver it. Notification copy follows the separate path documented
in the [privacy policy](../../PRIVACY.md).

## Hosting

**You don't need to self-host.** The default Happy Relay endpoint is
`https://api.cluster-fluster.com`. Happy session payloads are encrypted before
relay synchronization; unencrypted routing metadata and optional voice metadata
have the separate boundaries documented in the repository privacy policy.

That said, Happy Server is open source and self-hostable if you prefer running
your own infrastructure. A correctly configured HTTPS deployment preserves the
same encrypted session-payload boundary. Explicit trusted-LAN HTTP opt-in does
not provide HTTPS transport protection and is outside that guarantee.

## Self-Hosting

The Debian 13 amd64 Relay bundle below is the supported released self-hosted
deployment. The repository-root `Dockerfile.server` is a legacy development
image: it starts the standard Postgres-backed service and currently uses an
obsolete workspace filter, so it is not a supported standalone/PGlite image.
Do not use it for deployment. Its repair-or-retirement decision is tracked in
[`docs/plans/happy-server-standalone-docker-path.md`](../../docs/plans/happy-server-standalone-docker-path.md).

### Standalone source mode

The source tree retains a PGlite and local-files standalone entrypoint for
development and diagnostics. It is not a release artifact and is not a
substitute for the Debian bundle's cloud acceptance:

```bash
pnpm --filter happy-server-self-host exec tsx sources/standalone.ts migrate
pnpm --filter happy-server-self-host exec tsx sources/standalone.ts serve
```

Set `HANDY_MASTER_SECRET` and, when needed, `DATA_DIR`, `PGLITE_DIR`, `PORT`,
and `HOST` before starting it. The standalone entrypoint defaults to PGlite and
local file storage; Redis is optional.

### Debian 13 amd64 offline relay bundle

Server patch releases also produce a versioned GitHub Actions artifact for
Debian 13 x86_64 hosts. This artifact is API-only: it contains the relay,
embedded PGlite database, local attachment storage, Compose configuration,
SBOM, and an offline Docker image. It does not contain the Happy Web App.

After downloading the matching
`happy-relay-server-X.Y.Z-debian13-amd64.tar.gz` artifact:

```bash
tar -xzf happy-relay-server-X.Y.Z-debian13-amd64.tar.gz
cd happy-relay
./install.sh
```

The installer verifies checksums, generates a file-backed master secret, runs
database migrations, and waits for a database-backed health check. It binds to
`127.0.0.1:3005`; Sync v4 is the normative Codex session-state protocol, while
shared v1-v3 compatibility infrastructure remains for retained features. See the
bundled `README.md` before exposing plain HTTP on a trusted LAN.

### Standalone source environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HANDY_MASTER_SECRET` | Yes | - | Master secret for auth/encryption |
| `PUBLIC_URL` | No | `http://localhost:3005` | Public base URL for file URLs sent to clients |
| `PORT` | No | `3005` | Server port |
| `DATA_DIR` | No | `./data` | Base data directory |
| `PGLITE_DIR` | No | `./data/pglite` | PGlite database directory |

### Optional: External Services

The standard service uses `DATABASE_URL` for Postgres. Standalone mode keeps
PGlite, but external Redis and S3-compatible storage remain optional:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection URL for the standard service; the standalone entrypoint selects PGlite |
| `REDIS_URL` | Redis connection URL |
| `S3_HOST` | S3/MinIO host (bypasses local file storage) |

### S3 bucket configuration (when self-hosting with S3)

When `S3_HOST` is set, image attachments and other blobs land in S3 under
`sessions/<sessionId>/attachments/<id>.enc`. Two bucket-level settings are
not configured by the server itself and must be applied once at deploy
time:

**1. Lifecycle rule for attachment TTL.** Session deletion removes database
records and triggers best-effort attachment cleanup. Object-storage failures
are non-fatal and currently have no bounded retry or hard-delete guarantee. Add
a lifecycle rule on the attachments prefix so orphaned objects and attachments
from long-lived sessions eventually age out. Pick a TTL that matches your
retention policy (30 days is a reasonable default).

```bash
# AWS CLI
aws s3api put-bucket-lifecycle-configuration --bucket happy-blobs \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "session-attachments-ttl",
      "Status": "Enabled",
      "Filter": { "Prefix": "sessions/" },
      "Expiration": { "Days": 30 }
    }]
  }'

# MinIO
mc ilm rule add myminio/happy-blobs \
  --expire-days 30 \
  --prefix "sessions/"
```

**2. Server-side encryption (defense-in-depth).** Blobs are already
end-to-end encrypted by the client, but enabling AES-256 SSE on the
bucket protects against an attacker who somehow obtains raw object
storage access without the keys.

```bash
# AWS CLI
aws s3api put-bucket-encryption --bucket happy-blobs \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

# MinIO
mc encrypt set sse-s3 myminio/happy-blobs
```

Local-storage mode (no `S3_HOST`) writes blobs under
`<DATA_DIR>/files/sessions/<sessionId>/attachments/`. There is no
lifecycle equivalent — clean up old session directories on a cron if
you want a TTL story.

## License

MIT - Use it, modify it, deploy it anywhere.
