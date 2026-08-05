# Happy Server

Minimal relay for open-source end-to-end encrypted Codex clients.

## What is Happy?

Happy Server is the synchronization backbone for secure Codex clients. It enables multiple devices to share encrypted conversations while maintaining complete privacy - the server never sees your messages, only encrypted blobs it cannot read.

## Features

- 🔐 **Zero Knowledge** - The server stores encrypted data but has no ability to decrypt it
- 🎯 **Minimal Surface** - Only essential features for secure sync, nothing more  
- 🕵️ **Privacy First** - The Relay does not run product analytics or mine encrypted session payloads; App analytics are documented separately and can be disabled
- 📖 **Open Source** - Transparent implementation you can audit and self-host
- 🔑 **Cryptographic Auth** - No passwords stored, only public key signatures
- ⚡ **Real-time Sync** - WebSocket-based synchronization across all your devices
- 📱 **Multi-device** - Seamless session management across phones, tablets, and computers
- 🔔 **Push Notifications** - Notify when Codex finishes tasks or needs permissions (encrypted, we can't see the content)
- 🌐 **Distributed Ready** - Built to scale horizontally when needed

## How It Works

Happy clients generate encryption keys locally and use Happy Server as a secure relay. Messages are end-to-end encrypted before leaving your device. The server's job is simple: store encrypted blobs and synchronize them between your devices.

## Hosting

**You don't need to self-host.** The default Happy Relay endpoint is
`https://api.cluster-fluster.com`. Happy session payloads are encrypted before
relay synchronization; unencrypted routing metadata and optional voice data
have the separate boundaries documented in the repository privacy policy.

That said, Happy Server is open source and self-hostable if you prefer running
your own infrastructure. A correctly configured HTTPS deployment preserves the
same encrypted session-payload boundary. Explicit trusted-LAN HTTP opt-in does
not provide HTTPS transport protection and is outside that guarantee.

## Self-Hosting with Docker

The standalone Docker image runs everything in a single container with no external dependencies (no Postgres, no Redis, no S3).

```bash
docker build -t happy-server -f Dockerfile.server .
```

Run from the monorepo root:

```bash
docker run -p 3005:3005 \
  -e HANDY_MASTER_SECRET=<your-secret> \
  -v happy-data:/data \
  happy-server
```

This uses:
- **PGlite** - embedded PostgreSQL (data stored in `/data/pglite`)
- **Local filesystem** - for file uploads (stored in `/data/files`)
- **In-memory event bus** - no Redis needed

Data persists in the `happy-data` Docker volume across container restarts.

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

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HANDY_MASTER_SECRET` | Yes | - | Master secret for auth/encryption |
| `PUBLIC_URL` | No | `http://localhost:3005` | Public base URL for file URLs sent to clients |
| `PORT` | No | `3005` | Server port |
| `DATA_DIR` | No | `/data` | Base data directory |
| `PGLITE_DIR` | No | `/data/pglite` | PGlite database directory |

### Optional: External Services

To use external Postgres or Redis instead of the embedded defaults, set:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection URL (bypasses PGlite) |
| `REDIS_URL` | Redis connection URL |
| `S3_HOST` | S3/MinIO host (bypasses local file storage) |

### S3 bucket configuration (when self-hosting with S3)

When `S3_HOST` is set, image attachments and other blobs land in S3 under
`sessions/<sessionId>/attachments/<id>.enc`. Two bucket-level settings are
not configured by the server itself and must be applied once at deploy
time:

**1. Lifecycle rule for attachment TTL.** Encrypted blobs are deleted when
their session is deleted, but a long-lived session would otherwise keep
its blobs forever. Add a lifecycle rule on the attachments prefix so
objects age out automatically. Pick a TTL that matches your retention
policy (30 days is a reasonable default).

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
