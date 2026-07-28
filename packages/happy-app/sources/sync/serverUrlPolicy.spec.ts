import { describe, expect, it } from 'vitest';
import {
    resolveServerUrl,
    ServerUrlPolicyError,
    validateServerUrlForRuntime,
} from './serverUrlPolicy';

describe('server URL policy', () => {
    it('normalizes an HTTPS base URL and removes trailing slashes', () => {
        expect(validateServerUrlForRuntime(' https://relay.example.test/// ', {
            runtime: 'native',
            allowInsecureHttp: false,
        })).toEqual({
            valid: true,
            normalizedUrl: 'https://relay.example.test',
        });
    });

    it.each([
        ['ftp://relay.example.test', 'unsupportedProtocol'],
        ['https://user:secret@relay.example.test', 'credentialsNotAllowed'],
        ['https://relay.example.test?token=secret', 'queryNotAllowed'],
        ['https://relay.example.test/#fragment', 'fragmentNotAllowed'],
        ['not a URL', 'invalidUrl'],
    ] as const)('rejects %s with %s', (input, errorCode) => {
        expect(validateServerUrlForRuntime(input, {
            runtime: 'native',
            allowInsecureHttp: true,
        })).toMatchObject({
            valid: false,
            errorCode,
        });
    });

    it('requires explicit insecure HTTP authorization on native and Tauri', () => {
        for (const runtime of ['native', 'tauri'] as const) {
            expect(validateServerUrlForRuntime('http://192.168.1.20:3005', {
                runtime,
                allowInsecureHttp: false,
            })).toMatchObject({
                valid: false,
                errorCode: 'insecureHttpNotAllowed',
            });
            expect(validateServerUrlForRuntime('http://192.168.1.20:3005', {
                runtime,
                allowInsecureHttp: true,
            })).toEqual({
                valid: true,
                normalizedUrl: 'http://192.168.1.20:3005',
            });
        }
    });

    it.each([
        'http://localhost:3005',
        'http://dev.localhost:3005',
        'http://127.0.0.42:3005',
        'http://[::1]:3005',
    ])('allows Web loopback HTTP: %s', (url) => {
        expect(validateServerUrlForRuntime(url, {
            runtime: 'web',
            allowInsecureHttp: false,
        }).valid).toBe(true);
    });

    it.each([
        'http://192.168.1.20:3005',
        'http://localhost.example.test:3005',
        'http://0.0.0.0:3005',
    ])('rejects non-loopback Web HTTP: %s', (url) => {
        expect(validateServerUrlForRuntime(url, {
            runtime: 'web',
            allowInsecureHttp: true,
        })).toMatchObject({
            valid: false,
            errorCode: 'webHttpRequiresLoopback',
        });
    });
});

describe('server URL resolution', () => {
    it('uses a persisted URL before injected or bundled defaults', () => {
        expect(resolveServerUrl({
            persistedUrl: 'https://saved.example.test/',
            injectedUrl: 'https://injected.example.test',
            useWindowLocationOrigin: true,
            windowLocationOrigin: 'http://localhost:3005',
            environmentUrl: 'https://env.example.test',
            defaultUrl: 'https://default.example.test',
        })).toBe('https://saved.example.test');
    });

    it('uses window.location.origin only for an explicitly bundled Web app', () => {
        expect(resolveServerUrl({
            useWindowLocationOrigin: true,
            windowLocationOrigin: 'http://localhost:3005/',
            defaultUrl: 'https://default.example.test',
        })).toBe('http://localhost:3005');
        expect(resolveServerUrl({
            useWindowLocationOrigin: false,
            windowLocationOrigin: 'https://app.example.test',
            defaultUrl: 'https://default.example.test',
        })).toBe('https://default.example.test');
    });
});

describe('server URL policy errors', () => {
    it('preserves the policy code for selective startup recovery', () => {
        const error = new ServerUrlPolicyError('insecureHttpNotAllowed');

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('ServerUrlPolicyError');
        expect(error.errorCode).toBe('insecureHttpNotAllowed');
    });
});
