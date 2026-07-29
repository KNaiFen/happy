const { AndroidConfig, withAndroidManifest } = require('@expo/config-plugins');

function setAndroidCleartextTraffic(androidManifest) {
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
    mainApplication.$ ??= {};
    mainApplication.$['android:usesCleartextTraffic'] = 'true';
    return androidManifest;
}

function withTrustedHttpRelayAndroid(config) {
    if (config.android?.usesCleartextTraffic !== true) {
        throw new Error('Trusted HTTP relay support requires android.usesCleartextTraffic=true');
    }

    return withAndroidManifest(config, (manifestConfig) => {
        setAndroidCleartextTraffic(manifestConfig.modResults);
        return manifestConfig;
    });
}

module.exports = withTrustedHttpRelayAndroid;
module.exports.setAndroidCleartextTraffic = setAndroidCleartextTraffic;
