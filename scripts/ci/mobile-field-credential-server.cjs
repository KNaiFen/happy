#!/usr/bin/env node

const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');

const INVALID_BASE64URL_CHARACTER = /[^A-Za-z0-9_-]/;

function isCompactJws(value) {
    if (typeof value !== 'string' || value.length < 5 || value.length > 4096) {
        return false;
    }
    const segments = value.split('.');
    return segments.length === 3 && segments.every(
        (segment) => segment.length > 0 && !INVALID_BASE64URL_CHARACTER.test(segment),
    );
}

function isCanonical32ByteBase64Url(value) {
    if (
        typeof value !== 'string'
        || value.length !== 43
        || INVALID_BASE64URL_CHARACTER.test(value)
    ) {
        return false;
    }
    try {
        const decoded = Buffer.from(value, 'base64url');
        return decoded.length === 32 && decoded.toString('base64url') === value;
    } catch {
        return false;
    }
}

function parseCredentialsFile(path) {
    let state;
    try {
        state = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        throw new Error('Mobile Field credential state is unreadable');
    }
    if (
        !state
        || typeof state !== 'object'
        || Array.isArray(state)
        || typeof state.appToken !== 'string'
        || !isCompactJws(state.appToken)
        || typeof state.appSecret !== 'string'
        || !isCanonical32ByteBase64Url(state.appSecret)
    ) {
        throw new Error('Mobile Field credential state is malformed');
    }
    return { token: state.appToken, secret: state.appSecret };
}

function parsePort(value) {
    if (!/^\d+$/.test(value ?? '')) throw new Error('Mobile Field credential port is invalid');
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error('Mobile Field credential port is invalid');
    }
    return port;
}

function createCredentialServer(credentials) {
    const payload = Buffer.from(`${JSON.stringify(credentials)}\n`, 'utf8');
    return createServer((request, response) => {
        if (request.method !== 'GET' || request.url !== '/credentials') {
            response.writeHead(404, {
                'cache-control': 'no-store',
                'content-length': '0',
            });
            response.end();
            return;
        }
        response.writeHead(200, {
            'cache-control': 'no-store',
            'content-length': String(payload.length),
            'content-type': 'application/json',
        });
        response.end(payload);
    });
}

async function main() {
    const statePath = process.env.HAPPY_MOBILE_E2E_STATE_FILE;
    if (!statePath) throw new Error('HAPPY_MOBILE_E2E_STATE_FILE is required');
    const credentials = parseCredentialsFile(statePath);
    const port = parsePort(process.env.HAPPY_MOBILE_E2E_BOOTSTRAP_PORT);
    const server = createCredentialServer(credentials);
    let requestCount = 0;
    server.on('request', (request) => {
        requestCount += 1;
        const accepted = request.method === 'GET' && request.url === '/credentials';
        process.stdout.write(
            `Mobile Field credential request ${requestCount}: method=${request.method ?? 'UNKNOWN'} status=${accepted ? 200 : 404}\n`,
        );
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
    process.stdout.write(`Mobile Field credential server ready on 127.0.0.1:${port}\n`);

    const close = () => server.close(() => process.exit(0));
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    createCredentialServer,
    parseCredentialsFile,
    parsePort,
};
