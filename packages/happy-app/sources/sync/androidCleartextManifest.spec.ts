import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { setAndroidCleartextTraffic } = require('../../plugins/withTrustedHttpRelayAndroid.js') as {
    setAndroidCleartextTraffic: (manifest: AndroidManifest) => AndroidManifest;
};

type AndroidManifest = {
    manifest: {
        application?: Array<{
            $?: Record<string, string>;
        }>;
    };
};

function createManifest(cleartextValue?: string): AndroidManifest {
    return {
        manifest: {
            application: [{
                $: {
                    'android:name': '.MainApplication',
                    ...(cleartextValue === undefined
                        ? {}
                        : { 'android:usesCleartextTraffic': cleartextValue }),
                },
            }],
        },
    };
}

describe('withTrustedHttpRelayAndroid', () => {
    it('writes the cleartext flag to the generated main application manifest', () => {
        const manifest = createManifest();

        expect(setAndroidCleartextTraffic(manifest)).toBe(manifest);
        expect(manifest.manifest.application?.[0]?.$?.['android:usesCleartextTraffic']).toBe('true');
    });

    it('overrides a stale false value idempotently', () => {
        const manifest = createManifest('false');

        setAndroidCleartextTraffic(manifest);
        setAndroidCleartextTraffic(manifest);

        expect(manifest.manifest.application?.[0]?.$?.['android:usesCleartextTraffic']).toBe('true');
    });

    it('rejects a manifest without the main application', () => {
        expect(() => setAndroidCleartextTraffic({ manifest: {} })).toThrow(
            'AndroidManifest.xml is missing the required MainApplication element',
        );
    });
});
