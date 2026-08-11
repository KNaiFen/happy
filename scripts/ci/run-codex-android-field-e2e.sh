#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${MAESTRO_BIN:?MAESTRO_BIN is required}"
: "${HAPPY_MOBILE_E2E_ROOT:?HAPPY_MOBILE_E2E_ROOT is required}"
: "${HAPPY_MOBILE_E2E_PID_FILE:?HAPPY_MOBILE_E2E_PID_FILE is required}"
: "${HAPPY_MOBILE_E2E_BOOTSTRAP_PORT:?HAPPY_MOBILE_E2E_BOOTSTRAP_PORT is required}"

APP_ID="com.slopus.happy.dev"
APK_PATH="${HAPPY_FIELD_APK_PATH:-packages/happy-app/android/app/build/outputs/apk/release/app-release.apk}"
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
CREDENTIAL_LOG="${RUNNER_TEMP}/happy-mobile-credential-server.log"

mkdir -p "${ARTIFACT_DIR}" "${TEST_OUTPUT_DIR}" "${DEBUG_OUTPUT_DIR}"

capture_diagnostics() {
  local status=$?
  adb exec-out screencap -p > "${ARTIFACT_DIR}/final-screen.png" 2>/dev/null || true
  adb logcat -d -v threadtime > "${ARTIFACT_DIR}/android-logcat.txt" 2>/dev/null || true
  adb shell dumpsys activity activities > "${ARTIFACT_DIR}/android-activities.txt" 2>/dev/null || true
  if [[ -f "${DIAGNOSTICS_FILE}" ]]; then
    node -e '
      const fs = require("node:fs");
      const diagnostic = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      console.error("Mobile field rollback diagnostic:", JSON.stringify({
        schemaVersion: diagnostic.schemaVersion,
        phase: diagnostic.phase,
        rollbackCommandResultTerminalStatus: diagnostic.rollbackCommandResultTerminalStatus,
        rollbackCommandResultUpdatedAt: diagnostic.rollbackCommandResultUpdatedAt,
        rollbackCommandErrorKind: diagnostic.rollbackCommandErrorKind,
      }));
    ' "${DIAGNOSTICS_FILE}" || true
  fi
  return "${status}"
}
trap capture_diagnostics EXIT

assert_first_credential_request() {
  local expected_request='Mobile Field credential request 1: method=GET status=200'
  local first_request_prefix='Mobile Field credential request 1:'
  for _ in $(seq 1 300); do
    if grep -Fqx "${expected_request}" "${CREDENTIAL_LOG}"; then
      return 0
    fi
    if grep -Fq "${first_request_prefix}" "${CREDENTIAL_LOG}"; then
      echo "The App did not fetch credentials from the exact loopback endpoint." >&2
      tail -n 50 "${CREDENTIAL_LOG}" >&2 || true
      return 1
    fi
    sleep 0.1
  done
  echo "Timed out waiting for the App to fetch loopback credentials." >&2
  tail -n 50 "${CREDENTIAL_LOG}" >&2 || true
  return 1
}

restart_app_after_process_death() {
  local launch_log="${ARTIFACT_DIR}/recovery-am-start.txt"
  local resolved_activity_output
  local resolved_component
  local component_candidates
  printf 'started_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${launch_log}"
  if ! (
    printf 'package_paths:\n'
    if ! adb shell pm path "${APP_ID}"; then
      echo "Recovery package path lookup failed." >&2
      exit 1
    fi
    printf 'resolved_launcher_activity:\n'
    if ! resolved_activity_output="$(adb shell cmd package resolve-activity --brief \
      -a android.intent.action.MAIN \
      -c android.intent.category.LAUNCHER \
      -p "${APP_ID}" | tr -d '\r')"; then
      echo "Recovery launcher activity resolution failed." >&2
      exit 1
    fi
    printf '%s\n' "${resolved_activity_output}"
    component_candidates="$(
      printf '%s\n' "${resolved_activity_output}" |
        awk -v app_id="${APP_ID}" 'index($0, app_id "/") == 1 && $0 !~ /[[:space:]]/ { print }'
    )"
    if [[ -z "${component_candidates}" ]] || [[ "${component_candidates}" == *$'\n'* ]]; then
      echo "Expected exactly one launcher component of ${APP_ID}." >&2
      exit 1
    fi
    resolved_component="${component_candidates}"
    printf 'selected_launcher_component=%s\n' "${resolved_component}"
    if ! timeout 30s adb shell am start -W \
      -a android.intent.action.MAIN \
      -c android.intent.category.LAUNCHER \
      -n "${resolved_component}"; then
      echo "Resolved recovery launcher start failed." >&2
      exit 1
    fi
  ) >> "${launch_log}" 2>&1; then
    cat "${launch_log}" >&2 || true
    echo "Bounded recovery launcher start failed." >&2
    return 1
  fi
  printf 'finished_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "${launch_log}"
  cat "${launch_log}"
  grep -Fqx 'Status: ok' "${launch_log}"
}

