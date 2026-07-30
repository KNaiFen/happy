import { describe, expect, it } from 'vitest';
import { createAuthenticatedRequestHeaders } from './requestHeaders';

describe('createAuthenticatedRequestHeaders', () => {
    it('preserves Headers instances used by the Sync v4 transport', () => {
        const additionalHeaders = new Headers({
            'Content-Type': 'application/json',
            'X-Happy-Machine-Id': 'machine-1',
            'X-Happy-Sync-Trace': '0123456789abcdef0123456789abcdef',
        });

        const headers = createAuthenticatedRequestHeaders(
            'current-token',
            'android/1.11.15',
            additionalHeaders,
        );

        expect(headers.get('Authorization')).toBe('Bearer current-token');
        expect(headers.get('X-Happy-Client')).toBe('android/1.11.15');
        expect(headers.get('Content-Type')).toBe('application/json');
        expect(headers.get('X-Happy-Machine-Id')).toBe('machine-1');
        expect(headers.get('X-Happy-Sync-Trace')).toBe(
            '0123456789abcdef0123456789abcdef',
        );
    });

    it('accepts every standard HeadersInit representation', () => {
        for (const additionalHeaders of [
            { 'Content-Type': 'application/json' },
            [['Content-Type', 'application/json']] as Array<[string, string]>,
            new Headers({ 'Content-Type': 'application/json' }),
        ]) {
            const headers = createAuthenticatedRequestHeaders(
                'token',
                'android/1.11.15',
                additionalHeaders,
            );
            expect(headers.get('Content-Type')).toBe('application/json');
        }
    });

    it('does not allow a caller to replace current credentials or client identity', () => {
        const headers = createAuthenticatedRequestHeaders(
            'current-token',
            'android/1.11.15',
            {
                Authorization: 'Bearer stale-token',
                'X-Happy-Client': 'web/0.0.0',
            },
        );

        expect(headers.get('Authorization')).toBe('Bearer current-token');
        expect(headers.get('X-Happy-Client')).toBe('android/1.11.15');
    });
});
