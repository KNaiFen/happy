const assert = require('node:assert/strict');
const { once } = require('node:events');
const { writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

const {
    createCredentialServer,
    parseCredentialsFile,
    parsePort,
} = require('./mobile-field-credential-server.cjs');

const credentials = {
    token: 'field-header.field-payload.field-signature',
    secret: `${'a'.repeat(42)}A`,
};

test('serves credentials only from the no-store loopback endpoint', async (context) => {
    const server = createCredentialServer(credentials);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    context.after(() => server.close());
    const address = server.address();
    assert(address && typeof address === 'object');

    const accepted = await fetch(`http://127.0.0.1:${address.port}/credentials`);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
    assert.equal(accepted.headers.get('content-type'), 'application/json');
    assert.deepEqual(await accepted.json(), credentials);

    const rejected = await fetch(`http://127.0.0.1:${address.port}/other`);
    assert.equal(rejected.status, 404);
    assert.equal(await rejected.text(), '');
});

test('validates the state file and bounded TCP port without echoing credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'happy-field-credentials-'));
    try {
        const statePath = join(root, 'state.json');
        writeFileSync(statePath, JSON.stringify({ appToken: credentials.token, appSecret: credentials.secret }));
        assert.deepEqual(parseCredentialsFile(statePath), credentials);
        assert.equal(parsePort('53587'), 53587);
        assert.throws(() => parsePort('0'), /port is invalid/);
        assert.throws(() => parsePort('65536'), /port is invalid/);
        writeFileSync(statePath, JSON.stringify({ appToken: 'bad token', appSecret: 'short' }));
        assert.throws(() => parseCredentialsFile(statePath), /state is malformed/);
        writeFileSync(statePath, JSON.stringify({
            appToken: 'too.many.jws.segments',
            appSecret: `${'a'.repeat(42)}B`,
        }));
        assert.throws(() => parseCredentialsFile(statePath), /state is malformed/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
