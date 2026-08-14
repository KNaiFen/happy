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

There are three supported self-hosting paths:

- install `happy` and `happy-server-self-host` in the same global npm root, then
  run `happy server` for a CLI-managed local PGlite relay;
- build the repository-root `Dockerfile.server` for a portable, single-container
  PGlite deployment on the current host architecture;
- use the versioned Debian 13 amd64 Relay bundle for an offline, prepackaged
  release artifact with installer and lifecycle tooling.

None of these paths requires Postgres, Redis, or S3. The container and Debian
paths store PGlite and local encrypted attachments in one `/data` volume and read
the master secret from a narrowly mounted file.

### CLI-managed local relay

For a local relay owned by the current user account, install both npm packages in
one command so they share the same npm global root:

```bash
npm install -g happy happy-server-self-host
happy server
```

The CLI first uses normal Node package resolution and then resolves the sibling
`happy-server-self-host` package beside the running global `happy` package. It does
not use `NODE_PATH`, `npm root -g`, or a Docker daemon. This global installation
path does not require a repository checkout; the lower-priority source fallback
remains available only for development diagnostics.
The relay stores PGlite and local encrypted attachments under the CLI's Happy data
directory; use the Docker or Debian path when you need a host-managed service.

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
| `ACCOUNT_DELETION_LEGACY_DIRECT_UPLOADS_DRAINED_AT` | Every S3 deployment | - | ISO 8601 UTC time when all pre-proxy direct-upload Server instances stopped issuing URLs; use `1970-01-01T00:00:00Z` only for a new S3 deployment that never ran an old issuer. Account deletion stays unavailable until this is set and completes no earlier than 16 minutes after it |
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
`sessions/<sessionId>/attachments/<id>.enc`. The Server proxies every current
attachment and profile-object transfer; it does not return a public S3 URL or a
new direct S3 capability. Keep the bucket private. A public bucket, an old
direct URL, or an independently issued object-store credential cannot be
revoked by the application after account deletion.

**1. Block anonymous/public access.** Apply this in the object store before
serving traffic:

```bash
# AWS CLI
aws s3api put-public-access-block --bucket happy-blobs \
  --public-access-block-configuration '{
    "BlockPublicAcls": true,
    "IgnorePublicAcls": true,
    "BlockPublicPolicy": true,
    "RestrictPublicBuckets": true
  }'

# MinIO
mc anonymous set none myminio/happy-blobs
```

**2. Configure retention and backup ownership.** Account deletion immediately
locks access, durably retries primary-object cleanup, and waits out the legacy
direct-upload capability window before its final sweep. Every S3 deployment must
set `ACCOUNT_DELETION_LEGACY_DIRECT_UPLOADS_DRAINED_AT`. During an upgrade, set
the actual UTC drain time only after all old Server instances are drained; do
not invent a timestamp during the rolling rollout. A new S3 deployment that has
never run an old direct-upload issuer may explicitly use
`1970-01-01T00:00:00Z` to record that fact.
The Server deletes every reachable version and delete marker in its configured
primary bucket, but it cannot erase replicas, backup snapshots, object-store
audit logs, container logs, or third-party copies maintained by a self-hosted
deployment. The deployer must set and verify their replica, lifecycle, backup,
and log-retention rules. If you want the Happy-hosted retention target, retain
backup and operational-log data for no more than three days. This repository
cannot establish that target for any deployment; retain the operating evidence
with the deployment records.

**3. Server-side encryption (defense-in-depth).** Blobs are already
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
`<DATA_DIR>/files/sessions/<sessionId>/attachments/`. Account deletion removes
the configured primary data, but a self-hosted operator remains responsible for
filesystem snapshots, backups, and host/container logs.

## License

MIT - Use it, modify it, deploy it anywhere.
