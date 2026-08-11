#!/usr/bin/env bash

set -Eeuo pipefail

die() {
    echo "Error: $*" >&2
    exit 1
}

image="${1:-}"

[[ "${GITHUB_ACTIONS:-}" == "true" ]] \
    || die "this destructive container lifecycle test is restricted to an ephemeral GitHub Actions runner"
[[ -n "$image" ]] || die "usage: test-standalone-server-container.sh <image>"

for command_name in docker grep mktemp node seq sleep stat sudo; do
    command -v "$command_name" >/dev/null 2>&1 \
        || die "required command not found: $command_name"
done

docker image inspect "$image" >/dev/null 2>&1 \
    || die "standalone image does not exist: $image"

run_suffix="${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-0}-$$"
container_name="happy-standalone-ci-$run_suffix"
volume_name="happy-standalone-data-$run_suffix"
temporary_dir="$(mktemp -d)"
secret_file="$temporary_dir/master-secret"
host_base_url="http://127.0.0.1:3005"
health_attempts=180

cleanup() {
    docker rm --force "$container_name" >/dev/null 2>&1 || true
    docker volume rm --force "$volume_name" >/dev/null 2>&1 || true
    sudo rm -rf -- "$temporary_dir"
}
trap cleanup EXIT

printf '%064d\n' 0 > "$secret_file"
sudo chown root:65532 "$secret_file"
sudo chmod 0440 "$secret_file"
docker volume create "$volume_name" >/dev/null

container_node() {
    docker exec "$container_name" /nodejs/bin/node "$@"
}

wait_for_healthy() {
    local health=""
    for _ in $(seq 1 "$health_attempts"); do
        health="$(docker inspect "$container_name" --format '{{.State.Health.Status}}')"
        if [[ "$health" == "healthy" ]]; then
            return 0
        fi
        if [[ "$health" == "unhealthy" ]]; then
            docker logs "$container_name" >&2 || true
            die "standalone container became unhealthy"
        fi
        sleep 1
    done
    docker logs "$container_name" >&2 || true
    die "standalone container did not become healthy; last status: $health"
}

start_container() {
    docker run --detach \
        --name "$container_name" \
        --init \
        --publish 127.0.0.1:3005:3005 \
        --volume "$volume_name:/data" \
        --mount "type=bind,src=$secret_file,dst=/run/secrets/happy_master_secret,readonly" \
        --read-only \
        --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m \
        --cap-drop ALL \
        --security-opt no-new-privileges:true \
        --env PUBLIC_URL="$host_base_url" \
        "$image" >/dev/null
    wait_for_healthy
}

assert_container_security() {
    [[ "$(docker inspect "$container_name" --format '{{.HostConfig.ReadonlyRootfs}}')" == "true" ]] \
        || die "container root filesystem is not read-only"
    [[ "$(docker inspect "$container_name" --format '{{.Config.User}}')" == "65532:65532" ]] \
        || die "container service process is not configured as uid 65532"
    [[ "$(docker port "$container_name" 3005/tcp)" == "127.0.0.1:3005" ]] \
        || die "standalone port is not bound to the expected loopback host port"
    [[ "$(docker inspect "$container_name" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')" == "$volume_name" ]] \
        || die "container does not use the expected persistent /data volume"
    docker inspect "$container_name" --format '{{json .HostConfig.CapDrop}}' | grep -q '"ALL"' \
        || die "container does not drop all Linux capabilities"
    docker inspect "$container_name" --format '{{json .HostConfig.SecurityOpt}}' | grep -q 'no-new-privileges:true' \
        || die "container does not enable no-new-privileges"
    docker inspect "$container_name" --format '{{json .HostConfig.Tmpfs}}' | grep -q '"/tmp"' \
        || die "container does not provide a writable /tmp tmpfs"

    if docker inspect "$container_name" --format '{{range .Config.Env}}{{println .}}{{end}}' \
        | grep -Eq '^(HANDY_MASTER_SECRET|DATABASE_URL|REDIS_URL|S3_HOST)='; then
        die "standalone container leaks a secret or unexpectedly requires an external service"
    fi

    container_node -e '
        const fs = require("node:fs");
        if (typeof process.getuid !== "function" || process.getuid() !== 65532) process.exit(1);
        const secret = fs.statSync("/run/secrets/happy_master_secret");
        if (secret.uid !== 0 || secret.gid !== 65532 || (secret.mode & 0o777) !== 0o440) process.exit(1);
        if (!fs.statSync("/data/pglite").isDirectory()) process.exit(1);
        for (const forbidden of [
            "/opt/happy-server/webapp/index.html",
            "/bin/sh",
            "/bin/bash",
            "/usr/bin/apt",
            "/usr/bin/npm",
        ]) {
            if (fs.existsSync(forbidden)) process.exit(1);
        }
    '
}

