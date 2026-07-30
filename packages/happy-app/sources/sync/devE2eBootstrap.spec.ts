import { describe, expect, it } from 'vitest';
import {
    shouldAllowE2EBootstrap,
    shouldEnableDevE2eInsecureHttp,
} from './devE2eBootstrap';

describe('shouldAllowE2EBootstrap', () => {
    it('allows ordinary development builds', () => {
        expect(shouldAllowE2EBootstrap(true, false)).toBe(true);
    });

    it('allows an explicitly marked standalone field build', () => {
        expect(shouldAllowE2EBootstrap(false, true)).toBe(true);
    });

    it('rejects unmarked non-development builds', () => {
        expect(shouldAllowE2EBootstrap(false, false)).toBe(false);
    });
});

describe('shouldEnableDevE2eInsecureHttp', () => {
    it('requires an explicit opt-in from an allowed E2E build', () => {
        expect(shouldEnableDevE2eInsecureHttp(true, '1')).toBe(true);
        expect(shouldEnableDevE2eInsecureHttp(false, '1', true)).toBe(true);
        expect(shouldEnableDevE2eInsecureHttp(true, 'true')).toBe(false);
        expect(shouldEnableDevE2eInsecureHttp(true, undefined)).toBe(false);
        expect(shouldEnableDevE2eInsecureHttp(false, '1')).toBe(false);
    });
});
