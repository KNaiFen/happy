const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    loadMobileFieldConfig,
} = require('./mobileFieldConfig.cjs');

const fieldEnv = {
    APP_ENV: 'development',
    HAPPY_MOBILE_FIELD_E2E: '1',
    HAPPY_MOBILE_FIELD_BOOTSTRAP_URL: 'http://127.0.0.1:53587/credentials',
};

test('loads only the canonical development Field bootstrap endpoint', () => {
    assert.deepEqual(loadMobileFieldConfig(fieldEnv), {
        mobileFieldE2E: true,
        mobileFieldBootstrapUrl: 'http://127.0.0.1:53587/credentials',
    });
    assert.deepEqual(loadMobileFieldConfig({ APP_ENV: 'production' }), {
        mobileFieldE2E: false,
        mobileFieldBootstrapUrl: undefined,
    });
});

test('rejects incomplete or non-development Field configuration', () => {
    assert.throws(
        () => loadMobileFieldConfig({ APP_ENV: 'production', HAPPY_MOBILE_FIELD_E2E: '1' }),
        /development builds/,
    );
    assert.throws(
        () => loadMobileFieldConfig({
            APP_ENV: 'development',
            HAPPY_MOBILE_FIELD_BOOTSTRAP_URL: fieldEnv.HAPPY_MOBILE_FIELD_BOOTSTRAP_URL,
        }),
        /requires HAPPY_MOBILE_FIELD_E2E=1/,
    );
    assert.throws(
        () => loadMobileFieldConfig({ APP_ENV: 'development', HAPPY_MOBILE_FIELD_E2E: '1' }),
        /is required/,
    );
});

test('rejects non-canonical or unusable Field bootstrap URLs', () => {
    for (const url of [
        'https://127.0.0.1:53587/credentials',
        'http://localhost:53587/credentials',
        'http://127.0.0.1:0/credentials',
        'http://127.0.0.1:65536/credentials',
        'http://127.0.0.1:53587/other',
        'http://user@127.0.0.1:53587/credentials',
        'http://127.0.0.1:53587/credentials?token=x',
    ]) {
        assert.throws(
            () => loadMobileFieldConfig({ ...fieldEnv, HAPPY_MOBILE_FIELD_BOOTSTRAP_URL: url }),
            /loopback credentials endpoint|valid URL/,
            url,
        );
    }
});
