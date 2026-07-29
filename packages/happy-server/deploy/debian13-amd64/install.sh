#!/bin/sh

set -eu

umask 077

script_dir="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
version_file="$script_dir/VERSION"
compose_file="$script_dir/compose.yaml"
env_file="$script_dir/.env"
secret_dir="$script_dir/secrets"
secret_file="$secret_dir/master-secret"
volume_name="happy-relay_happy-data"

die() {
    echo "Error: $*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

compose() {
    docker compose \
        --project-directory "$script_dir" \
        --env-file "$env_file" \
        --file "$compose_file" \
        "$@"
}

validate_secret() {
    secret_value="$(tr -d '\r\n' < "$secret_file")"
    case "$secret_value" in
        ""|*[!0-9a-fA-F]*)
            unset secret_value
            die "secrets/master-secret must contain exactly 64 hexadecimal characters"
            ;;
    esac
    if [ "${#secret_value}" -ne 64 ]; then
        unset secret_value
        die "secrets/master-secret must contain exactly 64 hexadecimal characters"
    fi
    unset secret_value
}

write_env_file() {
    image="$1"
    temporary_env="$(mktemp "$script_dir/.env.tmp.XXXXXX")"

    if [ -f "$env_file" ]; then
        awk -v replacement="HAPPY_RELAY_IMAGE=$image" '
            BEGIN { replaced = 0 }
            /^HAPPY_RELAY_IMAGE=/ {
                if (!replaced) print replacement
                replaced = 1
                next
            }
            { print }
            END { if (!replaced) print replacement }
        ' "$env_file" > "$temporary_env"
    else
        sed "s/__VERSION__/$version/g" "$script_dir/env.example" > "$temporary_env"
    fi

    chmod 600 "$temporary_env"
    mv "$temporary_env" "$env_file"
}

wait_for_health() {
    attempt=1
    while [ "$attempt" -le 60 ]; do
        if compose exec -T happy-relay \
            curl --fail --silent --show-error http://127.0.0.1:3005/health >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
        attempt=$((attempt + 1))
    done

    compose ps >&2 || true
    compose logs --tail 100 happy-relay >&2 || true
    die "relay did not become healthy within 120 seconds"
}

[ "$(uname -s)" = "Linux" ] || die "this package supports Linux hosts only"
[ "$(uname -m)" = "x86_64" ] || die "this package supports x86_64/amd64 hosts only"

require_command docker
require_command sha256sum
require_command sed
require_command awk
require_command mktemp
require_command grep
require_command od

docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose)"
docker info >/dev/null 2>&1 || die "cannot access the Docker daemon"

[ -f "$version_file" ] || die "VERSION is missing"
version="$(tr -d '\r\n' < "$version_file")"
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "VERSION must be stable X.Y.Z"

image="happy-relay-server:${version}-debian13-amd64"
image_archive="$script_dir/image/happy-relay-server-${version}-debian13-amd64.image.tar.gz"

[ -f "$script_dir/SHA256SUMS" ] || die "SHA256SUMS is missing"
[ -f "$image_archive" ] || die "Docker image archive is missing: $image_archive"

echo "Verifying release checksums..."
(cd "$script_dir" && sha256sum --check SHA256SUMS)

mkdir -p "$secret_dir"
chmod 700 "$secret_dir"

if [ -f "$secret_file" ]; then
    validate_secret
    chmod 600 "$secret_file"
else
    if docker volume inspect "$volume_name" >/dev/null 2>&1; then
        die "existing data volume $volume_name found without its master secret; restore secrets/master-secret before continuing"
    fi

    temporary_secret="$(mktemp "$secret_dir/master-secret.tmp.XXXXXX")"
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$temporary_secret"
    chmod 600 "$temporary_secret"
    mv "$temporary_secret" "$secret_file"
    validate_secret
    echo "Generated a new relay master secret in secrets/master-secret. Back it up with the data volume."
fi

write_env_file "$image"

echo "Loading $image..."
docker image load --input "$image_archive" >/dev/null
[ "$(docker image inspect "$image" --format '{{.Architecture}}')" = "amd64" ] \
    || die "loaded image is not amd64"
[ "$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.version" }}')" = "$version" ] \
    || die "loaded image version label does not match VERSION"

compose config --quiet
compose up --detach
wait_for_health

published_address="$(compose port happy-relay 3005 2>/dev/null || true)"
echo "Happy relay $version is healthy at ${published_address:-the configured address}."
echo "This package contains the relay API only; it does not include a Web App."
