#!/bin/sh

set -eu

umask 077

script_dir="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
compose_file="$script_dir/compose.yaml"
env_file="$script_dir/.env"
secret_file="$script_dir/secrets/master-secret"
secret_dir="$script_dir/secrets"

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
        container_id="$(compose ps --quiet happy-relay 2>/dev/null || true)"
        health_status=""
        if [ -n "$container_id" ]; then
            health_status="$(docker inspect "$container_id" --format '{{.State.Health.Status}}' 2>/dev/null || true)"
        fi
        if [ "$health_status" = "healthy" ]; then
            return 0
        fi
        sleep 2
        attempt=$((attempt + 1))
    done

    compose ps >&2 || true
    compose logs --tail 100 happy-relay >&2 || true
    die "relay did not become healthy within 120 seconds"
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
  storage-health  Read database maintenance and capacity status
EOF
}

command -v docker >/dev/null 2>&1 || die "required command not found: docker"
command -v stat >/dev/null 2>&1 || die "required command not found: stat"
[ "$(id -u)" = "0" ] || die "run ./relayctl.sh as root"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose)"
docker info >/dev/null 2>&1 || die "cannot access the Docker daemon"
[ -f "$compose_file" ] || die "compose.yaml is missing"
[ -f "$env_file" ] || die ".env is missing; run ./install.sh first"
[ ! -L "$secret_dir" ] || die "secrets must not be a symbolic link"
[ -d "$secret_dir" ] || die "secrets is missing; run ./install.sh first"
[ "$(stat -c '%u:%g:%a' "$secret_dir")" = "0:0:700" ] \
    || die "secrets must be root:root mode 0700; run ./install.sh to repair it"
[ ! -L "$secret_file" ] || die "secrets/master-secret must not be a symbolic link"
[ -f "$secret_file" ] || die "secrets/master-secret is missing; restore it before starting the relay"
[ "$(stat -c '%u:%g:%a:%h' "$secret_file")" = "0:65532:440:1" ] \
    || die "secrets/master-secret must be root:65532 mode 0440 with one link; run ./install.sh to repair it"

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
            /nodejs/bin/node -e '
                fetch("http://127.0.0.1:3005/health")
                    .then(async response => {
                        process.stdout.write(await response.text());
                        if (!response.ok) process.exit(1);
                    })
                    .catch(error => {
                        console.error(error);
                        process.exit(1);
                    });
            '
        printf '\n'
        ;;
    storage-health)
        [ "$#" -eq 0 ] || die "storage-health does not accept additional arguments"
        compose exec -T happy-relay /nodejs/bin/node -e '
            const fs = require("node:fs");
            const path = require("node:path");
            try {
                const status = JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.PGLITE_DIR), "pglite-maintenance.json"), "utf8"));
                const reasons = new Set(["disabled", "disk-low", "disk-critical", "oversize", "slow", "sql-failed", "maintenance-overdue", "checkpoint-overdue", "growth"]);
                const validNumber = value => Number.isFinite(value) && value >= 0;
                if (status.version !== 1 || typeof status.enabled !== "boolean"
                    || !Number.isInteger(status.processId) || status.processId <= 0
                    || !["healthy", "warning", "critical"].includes(status.severity)
                    || !Array.isArray(status.reasons) || status.reasons.some(reason => !reasons.has(reason))
                    || !Array.isArray(status.tables) || !status.tables.length
                    || ![status.startedAt, status.sampledAt, status.relationBytes, status.walBytes, status.availableBytes, status.availableRatio].every(validNumber)
                    || status.availableRatio > 1 || status.sampledAt < status.startedAt
                    || status.sampledAt > Date.now() + 1000 || Date.now() - status.sampledAt > 180000
                    || !status.checkpoint || !validNumber(status.checkpoint.successes)
                    || status.tables.some(table => !validNumber(table.bytes) || !validNumber(table.successes))) {
                    throw new Error("invalid status");
                }
                const ticksPerSecond = 100;
                const bootTime = Number(fs.readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)[1]);
                const processStat = fs.readFileSync(`/proc/${status.processId}/stat`, "utf8");
                const processStart = bootTime * 1000 + Number(processStat.slice(processStat.lastIndexOf(")") + 2).split(" ")[19]) * 1000 / ticksPerSecond;
                if (status.startedAt < processStart) throw new Error("status belongs to a previous process");
                const critical = status.severity === "critical" || status.reasons.includes("disk-critical");
                const warning = !status.enabled || status.severity === "warning" || status.reasons.length > 0;
                console.log(JSON.stringify({
                    severity: critical ? "critical" : warning ? "warning" : "healthy",
                    enabled: status.enabled, sampledAt: status.sampledAt,
                    reasons: status.reasons, relationBytes: status.relationBytes,
                    walBytes: status.walBytes, availableBytes: status.availableBytes,
                    availableRatio: status.availableRatio, tables: status.tables.length,
                    maintainedTables: status.tables.filter(table => table.successes > 0).length,
                    sweepCompletedAt: status.sweepCompletedAt,
                    checkpointSuccesses: status.checkpoint.successes,
                }));
                process.exit(critical ? 2 : warning ? 1 : 0);
            } catch {
                console.error("Database maintenance status is missing, invalid, unsupported or stale");
                process.exit(2);
            }
        '
        ;;
    -h|--help|help|"")
        usage
        ;;
    *)
        usage >&2
        die "unknown command: $command_name"
        ;;
esac
