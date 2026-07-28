#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const appConfigPath = process.argv[2];
if (!appConfigPath) {
    throw new Error('Usage: verify-http-platform-config.cjs <expo-config.json>');
}

const appConfig = readJson(appConfigPath);
assert(
    appConfig.android?.usesCleartextTraffic === true,
    'Production Android config must declare usesCleartextTraffic=true',
);

const ats = appConfig.ios?.infoPlist?.NSAppTransportSecurity;
assert(
    ats?.NSAllowsArbitraryLoads === true,
    'Production iOS config must allow explicitly confirmed HTTP relay requests',
);
assert(
    ats?.NSAllowsLocalNetworking === true,
    'Production iOS config must retain local networking access',
);

const capabilityPath = path.join(
    repoRoot,
    'packages/happy-app/src-tauri/capabilities/default.json',
);
const capabilityText = fs.readFileSync(capabilityPath, 'utf8');
const capability = JSON.parse(capabilityText);
const capabilityJson = JSON.stringify(capability);
assert(
    !capabilityJson.includes('http:default'),
    'Tauri must not expose the generic HTTP plugin capability',
);
assert(
    !capabilityJson.includes('http://**'),
    'Tauri must not allow every HTTP origin',
);

const tauriConfig = readJson(path.join(
    repoRoot,
    'packages/happy-app/src-tauri/tauri.conf.json',
));
const csp = tauriConfig.app?.security?.csp;
assert(typeof csp === 'string' && csp.length > 0, 'Tauri production CSP must be enabled');
const connectDirective = csp
    .split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith('connect-src '));
assert(connectDirective, 'Tauri CSP must define connect-src');
assert(
    !connectDirective.split(/\s+/).includes('http:'),
    'Tauri CSP must not expose generic browser HTTP fetch',
);
assert(
    connectDirective.split(/\s+/).includes('ws:'),
    'Tauri CSP must allow the policy-checked HTTP relay WebSocket',
);

const tauriInfoPlist = fs.readFileSync(
    path.join(repoRoot, 'packages/happy-app/src-tauri/Info.plist'),
    'utf8',
);
for (const requiredPlistKey of [
    'NSAllowsArbitraryLoadsInWebContent',
    'NSAllowsLocalNetworking',
]) {
    assert(
        new RegExp(`<key>${requiredPlistKey}</key>\\s*<true\\s*/>`).test(tauriInfoPlist),
        `Tauri macOS Info.plist must enable ${requiredPlistKey}`,
    );
}

const rustSource = fs.readFileSync(
    path.join(repoRoot, 'packages/happy-app/src-tauri/src/lib.rs'),
    'utf8',
);
for (const requiredSource of [
    'relay_http_set_policy',
    'relay_http_clear_policy',
    'relay_http_request',
    'relay_http_probe',
    'allow_insecure_http',
    'body_base64',
    'BASE64_STANDARD',
    'same_origin',
    'Policy::none()',
    'MAX_RELAY_REQUEST_BYTES',
    'MAX_RELAY_RESPONSE_BYTES',
    'MAX_RELAY_PROBE_RESPONSE_BYTES',
    'RwLock<Option<RelayHttpPolicy>>',
]) {
    assert(
        rustSource.includes(requiredSource),
        `Tauri native relay transport is missing ${requiredSource}`,
    );
}
const relayRequestFields = rustSource.match(
    /struct RelayHttpRequest\s*\{([\s\S]*?)\n\}/,
)?.[1];
assert(relayRequestFields, 'Tauri authenticated relay request struct is missing');
assert(
    !relayRequestFields.includes('base_url')
        && !relayRequestFields.includes('allow_insecure_http'),
    'Tauri authenticated relay requests must use the committed Rust relay policy',
);

const appTransportSource = fs.readFileSync(
    path.join(repoRoot, 'packages/happy-app/sources/sync/serverTransport.ts'),
    'utf8',
);
const committedRequestBody = appTransportSource.match(
    /function invokeCommittedRelayRequest\s*\([^)]*\)[\s\S]*?\n\}/,
)?.[0];
assert(committedRequestBody, 'App committed relay request function is missing');
assert(
    !committedRequestBody.includes('relay_http_set_policy'),
    'Ordinary authenticated relay requests must not rewrite the native policy',
);
assert(
    appTransportSource.includes('commitServerTransportPolicy'),
    'App must expose an explicit native policy commit boundary',
);

const serverPolicySource = fs.readFileSync(
    path.join(repoRoot, 'packages/happy-app/sources/sync/serverUrlPolicy.ts'),
    'utf8',
);
for (const requiredPolicy of [
    'insecureHttpNotAllowed',
    'webHttpRequiresLoopback',
    'isLoopbackHostname',
]) {
    assert(
        serverPolicySource.includes(requiredPolicy),
        `App runtime HTTP policy is missing ${requiredPolicy}`,
    );
}

console.log('HTTP platform configuration verified');

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
