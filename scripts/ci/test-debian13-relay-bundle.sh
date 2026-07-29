#!/usr/bin/env bash

set -Eeuo pipefail

die() {
    echo "Error: $*" >&2
    exit 1
}

archive="${1:-}"
expected_version="${2:-}"

[[ "${GITHUB_ACTIONS:-}" == "true" ]] \
    || die "this destructive lifecycle test is restricted to an ephemeral GitHub Actions runner"
[[ -f "$archive" ]] || die "archive does not exist: $archive"
[[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || die "expected version must be stable X.Y.Z"

for command_name in docker sha256sum tar mktemp node grep; do
    command -v "$command_name" >/dev/null 2>&1 || die "required command not found: $command_name"
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_dir="$(mktemp -d)"
bundle_root="$temporary_dir/happy-relay"

compose() {
    docker compose \
        --project-directory "$bundle_root" \
        --env-file "$bundle_root/.env" \
        --file "$bundle_root/compose.yaml" \
        "$@"
}

cleanup() {
    if [[ -f "$bundle_root/.env" && -f "$bundle_root/compose.yaml" ]]; then
        compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    fi
    rm -rf "$temporary_dir"
}
trap cleanup EXIT

assert_capability() {
    expected="$1"
    response="$(compose exec -T happy-relay \
        curl --fail --silent --show-error http://127.0.0.1:3005/v4/capabilities)"
    node -e '
        const body = JSON.parse(process.argv[1]);
        const expected = process.argv[2] === "true";
        if (body?.codex?.enabled !== expected || body?.codex?.protocolVersion !== 4) {
            throw new Error(`unexpected v4 capabilities: ${JSON.stringify(body)}`);
        }
    ' "$response" "$expected"
}

"$script_dir/verify-debian13-relay-bundle.sh" "$archive" "$expected_version"
tar -xzf "$archive" -C "$temporary_dir"

"$bundle_root/install.sh"

container_id="$(compose ps --quiet happy-relay)"
[[ -n "$container_id" ]] || die "relay container was not created"
[[ "$(docker inspect "$container_id" --format '{{.State.Health.Status}}')" == "healthy" ]] \
    || die "relay container is not healthy"
[[ "$(compose port happy-relay 3005)" == "127.0.0.1:3005" ]] \
    || die "default relay port must bind only to 127.0.0.1:3005"

compose exec -T happy-relay curl --fail --silent --show-error \
    http://127.0.0.1:3005/health >/dev/null
assert_capability false

compose exec -T happy-relay test -d /data/pglite
compose exec -T happy-relay sh -c 'printf "%s\n" persisted > /data/ci-persistence-marker'

volume_name="$(docker inspect "$container_id" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
[[ "$volume_name" == "happy-relay_happy-data" ]] \
    || die "unexpected data volume: $volume_name"

secret_checksum_before="$(sha256sum "$bundle_root/secrets/master-secret" | awk '{print $1}')"
"$bundle_root/install.sh"
secret_checksum_after="$(sha256sum "$bundle_root/secrets/master-secret" | awk '{print $1}')"
[[ "$secret_checksum_before" == "$secret_checksum_after" ]] \
    || die "idempotent install changed the master secret"

"$bundle_root/relayctl.sh" restart
compose exec -T happy-relay grep -Fxq persisted /data/ci-persistence-marker
assert_capability false

"$bundle_root/relayctl.sh" enable-v4
assert_capability true
"$bundle_root/relayctl.sh" disable-v4
assert_capability false

container_id="$(compose ps --quiet happy-relay)"
[[ "$(docker inspect "$container_id" --format '{{.HostConfig.ReadonlyRootfs}}')" == "true" ]] \
    || die "container root filesystem is not read-only"
[[ "$(docker inspect "$container_id" --format '{{.Config.User}}')" == "node" ]] \
    || die "container is not configured to run as the node user"
[[ "$(compose exec -T happy-relay id -u)" != "0" ]] \
    || die "relay process is running as root"
docker inspect "$container_id" --format '{{json .HostConfig.CapDrop}}' | grep -q '"ALL"' \
    || die "container does not drop all Linux capabilities"
docker inspect "$container_id" --format '{{json .HostConfig.SecurityOpt}}' | grep -q 'no-new-privileges:true' \
    || die "container does not enable no-new-privileges"
docker inspect "$container_id" --format '{{json .HostConfig.Tmpfs}}' | grep -q '"/tmp"' \
    || die "container does not provide a writable /tmp tmpfs"

if docker inspect "$container_id" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -q '^HANDY_MASTER_SECRET='; then
    die "master secret leaked into the container environment"
fi

compose exec -T happy-relay test ! -e /opt/happy-server/webapp/index.html
compose exec -T happy-relay grep -Fxq persisted /data/ci-persistence-marker

echo "Verified install, idempotency, persistence, security, and v4 toggling for Happy relay $expected_version"
