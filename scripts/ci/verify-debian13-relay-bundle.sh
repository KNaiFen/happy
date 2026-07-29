#!/usr/bin/env bash

set -Eeuo pipefail

die() {
    echo "Error: $*" >&2
    exit 1
}

archive="${1:-}"
expected_version="${2:-}"

[[ -n "$archive" ]] || die "usage: verify-debian13-relay-bundle.sh <archive.tar.gz> [expected-version]"
[[ -f "$archive" ]] || die "archive does not exist: $archive"

for command_name in gzip sha256sum sort tar mktemp node uniq; do
    command -v "$command_name" >/dev/null 2>&1 || die "required command not found: $command_name"
done

if [[ -f "$archive.sha256" ]]; then
    (
        cd "$(dirname "$archive")"
        sha256sum --check "$(basename "$archive").sha256"
    )
fi

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT
member_list="$temporary_dir/members.txt"
verbose_list="$temporary_dir/members.verbose.txt"

tar -tzf "$archive" > "$member_list"
tar -tvzf "$archive" > "$verbose_list"

while IFS= read -r member; do
    normalized="${member#./}"
    [[ "$member" == "$normalized" ]] || die "archive member is not canonical: $member"
    [[ "$normalized" != /* ]] || die "archive contains an absolute path: $member"
    [[ "/$normalized/" != *"/../"* ]] || die "archive contains parent traversal: $member"
    [[ "/$normalized/" != *"/./"* ]] || die "archive contains a redundant dot component: $member"
    [[ "$normalized" != *"//"* ]] || die "archive contains a redundant path separator: $member"
    case "$normalized" in
        happy-relay|happy-relay/*) ;;
        *) die "archive member is outside happy-relay/: $member" ;;
    esac
done < "$member_list"

if [[ -n "$(sort "$member_list" | uniq -d)" ]]; then
    die "archive contains duplicate member names"
fi

if awk 'substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { exit 1 }' "$verbose_list"; then
    :
else
    die "archive contains a symlink, hardlink, or special file"
fi

tar -xzf "$archive" -C "$temporary_dir"
bundle_root="$temporary_dir/happy-relay"
[[ -d "$bundle_root" ]] || die "happy-relay/ root directory is missing"

for required_file in VERSION README.md compose.yaml env.example install.sh relayctl.sh SHA256SUMS sbom.cdx.json; do
    [[ -f "$bundle_root/$required_file" ]] || die "required file is missing: $required_file"
done

version="$(tr -d '\r\n' < "$bundle_root/VERSION")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "VERSION must be stable X.Y.Z"
if [[ -n "$expected_version" && "$version" != "$expected_version" ]]; then
    die "bundle version $version does not match expected version $expected_version"
fi

image_archive="image/happy-relay-server-${version}-debian13-amd64.image.tar.gz"
[[ -f "$bundle_root/$image_archive" ]] || die "versioned Docker image archive is missing"

node -e '
    const fs = require("node:fs");
    const manifest = fs.readFileSync(process.argv[1], "utf8").trim().split("\n");
    const expected = new Set([
        "VERSION",
        "README.md",
        "compose.yaml",
        "env.example",
        "install.sh",
        "relayctl.sh",
        "sbom.cdx.json",
        process.argv[2],
    ]);
    for (const line of manifest) {
        const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
        if (!match || !expected.delete(match[2])) {
            throw new Error(`unexpected SHA256SUMS entry: ${line}`);
        }
    }
    if (expected.size !== 0) {
        throw new Error(`missing SHA256SUMS entries: ${[...expected].join(", ")}`);
    }
' "$bundle_root/SHA256SUMS" "$image_archive"

file_count="$(find "$bundle_root" -type f | wc -l | tr -d ' ')"
directory_count="$(find "$bundle_root" -type d | wc -l | tr -d ' ')"
[[ "$file_count" == "9" ]] || die "bundle must contain exactly 9 files, found $file_count"
[[ "$directory_count" == "2" ]] || die "bundle must contain only happy-relay/ and image/ directories"
[[ ! -e "$bundle_root/.env" ]] || die ".env must not be shipped"
[[ ! -e "$bundle_root/secrets" ]] || die "secrets must not be shipped"
[[ -x "$bundle_root/install.sh" ]] || die "install.sh is not executable"
[[ -x "$bundle_root/relayctl.sh" ]] || die "relayctl.sh is not executable"

node -e '
    const fs = require("node:fs");
    for (const file of process.argv.slice(1)) {
        const mode = fs.statSync(file).mode & 0o777;
        if (mode !== 0o755) throw new Error(`${file} mode must be 0755`);
    }
' "$bundle_root/install.sh" "$bundle_root/relayctl.sh"

(
    cd "$bundle_root"
    sha256sum --check SHA256SUMS
)

grep -Fxq "HAPPY_RELAY_IMAGE=happy-relay-server:${version}-debian13-amd64" "$bundle_root/env.example" \
    || die "env.example image tag does not match VERSION"
if grep -Rq '__VERSION__' "$bundle_root"; then
    die "bundle still contains an unresolved version placeholder"
fi

node -e '
    const fs = require("node:fs");
    const document = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (document.bomFormat !== "CycloneDX") {
        throw new Error("SBOM is not CycloneDX");
    }
' "$bundle_root/sbom.cdx.json"

echo "Verified Debian 13 amd64 Happy relay bundle version $version"
