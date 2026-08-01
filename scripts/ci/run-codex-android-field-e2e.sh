#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${MAESTRO_BIN:?MAESTRO_BIN is required}"
: "${HAPPY_MOBILE_E2E_ROOT:?HAPPY_MOBILE_E2E_ROOT is required}"
: "${HAPPY_MOBILE_E2E_PID_FILE:?HAPPY_MOBILE_E2E_PID_FILE is required}"

APP_ID="com.slopus.happy.dev"
APK_PATH="packages/happy-app/android/app/build/outputs/apk/release/app-release.apk"
BOOTSTRAP_FLOW_PATH="scripts/ci/maestro/codex-mobile-bootstrap.yml"
ZERO_MACHINE_FLOW_PATH="scripts/ci/maestro/codex-mobile-zero-machine.yml"
FLOW_PATH="scripts/ci/maestro/codex-mobile-field.yml"
RECOVERY_FLOW_PATH="scripts/ci/maestro/codex-mobile-recovery.yml"
ARTIFACT_DIR="${RUNNER_TEMP}/happy-mobile-field-artifacts"
BOOTSTRAP_REPORT_PATH="${ARTIFACT_DIR}/maestro-bootstrap-junit.xml"
ZERO_MACHINE_REPORT_PATH="${ARTIFACT_DIR}/maestro-zero-machine-junit.xml"
REPORT_PATH="${ARTIFACT_DIR}/maestro-junit.xml"
RECOVERY_REPORT_PATH="${ARTIFACT_DIR}/maestro-recovery-junit.xml"
TEST_OUTPUT_DIR="${ARTIFACT_DIR}/maestro-output"
DEBUG_OUTPUT_DIR="${ARTIFACT_DIR}/maestro-debug"
VERIFICATION_FILE="${HAPPY_MOBILE_E2E_ROOT}/roundtrip-verified.json"
DIAGNOSTICS_FILE="${HAPPY_MOBILE_E2E_ROOT}/field-diagnostics.json"
APP_READY_FILE="${HAPPY_MOBILE_E2E_ROOT}/app-ready"

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
test -f "${BOOTSTRAP_FLOW_PATH}"
test -f "${ZERO_MACHINE_FLOW_PATH}"
test -f "${FLOW_PATH}"
test -f "${RECOVERY_FLOW_PATH}"
test -x "${MAESTRO_BIN}"
test -f "${HAPPY_MOBILE_E2E_PID_FILE}"

adb reverse tcp:53586 tcp:53586
adb install --no-streaming -r "${APK_PATH}"
adb shell pm path "${APP_ID}" | grep -Fq "package:"
adb logcat -c

"${MAESTRO_BIN}" \
  --no-ansi \
  test \
  --format junit \
  --output "${BOOTSTRAP_REPORT_PATH}" \
  --test-output-dir "${TEST_OUTPUT_DIR}/bootstrap" \
  --debug-output "${DEBUG_OUTPUT_DIR}/bootstrap" \
  "${BOOTSTRAP_FLOW_PATH}"

"${MAESTRO_BIN}" \
  --no-ansi \
  test \
  --format junit \
  --output "${ZERO_MACHINE_REPORT_PATH}" \
  --test-output-dir "${TEST_OUTPUT_DIR}/zero-machine" \
  --debug-output "${DEBUG_OUTPUT_DIR}/zero-machine" \
  "${ZERO_MACHINE_FLOW_PATH}"

fixture_pid="$(tr -d '[:space:]' < "${HAPPY_MOBILE_E2E_PID_FILE}")"
if ! kill -0 "${fixture_pid}" 2>/dev/null; then
  echo "Mobile fixture exited before the Android zero-machine bootstrap completed." >&2
  exit 1
fi
touch "${APP_READY_FILE}"

"${MAESTRO_BIN}" \
  --no-ansi \
  test \
  --format junit \
  --output "${REPORT_PATH}" \
  --test-output-dir "${TEST_OUTPUT_DIR}" \
  --debug-output "${DEBUG_OUTPUT_DIR}" \
  "${FLOW_PATH}"

"${MAESTRO_BIN}" \
  --no-ansi \
  test \
  --format junit \
  --output "${RECOVERY_REPORT_PATH}" \
  --test-output-dir "${TEST_OUTPUT_DIR}/recovery" \
  --debug-output "${DEBUG_OUTPUT_DIR}/recovery" \
  "${RECOVERY_FLOW_PATH}"

for _ in $(seq 1 600); do
  if [[ -f "${VERIFICATION_FILE}" ]]; then
    node -e '
      const fs = require("node:fs");
      const [verificationPath, diagnosticsPath] = process.argv.slice(1);
      if (!fs.existsSync(diagnosticsPath)) {
        throw new Error("Missing mobile field diagnostics");
      }
      const result = JSON.parse(fs.readFileSync(verificationPath, "utf8"));
      const diagnostics = JSON.parse(fs.readFileSync(diagnosticsPath, "utf8"));
      if (result.verified !== true || typeof result.sessionHash !== "string") {
        throw new Error("Invalid mobile field verification marker");
      }
      if (
        diagnostics.schemaVersion !== 4
        || diagnostics.phase !== "verified"
        || diagnostics.machineRegistered !== true
        || diagnostics.sessionObserved !== true
        || diagnostics.commandAccepted !== true
        || diagnostics.cliRoundTripObserved !== true
        || diagnostics.v3MessageCount !== 0
        || !/^codex-cli \d+\.\d+\.\d+$/.test(diagnostics.officialCodexVersion)
        || diagnostics.providerRequestCount < 4
        || diagnostics.providerToolOutputObserved !== true
        || diagnostics.providerHappyMcpOfferCount < 1
        || diagnostics.providerMcpToolCallCount < 1
        || diagnostics.providerMcpToolOutputObserved !== true
        || result.officialCodexVersion !== diagnostics.officialCodexVersion
        || result.providerRequestCount !== diagnostics.providerRequestCount
        || result.providerToolOutputObserved !== true
        || result.providerHappyMcpOfferCount !== diagnostics.providerHappyMcpOfferCount
        || result.providerNamespaceToolOfferCount !== diagnostics.providerNamespaceToolOfferCount
        || result.providerMcpToolCallCount !== diagnostics.providerMcpToolCallCount
        || result.providerMcpToolOutputObserved !== true
      ) {
        throw new Error("Mobile field diagnostics did not prove the Sync v4 round trip");
      }
    ' "${VERIFICATION_FILE}" "${DIAGNOSTICS_FILE}"
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
