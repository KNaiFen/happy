#!/usr/bin/env node

const { AndroidConfig } = require('@expo/config-plugins');

const manifestPath = process.argv[2];
if (!manifestPath) {
    throw new Error('Usage: verify-generated-android-manifest.cjs <AndroidManifest.xml>');
}

verifyManifest().catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown verification failure';
    console.error(`Generated Android manifest verification failed: ${message}`);
    process.exitCode = 1;
});

async function verifyManifest() {
    const androidManifest = await AndroidConfig.Manifest.readAndroidManifestAsync(manifestPath);
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);

    assert(
        mainApplication.$?.['android:usesCleartextTraffic'] === 'true',
        'android:usesCleartextTraffic must be true',
    );

    const metadata = mainApplication['meta-data'] ?? [];
    const updatesEnabled = metadata.find(
        (entry) => entry.$?.['android:name'] === 'expo.modules.updates.ENABLED',
    );
    assert(
        updatesEnabled?.$?.['android:value'] === 'false',
        'expo.modules.updates.ENABLED must be false',
    );
    assert(
        !metadata.some((entry) => entry.$?.['android:name'] === 'expo.modules.updates.EXPO_UPDATE_URL'),
        'expo.modules.updates.EXPO_UPDATE_URL must be absent',
    );

    console.log('Generated Android manifest verified');
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
