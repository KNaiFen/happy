import { describe, expect, it } from 'vitest';
import { shouldEnableDevE2eInsecureHttp } from './devE2eBootstrap';

describe('shouldEnableDevE2eInsecureHttp', () => {
    it('requires both a development bundle and the explicit CI opt-in', () => {
        expect(shouldEnableDevE2eInsecureHttp(true, '1')).toBe(true);
        expect(shouldEnableDevE2eInsecureHttp(true, 'true')).toBe(false);
        expect(shouldEnableDevE2eInsecureHttp(true, undefined)).toBe(false);
        expect(shouldEnableDevE2eInsecureHttp(false, '1')).toBe(false);
    });
});
