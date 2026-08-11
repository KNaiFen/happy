function parseLoopbackCredentialsUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('HAPPY_MOBILE_FIELD_BOOTSTRAP_URL must be a valid URL');
    }

    const port = Number(url.port);
    if (
        url.protocol !== 'http:'
        || url.hostname !== '127.0.0.1'
        || !/^\d+$/.test(url.port)
        || !Number.isSafeInteger(port)
        || port < 1
        || port > 65535
        || url.pathname !== '/credentials'
        || url.username
        || url.password
        || url.search
        || url.hash
    ) {
        throw new Error('HAPPY_MOBILE_FIELD_BOOTSTRAP_URL must use the loopback credentials endpoint');
    }
    return url.href;
}

function loadMobileFieldConfig(env = process.env) {
    const mobileFieldE2E = env.HAPPY_MOBILE_FIELD_E2E === '1';
    const variant = env.APP_ENV || 'development';
    const bootstrapUrl = env.HAPPY_MOBILE_FIELD_BOOTSTRAP_URL;

    if (mobileFieldE2E && variant !== 'development') {
        throw new Error('HAPPY_MOBILE_FIELD_E2E is allowed only for development builds');
    }
    if (!mobileFieldE2E) {
        if (bootstrapUrl) {
            throw new Error('HAPPY_MOBILE_FIELD_BOOTSTRAP_URL requires HAPPY_MOBILE_FIELD_E2E=1');
        }
        return { mobileFieldE2E: false, mobileFieldBootstrapUrl: undefined };
    }
    if (!bootstrapUrl) {
        throw new Error('HAPPY_MOBILE_FIELD_BOOTSTRAP_URL is required for mobile Field builds');
    }

    return {
        mobileFieldE2E: true,
        mobileFieldBootstrapUrl: parseLoopbackCredentialsUrl(bootstrapUrl),
    };
}

module.exports = {
    loadMobileFieldConfig,
    parseLoopbackCredentialsUrl,
};
