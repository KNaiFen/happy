#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CODEX_PROTOCOL_VERSION = '0.145.0';
const CODEX_VERSION_TIMEOUT_MS = 10_000;
const CODEX_GENERATE_TIMEOUT_MS = 120_000;
const packageRoot = path.resolve(__dirname, '..');
const protocolRoot = path.join(packageRoot, 'src', 'codex', 'protocol');
const outputDirectory = path.join(protocolRoot, 'generated');
const stagingDirectory = path.join(protocolRoot, `.generated-${process.pid}`);
const codexBinary = process.env.HAPPY_CODEX_PROTOCOL_BIN?.trim() || 'codex';

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
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    fs.renameSync(stagingDirectory, outputDirectory);
} finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
}

console.log(`Generated Codex ${CODEX_PROTOCOL_VERSION} stable v2 types in ${outputDirectory}`);
