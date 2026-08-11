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

There are two supported self-hosting paths:

- build the repository-root `Dockerfile.server` for a portable, single-container
  PGlite deployment on the current host architecture;
- use the versioned Debian 13 amd64 Relay bundle for an offline, prepackaged
  release artifact with installer and lifecycle tooling.

Neither path needs Postgres, Redis, or S3. Both store PGlite and local encrypted
attachments in one `/data` volume and read the master secret from a narrowly
mounted file.

### Standalone Docker image (single container)

The Docker command may be run by `root` on the host. Host `root` and anyone
controlling the Docker daemon are trusted: they can read mounted secrets and
volumes, replace the container, or execute a process as any user. The service
process inside the container deliberately remains the unprivileged `65532:65532`
user to reduce the permissions available after a service compromise; it does
not protect against a host administrator.

Build from the repository root:

```bash
docker build --file Dockerfile.server --tag happy-server-standalone:local .
```

Create one persistent data volume and one host-side secret file. Keep the same
volume and secret across container replacement and upgrades:

```bash
install -d -o root -g 65532 -m 0750 /srv/happy-server/secrets
umask 077
openssl rand -hex 32 > /srv/happy-server/secrets/master-secret
chown root:65532 /srv/happy-server/secrets/master-secret
chmod 0440 /srv/happy-server/secrets/master-secret
docker volume create happy-server-data
```

Run the single container. Replace `PUBLIC_URL` with the HTTPS address clients
actually use; `http://localhost:3005` is appropriate only for same-host access.

```bash
docker run --detach \
  --name happy-server \
  --restart unless-stopped \
  --init \
  --publish 127.0.0.1:3005:3005 \
  --volume happy-server-data:/data \
  --mount type=bind,src=/srv/happy-server/secrets/master-secret,dst=/run/secrets/happy_master_secret,readonly \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --env PUBLIC_URL=https://relay.example.com \
  happy-server-standalone:local
```

The entrypoint applies pending PGlite migrations before serving port `3005`.
The image contains the Relay API only, not the Happy Web App. Do not pass the
master secret through `docker run --env`, an image `ENV`, Compose `environment`,
or logs. The entrypoint reads the mounted file and passes the value only to the
running Server process as required by the existing runtime.

The command binds only to loopback by default. To allow native App or CLI access
on a trusted LAN, explicitly change both the published address and `PUBLIC_URL`
to the host's LAN address, then restrict sources with the host firewall. Plain
HTTP is only for that trusted-network opt-in; Web clients still require HTTPS or
localhost.

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

### Standalone environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HANDY_MASTER_SECRET` | Source mode | - | Master secret for source-mode auth/encryption; do not use it for the Docker image |
| `HAPPY_MASTER_SECRET_FILE` | Docker | `/run/secrets/happy_master_secret` | Read-only file containing exactly 64 hexadecimal characters |
| `PUBLIC_URL` | No | `http://localhost:3005` | Public base URL for file URLs sent to clients |
| `PORT` | No | `3005` | Server port |
| `DATA_DIR` | No | Source: `./data`; Docker: `/data` | Base data directory |
| `PGLITE_DIR` | No | Source: `./data/pglite`; Docker: `/data/pglite` | PGlite database directory |

### Optional: External Services

The standard service uses `DATABASE_URL` for Postgres. Standalone mode keeps
PGlite. The documented single-container Docker path intentionally omits Redis
and S3; source-mode or custom deployments may still configure them:

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
