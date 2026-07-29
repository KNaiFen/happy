import { describe, expect, it } from 'vitest';
import {
    getInsecureRelayWarning,
    isInsecureHttpUrl,
    normalizeRelayOrigin,
    resolveServerUrls,
} from './serverUrl';

describe('resolveServerUrls', () => {
    it('separates wildcard bind, loopback local, and advertised URLs', () => {
        expect(resolveServerUrls({
            host: '0.0.0.0',
            port: 3005,
            publicUrl: 'https://relay.example.test/',
        })).toEqual({
            bindHost: '0.0.0.0',
            bindUrl: 'http://0.0.0.0:3005',
            localUrl: 'http://127.0.0.1:3005',
            advertisedUrl: 'https://relay.example.test',
        });
    });

    it('uses the local URL as advertised URL when public URL is omitted', () => {
        expect(resolveServerUrls({
            host: ' [::] ',
            port: 4000,
        })).toEqual({
            bindHost: '::',
            bindUrl: 'http://[::]:4000',
            localUrl: 'http://[::1]:4000',
            advertisedUrl: 'http://[::1]:4000',
        });
    });

    it.each([
        { host: '127.0.0.1', port: 0 },
        { host: '127.0.0.1', port: 65_536 },
        { host: 'http://127.0.0.1', port: 3005 },
        { host: '127.0.0.1/path', port: 3005 },
        { host: '[::', port: 3005 },
        { host: '127.0.0.1]', port: 3005 },
        { host: '[127.0.0.1]', port: 3005 },
        { host: '[localhost]', port: 3005 },
        { host: '-relay.local', port: 3005 },
        { host: 'relay-.local', port: 3005 },
        { host: `${'a'.repeat(64)}.local`, port: 3005 },
    ])('rejects invalid bind input: %o', (input) => {
        expect(() => resolveServerUrls(input)).toThrow();
    });

    it.each([
        'ftp://relay.example.test',
        'https://user:secret@relay.example.test',
        'https://relay.example.test/base',
        'https://relay.example.test?token=secret',
        'https://relay.example.test/#fragment',
    ])('rejects invalid advertised URL: %s', (publicUrl) => {
        expect(() => resolveServerUrls({
            host: '127.0.0.1',
            port: 3005,
            publicUrl,
        })).toThrow();
    });
});

describe('normalizeRelayOrigin', () => {
    it.each([
        [' http://42.193.149.89:53586/ ', 'http://42.193.149.89:53586'],
        ['https://relay.example.test/', 'https://relay.example.test'],
        ['http://[2001:db8::1]:3005/', 'http://[2001:db8::1]:3005'],
    ])('normalizes %s to %s', (input, expected) => {
        expect(normalizeRelayOrigin(input)).toBe(expected);
    });

    it.each([
        'ftp://relay.example.test',
        'http://user:secret@relay.example.test',
        'http://relay.example.test/base',
        'http://relay.example.test?token=secret',
        'not-a-url',
    ])('rejects invalid relay identity input: %s', (input) => {
        expect(() => normalizeRelayOrigin(input)).toThrow();
    });
});

describe('insecure relay warning', () => {
    it('detects only HTTP URLs', () => {
        expect(isInsecureHttpUrl('http://relay.example.test')).toBe(true);
        expect(isInsecureHttpUrl('https://relay.example.test')).toBe(false);
        expect(isInsecureHttpUrl('invalid')).toBe(false);
    });

    it('states the trusted-network and active MITM limits', () => {
        const warning = getInsecureRelayWarning('http://relay.example.test');
        expect(warning).toContain('trusted network');
        expect(warning).toContain('active MITM');
        expect(warning).toContain('token');
        expect(warning).toContain('acknowledgements');
    });
});
