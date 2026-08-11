#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: verify-android-field-apk.sh <apk> <compiled-happy-source-sha> <compiled-commit-timestamp>" >&2
  exit 1
fi

APK_PATH="$1"
COMPILED_HAPPY_SOURCE_SHA="$2"
COMPILED_COMMIT_TIMESTAMP="$3"
: "${ANDROID_HOME:?ANDROID_HOME is required}"
[[ "${COMPILED_HAPPY_SOURCE_SHA}" =~ ^[0-9a-f]{40}$ ]]

TOOLS="${ANDROID_HOME}/build-tools/36.0.0"
for tool in aapt aapt2 apksigner zipalign; do
  test -x "${TOOLS}/${tool}"
done
test -f "${APK_PATH}"

VERIFY_ROOT="$(mktemp -d)"
trap 'rm -rf -- "${VERIFY_ROOT}"' EXIT
BADGING="${VERIFY_ROOT}/badging.txt"
ENTRIES="${VERIFY_ROOT}/entries.txt"
MANIFEST="${VERIFY_ROOT}/manifest.txt"
UPDATES_METADATA="${VERIFY_ROOT}/updates-metadata.txt"
APP_CONFIG="${VERIFY_ROOT}/app.config.json"

"${TOOLS}/aapt" dump badging "${APK_PATH}" > "${BADGING}"
unzip -Z1 "${APK_PATH}" > "${ENTRIES}"
grep -Fq "package: name='com.slopus.happy.dev'" "${BADGING}"
grep -Fq "targetSdkVersion:'36'" "${BADGING}"
grep -Fq "native-code: 'x86_64'" "${BADGING}"
grep -Fxq 'assets/index.android.bundle' "${ENTRIES}"
grep -Fxq 'assets/app.config' "${ENTRIES}"
if awk '/^lib\// && $0 !~ /^lib\/x86_64\// { print; unexpected = 1 } END { exit unexpected }' "${ENTRIES}"; then
  :
else
  echo 'Field APK contains an unexpected native architecture.' >&2
  exit 1
fi

"${TOOLS}/aapt2" dump xmltree --file AndroidManifest.xml "${APK_PATH}" > "${MANIFEST}"
if ! grep -Eq 'usesCleartextTraffic.*(0xffffffff|true)' "${MANIFEST}"; then
  echo 'Field APK manifest is missing android:usesCleartextTraffic=true.' >&2
  exit 1
fi
if ! grep -A2 'expo.modules.updates.ENABLED' "${MANIFEST}" > "${UPDATES_METADATA}"; then
  echo 'Field APK manifest is missing expo.modules.updates.ENABLED metadata.' >&2
  exit 1
fi
grep -Fq '=false' "${UPDATES_METADATA}"
if grep -Eq 'EXPO_UPDATE_URL|u\.expo\.dev' "${MANIFEST}"; then
  echo 'Field APK must not contain an OTA update URL.' >&2
  exit 1
fi

unzip -p "${APK_PATH}" assets/app.config > "${APP_CONFIG}"
COMPILED_HAPPY_SOURCE_SHA="${COMPILED_HAPPY_SOURCE_SHA}" \
COMPILED_COMMIT_TIMESTAMP="${COMPILED_COMMIT_TIMESTAMP}" \
node - "${APP_CONFIG}" <<'NODE'
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const app = config?.extra?.app;
if (config?.android?.package !== 'com.slopus.happy.dev') throw new Error('Field APK package mismatch');
if (config?.android?.usesCleartextTraffic !== true) throw new Error('Field APK cleartext policy mismatch');
if (config?.updates?.enabled !== false || config?.updates?.url) throw new Error('Field APK OTA policy mismatch');
if (app?.buildCommitSha !== process.env.COMPILED_HAPPY_SOURCE_SHA) {
  throw new Error('Field APK compiled source mismatch');
}
if (app?.buildCommitTimestamp !== process.env.COMPILED_COMMIT_TIMESTAMP) {
  throw new Error('Field APK compiled timestamp mismatch');
}
if (app?.mobileFieldE2E !== true) throw new Error('Field APK marker is missing');
if (app?.mobileFieldBootstrapUrl !== 'http://127.0.0.1:53587/credentials') {
  throw new Error('Field APK credential endpoint mismatch');
}
NODE

"${TOOLS}/apksigner" verify --verbose "${APK_PATH}"
"${TOOLS}/zipalign" -c -P 16 4 "${APK_PATH}"