assert_host_health() {
    # shellcheck disable=SC2016
    HOST_BASE_URL="$host_base_url" node -e '
        async function main() {
            const response = await fetch(new URL("/health", process.env.HOST_BASE_URL));
            if (!response.ok) throw new Error(`host health returned ${response.status}`);
        }

        main().catch(error => {
            console.error(error);
            process.exit(1);
        });
    '
}

assert_host_attachment() {
    local phase="$1"

    docker exec "$container_name" /nodejs/bin/node -e \
        'process.stdout.write(require("node:fs").readFileSync("/data/ci-standalone-state.json"))' \
        > "$temporary_dir/ci-standalone-state.json"

    # shellcheck disable=SC2016
    HOST_BASE_URL="$host_base_url" PHASE="$phase" STATE_PATH="$temporary_dir/ci-standalone-state.json" node -e '
        const fs = require("node:fs");

        const state = JSON.parse(fs.readFileSync(process.env.STATE_PATH, "utf8"));
        const baseUrl = new URL(process.env.HOST_BASE_URL);

        function expectHostAttachmentUrl(value, label) {
            if (typeof value !== "string") throw new Error(`${label} is missing`);
            const url = new URL(value);
            if (url.origin !== baseUrl.origin) throw new Error(`${label} is not a host attachment URL`);
            return url;
        }

        async function request(path, { token, method = "GET", body } = {}) {
            const response = await fetch(new URL(path, baseUrl), {
                method,
                headers: {
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    ...(body ? { "Content-Type": "application/json" } : {}),
                    "X-Happy-Client": "cli/ci",
                },
                body: body ? JSON.stringify(body) : undefined,
            });
            const text = await response.text();
            if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}`);
            return text ? JSON.parse(text) : null;
        }

        async function main() {
            const payload = Buffer.from(state.payload, "base64");
            if (process.env.PHASE === "before-restart") {
                const uploadResponse = await fetch(expectHostAttachmentUrl(state.uploadUrl, "upload URL"), {
                    method: "PUT",
                    headers: {
                        Authorization: `Bearer ${state.token}`,
                        "Content-Type": "application/octet-stream",
                        "X-Happy-Client": "cli/ci",
                    },
                    body: payload,
                });
                if (!uploadResponse.ok) throw new Error(`attachment upload returned ${uploadResponse.status}`);
            }

            const download = await request(
                `/v1/sessions/${state.sessionId}/attachments/request-download`,
                {
                    token: state.token,
                    method: "POST",
                    body: { ref: state.ref },
                },
            );
            const downloadResponse = await fetch(expectHostAttachmentUrl(download.downloadUrl, "download URL"), {
                headers: {
                    Authorization: `Bearer ${state.token}`,
                    "X-Happy-Client": "cli/ci",
                },
            });
            if (!downloadResponse.ok) {
                throw new Error(`attachment download returned ${downloadResponse.status}`);
            }
            const actual = Buffer.from(await downloadResponse.arrayBuffer());
            if (!actual.equals(payload)) throw new Error("host attachment bytes changed");
        }

        main().catch(error => {
            console.error(error);
            process.exit(1);
        });
    '
}

create_persistent_state() {
    # JavaScript is single-quoted so the shell cannot expand template literals.
    # shellcheck disable=SC2016
    container_node -e '
        const fs = require("node:fs");
        const nacl = require("tweetnacl");

        async function request(path, { token, method = "GET", body } = {}) {
            const response = await fetch(`http://127.0.0.1:3005${path}`, {
                method,
                headers: {
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    ...(body ? { "Content-Type": "application/json" } : {}),
                    "X-Happy-Client": "cli/ci",
                },
                body: body ? JSON.stringify(body) : undefined,
            });
            const text = await response.text();
            if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}`);
            return text ? JSON.parse(text) : null;
        }

        async function authenticate(secretKey) {
            const keypair = secretKey
                ? nacl.sign.keyPair.fromSecretKey(Buffer.from(secretKey, "base64"))
                : nacl.sign.keyPair();
            const challenge = nacl.randomBytes(32);
            const signature = nacl.sign.detached(challenge, keypair.secretKey);
            const auth = await request("/v1/auth", {
                method: "POST",
                body: {
                    publicKey: Buffer.from(keypair.publicKey).toString("base64"),
                    challenge: Buffer.from(challenge).toString("base64"),
                    signature: Buffer.from(signature).toString("base64"),
                },
            });
            if (typeof auth.token !== "string" || auth.token.length === 0) {
                throw new Error("standalone authentication did not return a token");
            }
            return { keypair, token: auth.token };
        }

        async function main() {
            const { keypair, token } = await authenticate();
            const tag = `codex-gateway-root-v1-standalone-ci-${Date.now()}`;
            const created = await request("/v1/sessions", {
                token,
                method: "POST",
                body: {
                    tag,
                    metadata: "ci-standalone-encrypted-metadata",
                    agentState: null,
                    dataEncryptionKey: Buffer.from([0, 1, 2, 127, 128, 254, 255]).toString("base64"),
                },
            });
            const sessionId = created.session?.id;
            if (typeof sessionId !== "string" || sessionId.length === 0) {
                throw new Error("standalone session was not created");
            }

            const payload = Buffer.from([0, 255, 1, 254, 2, 253, 3, 252]);
            const upload = await request(`/v1/sessions/${sessionId}/attachments/request-upload`, {
                token,
                method: "POST",
                body: { filename: "ci-payload.enc", size: payload.length },
            });
            if (upload.method !== "PUT" || typeof upload.ref !== "string" || typeof upload.uploadUrl !== "string") {
                throw new Error("standalone local attachment upload contract is unavailable");
            }

            fs.writeFileSync("/data/ci-standalone-state.json", JSON.stringify({
                accountSecretKey: Buffer.from(keypair.secretKey).toString("base64"),
                token,
                sessionId,
                ref: upload.ref,
                uploadUrl: upload.uploadUrl,
                payload: payload.toString("base64"),
            }), { mode: 0o600 });
        }

        main().catch(error => {
            console.error(error);
            process.exit(1);
        });
    '
}

refresh_persistent_state_token() {
    # JavaScript is single-quoted so the shell cannot expand template literals.
    # shellcheck disable=SC2016
    container_node -e '
        const fs = require("node:fs");
        const nacl = require("tweetnacl");

        async function authenticate(secretKey) {
            const keypair = nacl.sign.keyPair.fromSecretKey(Buffer.from(secretKey, "base64"));
            const challenge = nacl.randomBytes(32);
            const signature = nacl.sign.detached(challenge, keypair.secretKey);
            const response = await fetch("http://127.0.0.1:3005/v1/auth", {
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
            if (!response.ok) throw new Error(`authentication after restart returned ${response.status}`);
            const auth = await response.json();
            if (typeof auth.token !== "string" || auth.token.length === 0) {
                throw new Error("authentication after restart did not return a token");
            }
            return auth.token;
        }

        async function main() {
            const state = JSON.parse(fs.readFileSync("/data/ci-standalone-state.json", "utf8"));
            state.token = await authenticate(state.accountSecretKey);
            fs.writeFileSync("/data/ci-standalone-state.json", JSON.stringify(state), { mode: 0o600 });
        }

        main().catch(error => {
            console.error(error);
            process.exit(1);
        });
    '
}

[[ "$(docker image inspect "$image" --format '{{.Config.User}}')" == "65532:65532" ]] \
    || die "standalone image does not default to the nonroot user"

start_container
assert_container_security
assert_host_health
create_persistent_state
assert_host_attachment before-restart

docker stop "$container_name" >/dev/null
docker rm "$container_name" >/dev/null

start_container
assert_container_security
assert_host_health
refresh_persistent_state_token
assert_host_attachment after-restart

echo "Verified standalone host health, PGlite migration, attachment persistence, restart, and container security"
