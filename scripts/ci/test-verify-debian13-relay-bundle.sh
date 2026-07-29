#!/usr/bin/env bash

set -Eeuo pipefail

die() {
    echo "Error: $*" >&2
    exit 1
}

for command_name in gzip sha256sum tar mktemp grep; do
    command -v "$command_name" >/dev/null 2>&1 || die "required command not found: $command_name"
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_dir="$(mktemp -d)"
bundle_root="$temporary_dir/happy-relay"
version="9.8.7"

cleanup() {
    rm -rf "$temporary_dir"
}
trap cleanup EXIT

write_manifest() {
    (
        cd "$bundle_root"
        sha256sum \
            VERSION \
            README.md \
            compose.yaml \
            env.example \
            install.sh \
            relayctl.sh \
            sbom.cdx.json \
            "image/happy-relay-server-${version}-debian13-amd64.image.tar.gz" > SHA256SUMS
    )
}

create_archive() {
    archive="$1"
    tar -czf "$archive" -C "$temporary_dir" happy-relay
}

mkdir -p "$bundle_root/image"
printf '%s\n' "$version" > "$bundle_root/VERSION"
printf '%s\n' "Synthetic relay verifier fixture" > "$bundle_root/README.md"
printf '%s\n' "services: {}" > "$bundle_root/compose.yaml"
printf '%s\n' "HAPPY_RELAY_IMAGE=happy-relay-server:${version}-debian13-amd64" > "$bundle_root/env.example"
printf '%s\n' '#!/bin/sh' 'marker=__VERSION__' > "$bundle_root/install.sh"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$bundle_root/relayctl.sh"
printf '%s\n' '{"bomFormat":"CycloneDX"}' > "$bundle_root/sbom.cdx.json"
printf '%s\n' "synthetic image archive" \
    > "$bundle_root/image/happy-relay-server-${version}-debian13-amd64.image.tar.gz"
chmod 0755 "$bundle_root/install.sh" "$bundle_root/relayctl.sh"
write_manifest

valid_archive="$temporary_dir/valid.tar.gz"
create_archive "$valid_archive"
"$script_dir/verify-debian13-relay-bundle.sh" "$valid_archive" "$version"

printf '%s\n' "HAPPY_RELAY_IMAGE=happy-relay-server:__VERSION__-debian13-amd64" \
    > "$bundle_root/env.example"
write_manifest
invalid_archive="$temporary_dir/unresolved.tar.gz"
invalid_log="$temporary_dir/unresolved.log"
create_archive "$invalid_archive"
if "$script_dir/verify-debian13-relay-bundle.sh" "$invalid_archive" "$version" \
    > "$invalid_log" 2>&1; then
    die "verifier accepted an unresolved env.example placeholder"
fi
grep -Fq "bundle still contains an unresolved version placeholder" "$invalid_log" \
    || die "verifier failed for an unexpected reason"

echo "Verified Debian relay bundle placeholder regression coverage"
