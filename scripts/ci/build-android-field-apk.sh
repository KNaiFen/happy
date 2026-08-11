#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: build-android-field-apk.sh <artifact-directory>" >&2
  exit 1
fi

: "${HAPPY_FIELD_SOURCE_SHA:?HAPPY_FIELD_SOURCE_SHA is required}"
: "${ANDROID_HOME:?ANDROID_HOME is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
[[ "${HAPPY_FIELD_SOURCE_SHA}" =~ ^[0-9a-f]{40}$ ]]
if [[ -n "${EXPO_PUBLIC_DEV_TOKEN:-}" || -n "${EXPO_PUBLIC_DEV_SECRET:-}" ]]; then
  echo 'Field APK credentials must be injected only at runtime.' >&2
  exit 1
fi

ARTIFACT_DIR="$1"
APK="packages/happy-app/android/app/build/outputs/apk/release/app-release.apk"
GRADLE_PROPERTIES="packages/happy-app/android/gradle.properties"
mkdir -p "${ARTIFACT_DIR}"
if find "${ARTIFACT_DIR}" -mindepth 1 -print -quit | grep -q .; then
  echo 'Field APK artifact directory must be empty.' >&2
  exit 1
fi

export APP_ENV=development
export NODE_ENV=production
export HAPPY_DISABLE_OTA=1
export HAPPY_BUILD_COMMIT_SHA="${HAPPY_FIELD_SOURCE_SHA}"
export HAPPY_BUILD_COMMIT_TIMESTAMP="$(git show -s --format=%cI "${HAPPY_FIELD_SOURCE_SHA}")"
export HAPPY_MOBILE_FIELD_E2E=1
export HAPPY_MOBILE_FIELD_BOOTSTRAP_URL=http://127.0.0.1:53587/credentials
export EXPO_PUBLIC_HAPPY_SERVER_URL=http://127.0.0.1:53586
export EXPO_PUBLIC_DEV_ALLOW_INSECURE_HTTP=1

CONFIG="${RUNNER_TEMP}/happy-mobile-field-app-config.json"
pnpm --filter happy-app exec expo config --type public --json > "${CONFIG}"
node - "${CONFIG}" <<'NODE'
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const app = config?.extra?.app;
if (
  app?.mobileFieldE2E !== true
  || app?.mobileFieldBootstrapUrl !== 'http://127.0.0.1:53587/credentials'
  || config?.updates?.enabled !== false
  || config?.android?.package !== 'com.slopus.happy.dev'
) {
  throw new Error('Generated Expo config does not match the mobile Field contract');
}
NODE

pnpm --filter happy-app exec expo prebuild --platform android --no-install
sed -i \
  's/^org.gradle.jvmargs=.*/org.gradle.jvmargs=-Xmx5120m -XX:MaxMetaspaceSize=1024m/' \
  "${GRADLE_PROPERTIES}"
grep -Fq \
  'org.gradle.jvmargs=-Xmx5120m -XX:MaxMetaspaceSize=1024m' \
  "${GRADLE_PROPERTIES}"
packages/happy-app/android/gradlew \
  -p packages/happy-app/android \
  assembleRelease \
  -PreactNativeArchitectures=x86_64 \
  -PnewArchEnabled=true \
  --no-daemon \
  --max-workers=2 \
  --stacktrace

bash scripts/ci/verify-android-field-apk.sh \
  "${APK}" "${HAPPY_FIELD_SOURCE_SHA}" "${HAPPY_BUILD_COMMIT_TIMESTAMP}"
install -m 0600 "${APK}" "${ARTIFACT_DIR}/app-release.apk"
