import { describe, expect, it, vi } from 'vitest';
import { fetchMobileFieldCredentials } from './mobileFieldCredentials';

const credentials = {
    token: 'field-header.field-payload.field-signature',
    secret: `${'a'.repeat(42)}A`,
};

function response(body: unknown, init: ResponseInit = {}): Response {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, {
        ...init,
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json', ...init.headers },
    });
}

describe('fetchMobileFieldCredentials', () => {
    it('does nothing outside an explicitly marked Field build', async () => {
        const fetchImpl = vi.fn<typeof fetch>();
        await expect(fetchMobileFieldCredentials(false, 'http://127.0.0.1:53587/credentials', fetchImpl))
            .resolves.toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('fails closed when an explicitly marked Field build has no endpoint', async () => {
        await expect(fetchMobileFieldCredentials(true, undefined, vi.fn<typeof fetch>()))
            .rejects.toThrow(/URL is missing/);
    });

    it('loads bounded credentials only from the exact loopback endpoint', async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(credentials));
        await expect(fetchMobileFieldCredentials(
            true,
            'http://127.0.0.1:53587/credentials',
            fetchImpl,
        )).resolves.toEqual(credentials);
        expect(fetchImpl).toHaveBeenCalledWith(
            'http://127.0.0.1:53587/credentials',
            expect.objectContaining({
                headers: expect.objectContaining({ 'Cache-Control': 'no-store' }),
                redirect: 'error',
            }),
        );
        expect(fetchImpl.mock.calls[0]?.[1]).not.toHaveProperty('cache');
    });

    it.each([
        'https://127.0.0.1:53587/credentials',
        'http://localhost:53587/credentials',
        'http://127.0.0.1:0/credentials',
        'http://127.0.0.1:53587/other',
        'http://user@127.0.0.1:53587/credentials',
        'http://127.0.0.1:53587/credentials?token=x',
    ])('rejects a non-canonical bootstrap URL: %s', async (url) => {
        await expect(fetchMobileFieldCredentials(true, url, vi.fn<typeof fetch>()))
            .rejects.toThrow(/loopback endpoint/);
    });

    it('rejects redirects, non-JSON, oversized, and malformed responses', async () => {
        await expect(fetchMobileFieldCredentials(
            true,
            'http://127.0.0.1:53587/credentials',
            vi.fn<typeof fetch>().mockResolvedValue(response('', { status: 302 })),
        )).rejects.toThrow(/status 302/);
        await expect(fetchMobileFieldCredentials(
            true,
            'http://127.0.0.1:53587/credentials',
            vi.fn<typeof fetch>().mockResolvedValue(response(credentials, {
                headers: { 'content-type': 'text/plain' },
            })),
        )).rejects.toThrow(/content type/);
        await expect(fetchMobileFieldCredentials(
            true,
            'http://127.0.0.1:53587/credentials',
            vi.fn<typeof fetch>().mockResolvedValue(response(credentials, {
                headers: { 'content-length': String(16 * 1024 + 1) },
            })),
        )).rejects.toThrow(/size limit/);
        await expect(fetchMobileFieldCredentials(
            true,
            'http://127.0.0.1:53587/credentials',
            vi.fn<typeof fetch>().mockResolvedValue(response({ ...credentials, extra: true })),
        )).rejects.toThrow(/malformed/);
        await expect(fetchMobileFieldCredentials(
            true,
            'http://127.0.0.1:53587/credentials',
            vi.fn<typeof fetch>().mockResolvedValue(response({ ...credentials, token: 'not.a.jws.extra' })),
        )).rejects.toThrow(/malformed/);
        await expect(fetchMobileFieldCredentials(
            true,
            'http://127.0.0.1:53587/credentials',
            vi.fn<typeof fetch>().mockResolvedValue(response({ ...credentials, secret: `${'a'.repeat(42)}B` })),
        )).rejects.toThrow(/malformed/);
    });
});
