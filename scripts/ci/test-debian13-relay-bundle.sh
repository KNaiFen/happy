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

create_encrypted_business_state() {
    container_node -e '
        const nacl = require("tweetnacl");

        async function request(path, options = {}) {
            const response = await fetch(`http://127.0.0.1:3005${path}`, options);
            const body = await response.json();
            if (!response.ok) {
                throw new Error(`${options.method ?? "GET"} ${path} returned ${response.status}`);
            }
            return body;
        }

        async function main() {
            const keypair = nacl.sign.keyPair();
            const challenge = nacl.randomBytes(32);
            const signature = nacl.sign.detached(challenge, keypair.secretKey);
            const auth = await request("/v1/auth", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Happy-Client": "cli/ci",
                },
                body: JSON.stringify({
                    publicKey: Buffer.from(keypair.publicKey).toString("base64"),
                    challenge: Buffer.from(challenge).toString("base64"),
                    signature: Buffer.from(signature).toString("base64"),
                }),
            });
            if (typeof auth.token !== "string" || auth.token.length === 0) {
                throw new Error("relay authentication did not return a token");
            }

            const authorization = {
                Authorization: `Bearer ${auth.token}`,
                "Content-Type": "application/json",
                "X-Happy-Client": "cli/ci",
            };
            const machineId = `ci-byte-machine-${Date.now()}`;
            const sessionTag = `ci-byte-session-${Date.now()}`;
            const machineKey = Buffer.from([0, 1, 2, 127, 128, 254, 255]).toString("base64");
            const sessionKey = Buffer.from([255, 254, 128, 127, 2, 1, 0]).toString("base64");

            const machine = await request("/v1/machines", {
                method: "POST",
                headers: authorization,
                body: JSON.stringify({
                    id: machineId,
                    metadata: "ci-encrypted-machine-metadata",
                    dataEncryptionKey: machineKey,
                }),
            });
            if (
                machine.machine?.id !== machineId
                || machine.machine?.dataEncryptionKey !== machineKey
            ) {
                throw new Error("machine create did not round-trip its encrypted key");
            }

            const session = await request("/v1/sessions", {
                method: "POST",
                headers: authorization,
                body: JSON.stringify({
                    tag: sessionTag,
                    metadata: "ci-encrypted-session-metadata",
                    agentState: null,
                    dataEncryptionKey: sessionKey,
                }),
            });
            if (
                typeof session.session?.id !== "string"
                || session.session?.dataEncryptionKey !== sessionKey
            ) {
                throw new Error("session create did not round-trip its encrypted key");
            }

            const machines = await request("/v1/machines", {
                headers: authorization,
            });
            const sessions = await request("/v1/sessions", {
                headers: authorization,
            });
            if (
                !Array.isArray(machines)
                || !machines.some(item => (
                    item.id === machineId
                    && item.dataEncryptionKey === machineKey
                ))
            ) {
                throw new Error("machine list did not return the encrypted key");
            }
            if (
                !Array.isArray(sessions.sessions)
                || !sessions.sessions.some(item => (
                    item.id === session.session.id
                    && item.dataEncryptionKey === sessionKey
                ))
            ) {
                throw new Error("session list did not return the encrypted key");
            }

            process.stdout.write(JSON.stringify({
                token: auth.token,
                machineId,
                machineKey,
                sessionId: session.session.id,
                sessionKey,
            }));
        }

        main().catch(error => {
            console.error(error);
            process.exit(1);
        });
    '
}

assert_encrypted_business_state() {
    state="$1"
    container_node -e '
        async function request(path, token) {
            const response = await fetch(`http://127.0.0.1:3005${path}`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "X-Happy-Client": "cli/ci",
                },
            });
            if (!response.ok) {
                throw new Error(`GET ${path} returned ${response.status}`);
            }
            return response.json();
        }

        async function main() {
            const expected = JSON.parse(process.argv[1]);
            const machines = await request("/v1/machines", expected.token);
            const sessions = await request("/v1/sessions", expected.token);
            if (
                !Array.isArray(machines)
                || !machines.some(item => (
                    item.id === expected.machineId
                    && item.dataEncryptionKey === expected.machineKey
                ))
            ) {
                throw new Error("persisted machine key is missing or changed");
            }
            if (
                !Array.isArray(sessions.sessions)
                || !sessions.sessions.some(item => (
                    item.id === expected.sessionId
                    && item.dataEncryptionKey === expected.sessionKey
                ))
            ) {
                throw new Error("persisted session key is missing or changed");
            }
        }

        main().catch(error => {
            console.error(error);
            process.exit(1);
        });
    ' "$state"
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
business_state="$(create_encrypted_business_state)"

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
assert_encrypted_business_state "$business_state"

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

echo "Verified install, encrypted business state, persistence, security, and v4 toggling for Happy relay $expected_version"