test -f "${APK_PATH}"
test -f "${BOOTSTRAP_FLOW_PATH}"
test -f "${ZERO_MACHINE_FLOW_PATH}"
test -f "${FLOW_PATH}"
test -f "${RECOVERY_FLOW_PATH}"
test -x "${MAESTRO_BIN}"
test -f "${HAPPY_MOBILE_E2E_PID_FILE}"
test -f "${CREDENTIAL_LOG}"
[[ "${HAPPY_MOBILE_E2E_BOOTSTRAP_PORT}" =~ ^[0-9]+$ ]]
(( HAPPY_MOBILE_E2E_BOOTSTRAP_PORT >= 1 && HAPPY_MOBILE_E2E_BOOTSTRAP_PORT <= 65535 ))

adb reverse tcp:53586 tcp:53586
adb reverse \
  "tcp:${HAPPY_MOBILE_E2E_BOOTSTRAP_PORT}" \
  "tcp:${HAPPY_MOBILE_E2E_BOOTSTRAP_PORT}"
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

assert_first_credential_request

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

restart_app_after_process_death

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
        diagnostics.schemaVersion !== 15
        || diagnostics.phase !== "verified"
        || diagnostics.machineRegistered !== true
        || diagnostics.sessionObserved !== true
        || diagnostics.commandAccepted !== true
        || diagnostics.cliRoundTripObserved !== true
        || diagnostics.retiredV3MessageRouteStatus !== 404
        || !/^codex-cli \d+\.\d+\.\d+$/.test(diagnostics.officialCodexVersion)
        || diagnostics.providerRequestCount < 5
        || diagnostics.providerToolOutputObserved !== true
        || diagnostics.providerFixtureMcpOfferCount < 1
        || diagnostics.providerMcpToolCallCount < 1
        || diagnostics.providerMcpToolOutputObserved !== true
        || diagnostics.providerMcpChoiceAccepted !== true
        || diagnostics.providerQueuedFollowUpObserved !== true
        || diagnostics.providerPostClearFollowUpObserved !== true
        || diagnostics.providerClearPromptObserved !== false
        || diagnostics.sessionDataKeyDecryptable !== true
        || diagnostics.sessionMetadataDecryptable !== true
        || diagnostics.sessionMetadataCodexV4 !== true
        || diagnostics.sessionPermissionModeDefault !== true
        || diagnostics.sessionActive !== true
        || diagnostics.postClearRuntimeIdle !== true
        || diagnostics.postClearHasNoActiveTurn !== true
        || typeof diagnostics.rollbackCommandId !== "string"
        || diagnostics.rollbackCommandId.length === 0
        || diagnostics.rollbackCommandResultTerminalStatus !== "succeeded"
        || !Number.isSafeInteger(diagnostics.rollbackCommandResultUpdatedAt)
        || diagnostics.rollbackCommandResultUpdatedAt < 0
        || diagnostics.rollbackCommandErrorKind !== "none"
        || diagnostics.rollbackCommandSucceeded !== true
        || diagnostics.postClearCommandSucceeded !== true
        || diagnostics.v4LifecycleCompleted !== true
        || result.officialCodexVersion !== diagnostics.officialCodexVersion
        || result.providerRequestCount !== diagnostics.providerRequestCount
        || result.providerToolOutputObserved !== true
        || result.providerFixtureMcpOfferCount !== diagnostics.providerFixtureMcpOfferCount
        || result.providerNamespaceToolOfferCount !== diagnostics.providerNamespaceToolOfferCount
        || result.providerToolSearchCallCount !== diagnostics.providerToolSearchCallCount
        || result.providerToolSearchOutputObserved !== diagnostics.providerToolSearchOutputObserved
        || result.providerMcpToolCallCount !== diagnostics.providerMcpToolCallCount
        || result.providerMcpToolOutputObserved !== true
        || result.providerMcpChoiceAccepted !== true
        || result.providerQueuedFollowUpObserved !== true
        || result.providerPostClearFollowUpObserved !== true
        || result.providerClearPromptObserved !== false
        || result.sessionDataKeyDecryptable !== true
        || result.sessionMetadataDecryptable !== true
        || result.sessionMetadataCodexV4 !== true
        || result.sessionPermissionModeDefault !== true
        || result.sessionActive !== true
        || result.postClearRuntimeIdle !== true
        || result.postClearHasNoActiveTurn !== true
        || result.rollbackCommandId !== diagnostics.rollbackCommandId
        || result.rollbackCommandResultTerminalStatus !== diagnostics.rollbackCommandResultTerminalStatus
        || result.rollbackCommandResultUpdatedAt !== diagnostics.rollbackCommandResultUpdatedAt
        || result.rollbackCommandErrorKind !== diagnostics.rollbackCommandErrorKind
        || result.rollbackCommandSucceeded !== true
        || result.postClearCommandSucceeded !== true
        || result.v4LifecycleCompleted !== true
        || result.retiredV3MessageRouteStatus !== diagnostics.retiredV3MessageRouteStatus
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
