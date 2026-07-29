#!/bin/sh

set -eu

if [ "$#" -gt 0 ]; then
    exec "$@"
fi

secret_file="${HAPPY_MASTER_SECRET_FILE:-/run/secrets/happy_master_secret}"
if [ ! -r "$secret_file" ]; then
    echo "Happy relay master secret is not readable: $secret_file" >&2
    exit 1
fi

master_secret="$(tr -d '\r\n' < "$secret_file")"
case "$master_secret" in
    ""|*[!0-9a-fA-F]*)
        echo "Happy relay master secret must contain exactly 64 hexadecimal characters" >&2
        exit 1
        ;;
esac

if [ "${#master_secret}" -ne 64 ]; then
    echo "Happy relay master secret must contain exactly 64 hexadecimal characters" >&2
    exit 1
fi

export HANDY_MASTER_SECRET="$master_secret"
unset master_secret

node dist/standalone.mjs migrate
exec node dist/standalone.mjs serve
