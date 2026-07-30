#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${MAESTRO_BIN:?MAESTRO_BIN is required}"
: "${HAPPY_MOBILE_E2E_ROOT:?HAPPY_MOBILE_E2E_ROOT is required}"
: "${HAPPY_MOBILE_E2E_PID_FILE:?HAPPY_MOBILE_E2E_PID_FILE is required}"

APP_ID="com.slopus.happy.dev"
APK_PATH="packages/happy-app/android/app/build/outputs/apk/debug/app-debug.apk"
FLOW_PATH="scripts/ci/maestro/codex-mobile-field.yml"
ARTIFACT_DIR="${RUNNER_TEMP}/happy-mobile-field-artifacts"
REPORT_PATH="${ARTIFACT_DIR}/maestro-junit.xml"
TEST_OUTPUT_DIR="${ARTIFACT_DIR}/maestro-output"
DEBUG_OUTPUT_DIR="${ARTIFACT_DIR}/maestro-debug"
VERIFICATION_FILE="${HAPPY_MOBILE_E2E_ROOT}/roundtrip-verified.json"

mkdir -p "${ARTIFACT_DIR}" "${TEST_OUTPUT_DIR}" "${DEBUG_OUTPUT_DIR}"

capture_diagnostics() {
  local status=$?
  adb exec-out screencap -p > "${ARTIFACT_DIR}/final-screen.png" 2>/dev/null || true
  adb logcat -d -v threadtime > "${ARTIFACT_DIR}/android-logcat.txt" 2>/dev/null || true
  adb shell dumpsys activity activities > "${ARTIFACT_DIR}/android-activities.txt" 2>/dev/null || true
  return "${status}"
}
trap capture_diagnostics EXIT

test -f "${APK_PATH}"
test -f "${FLOW_PATH}"
test -x "${MAESTRO_BIN}"
test -f "${HAPPY_MOBILE_E2E_PID_FILE}"

adb reverse tcp:53586 tcp:53586
adb reverse tcp:8081 tcp:8081
adb install --no-streaming -r "${APK_PATH}"
adb shell pm path "${APP_ID}" | grep -Fq "package:"
adb logcat -c

"${MAESTRO_BIN}" \
  --no-ansi \
  test \
  --format junit \
  --output "${REPORT_PATH}" \
  --test-output-dir "${TEST_OUTPUT_DIR}" \
  --debug-output "${DEBUG_OUTPUT_DIR}" \
  "${FLOW_PATH}"

fixture_pid="$(tr -d '[:space:]' < "${HAPPY_MOBILE_E2E_PID_FILE}")"
for _ in $(seq 1 600); do
  if [[ -f "${VERIFICATION_FILE}" ]]; then
    node -e '
      const fs = require("node:fs");
      const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (result.verified !== true || typeof result.sessionHash !== "string") {
        throw new Error("Invalid mobile field verification marker");
      }
    ' "${VERIFICATION_FILE}"
    exit 0
  fi
  if ! kill -0 "${fixture_pid}" 2>/dev/null; then
    echo "Mobile field fixture exited before server-side verification completed." >&2
    exit 1
  fi
  sleep 0.2
done

echo "Timed out waiting for server-side mobile field verification." >&2
exit 1
