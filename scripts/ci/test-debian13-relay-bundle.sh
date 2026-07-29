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

for command_name in docker sha256sum tar mktemp node grep stat ln; do
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

container_node() {
    compose exec -T happy-relay /nodejs/bin/node "$@"
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
    # JavaScript is single-quoted so the shell cannot expand template literals.
    # shellcheck disable=SC2016
    container_node -e '
        const expected = process.argv[1] === "true";
        fetch("http://127.0.0.1:3005/v4/capabilities")
            .then(async response => {
                if (!response.ok) throw new Error(`capability request failed: ${response.status}`);
                const body = await response.json();
                if (body?.codex?.enabled !== expected || body?.codex?.protocolVersion !== 4) {
                    throw new Error(`unexpected v4 capabilities: ${JSON.stringify(body)}`);
                }
            })
            .catch(error => {
                console.error(error);
                process.exit(1);
            });
    ' "$expected"
}

assert_installer_rejects_secret_link() {
    link_kind="$1"
    case_root="$temporary_dir/link-$link_kind"
    sentinel="$case_root/sentinel"

    mkdir -p "$case_root"
    tar -xzf "$archive" -C "$case_root"

    if [[ "$link_kind" == "directory" ]]; then
        mkdir "$sentinel"
        chmod 0755 "$sentinel"
        ln -s "$sentinel" "$case_root/happy-relay/secrets"
    else
        mkdir "$case_root/happy-relay/secrets"
        printf '%064d\n' 0 > "$sentinel"
        chmod 0644 "$sentinel"
        ln -s "$sentinel" "$case_root/happy-relay/secrets/master-secret"
    fi

    sentinel_state_before="$(stat -c '%u:%g:%a' "$sentinel")"
    if installer_output="$("$case_root/happy-relay/install.sh" 2>&1)"; then
        die "installer accepted a symbolic $link_kind secret path"
    fi
    grep -Fq 'must not be a symbolic link' <<< "$installer_output" \
        || die "installer returned the wrong error for a symbolic $link_kind secret path"
    [[ "$(stat -c '%u:%g:%a' "$sentinel")" == "$sentinel_state_before" ]] \
        || die "installer modified the symbolic $link_kind target"
}

assert_installer_rejects_hardlinked_secret() {
    case_root="$temporary_dir/link-hard"
    sentinel="$case_root/sentinel"

    mkdir -p "$case_root"
    tar -xzf "$archive" -C "$case_root"
    mkdir "$case_root/happy-relay/secrets"
    printf '%064d\n' 0 > "$sentinel"
    chmod 0644 "$sentinel"
    ln "$sentinel" "$case_root/happy-relay/secrets/master-secret"

    sentinel_state_before="$(stat -c '%u:%g:%a:%h' "$sentinel")"
    if installer_output="$("$case_root/happy-relay/install.sh" 2>&1)"; then
        die "installer accepted a hard-linked master secret"
    fi
    grep -Fq 'must not have hard links' <<< "$installer_output" \
        || die "installer returned the wrong error for a hard-linked master secret"
    [[ "$(stat -c '%u:%g:%a:%h' "$sentinel")" == "$sentinel_state_before" ]] \
        || die "installer modified the hard-linked master secret target"
}

"$script_dir/verify-debian13-relay-bundle.sh" "$archive" "$expected_version"
assert_installer_rejects_secret_link directory
assert_installer_rejects_secret_link file
assert_installer_rejects_hardlinked_secret
tar -xzf "$archive" -C "$temporary_dir"

"$bundle_root/install.sh"

[[ "$(stat -c '%u:%g:%a' "$bundle_root/secrets/master-secret")" == "0:65532:440" ]] \
    || die "host master secret must be root:65532 mode 0440"

container_id="$(compose ps --quiet happy-relay)"
[[ -n "$container_id" ]] || die "relay container was not created"
[[ "$(docker inspect "$container_id" --format '{{.State.Health.Status}}')" == "healthy" ]] \
    || die "relay container is not healthy"
[[ "$(compose port happy-relay 3005)" == "127.0.0.1:3005" ]] \
    || die "default relay port must bind only to 127.0.0.1:3005"

container_node -e '
    fetch("http://127.0.0.1:3005/health")
        .then(response => {
            if (!response.ok) process.exit(1);
        })
        .catch(() => process.exit(1));
'
assert_capability false

container_node -e '
    const fs = require("node:fs");
    if (!fs.statSync("/data/pglite").isDirectory()) process.exit(1);
    fs.writeFileSync("/data/ci-persistence-marker", "persisted\n");
'

volume_name="$(docker inspect "$container_id" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
[[ "$volume_name" == "happy-relay_happy-data" ]] \
    || die "unexpected data volume: $volume_name"

secret_checksum_before="$(sha256sum "$bundle_root/secrets/master-secret" | awk '{print $1}')"
"$bundle_root/install.sh"
secret_checksum_after="$(sha256sum "$bundle_root/secrets/master-secret" | awk '{print $1}')"
[[ "$secret_checksum_before" == "$secret_checksum_after" ]] \
    || die "idempotent install changed the master secret"

"$bundle_root/relayctl.sh" restart
container_node -e '
    const fs = require("node:fs");
    if (fs.readFileSync("/data/ci-persistence-marker", "utf8") !== "persisted\n") process.exit(1);
'
assert_capability false

"$bundle_root/relayctl.sh" enable-v4
assert_capability true
"$bundle_root/relayctl.sh" disable-v4
assert_capability false

container_id="$(compose ps --quiet happy-relay)"
[[ "$(docker inspect "$container_id" --format '{{.HostConfig.ReadonlyRootfs}}')" == "true" ]] \
    || die "container root filesystem is not read-only"
[[ "$(docker inspect "$container_id" --format '{{.Config.User}}')" == "65532:65532" ]] \
    || die "container is not configured to run as the distroless nonroot user"
container_node -e '
    const fs = require("node:fs");
    if (typeof process.getuid !== "function" || process.getuid() !== 65532) process.exit(1);
    const secret = fs.statSync("/run/secrets/happy_master_secret");
    if (secret.uid !== 0 || secret.gid !== 65532 || (secret.mode & 0o777) !== 0o440) process.exit(1);
'
docker inspect "$container_id" --format '{{json .HostConfig.CapDrop}}' | grep -q '"ALL"' \
    || die "container does not drop all Linux capabilities"
docker inspect "$container_id" --format '{{json .HostConfig.SecurityOpt}}' | grep -q 'no-new-privileges:true' \
    || die "container does not enable no-new-privileges"
docker inspect "$container_id" --format '{{json .HostConfig.Tmpfs}}' | grep -q '"/tmp"' \
    || die "container does not provide a writable /tmp tmpfs"

if docker inspect "$container_id" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -Eq '^(HANDY_MASTER_SECRET|HAPPY_RELAY_MASTER_SECRET)='; then
    die "master secret leaked into the container environment"
fi

container_node -e '
    const fs = require("node:fs");
    for (const forbidden of [
        "/opt/happy-server/webapp/index.html",
        "/bin/sh",
        "/bin/bash",
        "/busybox/sh",
        "/usr/bin/apt",
        "/usr/bin/apt-get",
        "/usr/bin/perl",
        "/usr/bin/npm",
        "/usr/local/bin/npm",
        "/usr/local/lib/node_modules/npm",
    ]) {
        if (fs.existsSync(forbidden)) process.exit(1);
    }
    if (fs.readFileSync("/data/ci-persistence-marker", "utf8") !== "persisted\n") process.exit(1);
'

echo "Verified install, idempotency, persistence, security, and v4 toggling for Happy relay $expected_version"
