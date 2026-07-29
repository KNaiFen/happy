#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Usage: package-debian13-relay-bundle.sh \
  --version X.Y.Z \
  --image IMAGE_TAG \
  --sbom /path/to/sbom.cdx.json \
  --output-dir /path/to/output
EOF
}

die() {
    echo "Error: $*" >&2
    exit 1
}

version=""
image=""
sbom=""
output_dir=""

while [[ "$#" -gt 0 ]]; do
    case "$1" in
        --version)
            [[ "$#" -ge 2 ]] || die "--version requires a value"
            version="$2"
            shift 2
            ;;
        --image)
            [[ "$#" -ge 2 ]] || die "--image requires a value"
            image="$2"
            shift 2
            ;;
        --sbom)
            [[ "$#" -ge 2 ]] || die "--sbom requires a value"
            sbom="$2"
            shift 2
            ;;
        --output-dir)
            [[ "$#" -ge 2 ]] || die "--output-dir requires a value"
            output_dir="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            usage >&2
            die "unknown argument: $1"
            ;;
    esac
done

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--version must be stable X.Y.Z"
[[ -n "$image" ]] || die "--image is required"
[[ -f "$sbom" ]] || die "SBOM file does not exist: $sbom"
[[ -n "$output_dir" ]] || die "--output-dir is required"

for command_name in docker gzip sha256sum tar mktemp node; do
    command -v "$command_name" >/dev/null 2>&1 || die "required command not found: $command_name"
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
deploy_dir="$repo_root/packages/happy-server/deploy/debian13-amd64"
package_version="$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.version)' "$repo_root/packages/happy-server/package.json")"

[[ "$package_version" == "$version" ]] \
    || die "Server package version $package_version does not match requested bundle version $version"
[[ "$(docker image inspect "$image" --format '{{.Architecture}}')" == "amd64" ]] \
    || die "Docker image is not amd64: $image"
[[ "$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.version" }}')" == "$version" ]] \
    || die "Docker image version label does not match $version"

for source_file in Dockerfile entrypoint.mjs compose.yaml env.example install.sh relayctl.sh README.md; do
    [[ -f "$deploy_dir/$source_file" ]] || die "deployment source is missing: $source_file"
done

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

bundle_root="$temporary_dir/happy-relay"
mkdir -p "$bundle_root/image" "$output_dir"

cp "$deploy_dir/README.md" "$bundle_root/README.md"
cp "$deploy_dir/compose.yaml" "$bundle_root/compose.yaml"
cp "$deploy_dir/install.sh" "$bundle_root/install.sh"
cp "$deploy_dir/relayctl.sh" "$bundle_root/relayctl.sh"
cp "$sbom" "$bundle_root/sbom.cdx.json"
printf '%s\n' "$version" > "$bundle_root/VERSION"
sed "s/__VERSION__/$version/g" "$deploy_dir/env.example" > "$bundle_root/env.example"

image_archive_name="happy-relay-server-${version}-debian13-amd64.image.tar.gz"
docker image save "$image" | gzip --no-name --best > "$bundle_root/image/$image_archive_name"

chmod 0755 "$bundle_root/install.sh" "$bundle_root/relayctl.sh"
chmod 0644 \
    "$bundle_root/VERSION" \
    "$bundle_root/README.md" \
    "$bundle_root/compose.yaml" \
    "$bundle_root/env.example" \
    "$bundle_root/sbom.cdx.json" \
    "$bundle_root/image/$image_archive_name"

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
        "image/$image_archive_name" > SHA256SUMS
)
chmod 0644 "$bundle_root/SHA256SUMS"

archive_name="happy-relay-server-${version}-debian13-amd64.tar.gz"
archive_path="$output_dir/$archive_name"
source_date_epoch="${SOURCE_DATE_EPOCH:-0}"
[[ "$source_date_epoch" =~ ^[0-9]+$ ]] || die "SOURCE_DATE_EPOCH must be an integer"

tar \
    --sort=name \
    --mtime="@$source_date_epoch" \
    --owner=0 \
    --group=0 \
    --numeric-owner \
    --format=gnu \
    -C "$temporary_dir" \
    -cf - happy-relay | gzip --no-name --best > "$archive_path"

(
    cd "$output_dir"
    sha256sum "$archive_name" > "$archive_name.sha256"
)

echo "Created $archive_path"
echo "Created $archive_path.sha256"
