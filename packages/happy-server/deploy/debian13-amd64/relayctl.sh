#!/bin/sh

set -eu

umask 077

script_dir="$(CDPATH= cd "$(dirname "$0")" && pwd)"
compose_file="$script_dir/compose.yaml"
env_file="$script_dir/.env"
secret_file="$script_dir/secrets/master-secret"

die() {
    echo "Error: $*" >&2
    exit 1
}

compose() {
    docker compose \
        --project-directory "$script_dir" \
        --env-file "$env_file" \
        --file "$compose_file" \
        "$@"
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

set_env_value() {
    key="$1"
    value="$2"
    temporary_env="$(mktemp "$script_dir/.env.tmp.XXXXXX")"

    awk -v key="$key" -v replacement="$key=$value" '
        BEGIN { replaced = 0 }
        index($0, key "=") == 1 {
            if (!replaced) print replacement
            replaced = 1
            next
        }
        { print }
        END { if (!replaced) print replacement }
    ' "$env_file" > "$temporary_env"

    chmod 600 "$temporary_env"
    mv "$temporary_env" "$env_file"
}

apply_v4_state() {
    desired="$1"
    set_env_value HAPPY_CODEX_SYNC_V4_ENABLED "$desired"
    compose up --detach
    wait_for_health
    echo "HAPPY_CODEX_SYNC_V4_ENABLED=$desired"
}

usage() {
    cat <<'EOF'
Usage: ./relayctl.sh <command>

Commands:
  start       Start or update the relay and wait for database health
  stop        Stop the relay without deleting its data volume
  restart     Restart the relay and wait for database health
  status      Show container status
  logs        Show relay logs (extra docker compose logs flags are accepted)
  health      Query the deep database health endpoint
  enable-v4   Enable Codex Sync v4 after the coordinated client cutover
  disable-v4  Disable Codex Sync v4 without deleting data
EOF
}

command -v docker >/dev/null 2>&1 || die "required command not found: docker"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose)"
docker info >/dev/null 2>&1 || die "cannot access the Docker daemon"
[ -f "$compose_file" ] || die "compose.yaml is missing"
[ -f "$env_file" ] || die ".env is missing; run ./install.sh first"
[ -r "$secret_file" ] || die "secrets/master-secret is missing; restore it before starting the relay"

command_name="${1:-}"
if [ "$#" -gt 0 ]; then
    shift
fi

case "$command_name" in
    start)
        [ "$#" -eq 0 ] || die "start does not accept additional arguments"
        compose up --detach
        wait_for_health
        ;;
    stop)
        [ "$#" -eq 0 ] || die "stop does not accept additional arguments"
        compose stop
        ;;
    restart)
        [ "$#" -eq 0 ] || die "restart does not accept additional arguments"
        compose restart
        wait_for_health
        ;;
    status)
        [ "$#" -eq 0 ] || die "status does not accept additional arguments"
        compose ps
        ;;
    logs)
        compose logs "$@" happy-relay
        ;;
    health)
        [ "$#" -eq 0 ] || die "health does not accept additional arguments"
        compose exec -T happy-relay \
            curl --fail --silent --show-error http://127.0.0.1:3005/health
        printf '\n'
        ;;
    enable-v4)
        [ "$#" -eq 0 ] || die "enable-v4 does not accept additional arguments"
        echo "Enabling v4 assumes matching App/CLI versions and no running legacy Codex turn."
        apply_v4_state true
        ;;
    disable-v4)
        [ "$#" -eq 0 ] || die "disable-v4 does not accept additional arguments"
        apply_v4_state false
        ;;
    -h|--help|help|"")
        usage
        ;;
    *)
        usage >&2
        die "unknown command: $command_name"
        ;;
esac
