#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CODEX_PROTOCOL_VERSION = '0.147.0';
const CODEX_VERSION_TIMEOUT_MS = 10_000;
const CODEX_GENERATE_TIMEOUT_MS = 120_000;
const packageRoot = path.resolve(__dirname, '..');
const protocolRoot = path.join(packageRoot, 'src', 'codex', 'protocol');
const outputDirectory = path.join(protocolRoot, 'generated');
const stagingDirectory = path.join(protocolRoot, `.generated-${process.pid}`);
const codexBinary = process.env.HAPPY_CODEX_PROTOCOL_BIN?.trim() || 'codex';
const methodSourceFiles = [
    'ClientNotification.ts',
    'ClientRequest.ts',
    'ServerNotification.ts',
    'ServerRequest.ts',
];

function readCodexVersion() {
    return execFileSync(codexBinary, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        timeout: CODEX_VERSION_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
        windowsHide: true,
    }).trim();
}

const versionOutput = readCodexVersion();
const versionMatch = versionOutput.match(/^codex-cli\s+(\d+\.\d+\.\d+)$/);
if (!versionMatch || versionMatch[1] !== CODEX_PROTOCOL_VERSION) {
    throw new Error(
        `Codex protocol generation requires codex-cli ${CODEX_PROTOCOL_VERSION}; received ${JSON.stringify(versionOutput)}`,
    );
}

function writeStableMethodManifest(directory) {
    const methods = new Set();
    for (const filename of methodSourceFiles) {
        const source = fs.readFileSync(path.join(directory, filename), 'utf8');
        for (const match of source.matchAll(/"method": "([^"]+)"/g)) {
            methods.add(match[1]);
        }
    }
    if (methods.size === 0) {
        throw new Error('Codex protocol generation produced no stable methods');
    }
    fs.writeFileSync(
        path.join(directory, 'STABLE_METHODS.json'),
        `${JSON.stringify([...methods].sort(), null, 2)}\n`,
        'utf8',
    );
}

fs.mkdirSync(protocolRoot, { recursive: true });
fs.rmSync(stagingDirectory, { recursive: true, force: true });

try {
    execFileSync(codexBinary, [
        'app-server',
        'generate-ts',
        '--out',
        stagingDirectory,
    ], {
        stdio: 'inherit',
        timeout: CODEX_GENERATE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
    });
    fs.writeFileSync(
        path.join(stagingDirectory, 'GENERATOR.json'),
        `${JSON.stringify({
            codexCliVersion: CODEX_PROTOCOL_VERSION,
            protocol: 'stable-v2',
            experimental: false,
            command: 'codex app-server generate-ts --out <directory>',
        }, null, 2)}\n`,
        'utf8',
    );
    writeStableMethodManifest(stagingDirectory);
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    fs.renameSync(stagingDirectory, outputDirectory);
} finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
}

console.log(`Generated Codex ${CODEX_PROTOCOL_VERSION} stable v2 types in ${outputDirectory}`);
