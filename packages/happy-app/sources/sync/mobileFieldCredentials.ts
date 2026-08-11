import type { AuthCredentials } from '@/auth/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

const MAX_RESPONSE_CHARACTERS = 16 * 1024;
const INVALID_BASE64URL_CHARACTER = /[^A-Za-z0-9_-]/;

function isCompactJws(value: string): boolean {
    if (value.length < 5 || value.length > 4096) {
        return false;
    }
    const segments = value.split('.');
    return segments.length === 3 && segments.every(
        (segment) => segment.length > 0 && !INVALID_BASE64URL_CHARACTER.test(segment),
    );
}

function isCanonical32ByteBase64Url(value: string): boolean {
    if (value.length !== 43 || INVALID_BASE64URL_CHARACTER.test(value)) {
        return false;
    }
    try {
        const decoded = decodeBase64(value, 'base64url');
        return decoded.length === 32 && encodeBase64(decoded, 'base64url') === value;
    } catch {
        return false;
    }
}

function assertLoopbackCredentialsUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Mobile Field credential URL is invalid');
    }
    if (
        url.protocol !== 'http:'
        || url.hostname !== '127.0.0.1'
        || !/^\d+$/.test(url.port)
        || Number(url.port) < 1
        || Number(url.port) > 65535
        || url.pathname !== '/credentials'
        || url.username !== ''
        || url.password !== ''
        || url.search !== ''
        || url.hash !== ''
    ) {
        throw new Error('Mobile Field credentials must come from the loopback endpoint');
    }
    return url.href;
}

function parseCredentials(value: unknown): AuthCredentials {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Mobile Field credential response is malformed');
    }
    const record = value as Record<string, unknown>;
    if (
        Object.keys(record).sort().join(',') !== 'secret,token'
        || typeof record.token !== 'string'
        || !isCompactJws(record.token)
        || typeof record.secret !== 'string'
        || !isCanonical32ByteBase64Url(record.secret)
    ) {
        throw new Error('Mobile Field credential response is malformed');
    }
    return { token: record.token, secret: record.secret };
}

export async function fetchMobileFieldCredentials(
    mobileFieldE2E: boolean,
    bootstrapUrl: string | undefined,
    fetchImpl: typeof fetch = fetch,
): Promise<AuthCredentials | null> {
    if (!mobileFieldE2E) {
        return null;
    }
    if (!bootstrapUrl) {
        throw new Error('Mobile Field credential URL is missing');
    }
    const url = assertLoopbackCredentialsUrl(bootstrapUrl);
    const response = await fetchImpl(url, {
        method: 'GET',
        // React Native's whatwg-fetch appends a cache-busting query for
        // RequestInit.cache, which would violate the exact loopback route.
        headers: {
            Accept: 'application/json',
            'Cache-Control': 'no-store',
        },
        redirect: 'error',
    });
    if (!response.ok) {
        throw new Error(`Mobile Field credential request failed with status ${response.status}`);
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
        throw new Error('Mobile Field credential response has an invalid content type');
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_CHARACTERS)) {
        throw new Error('Mobile Field credential response exceeds its size limit');
    }
    const body = await response.text();
    if (body.length === 0 || body.length > MAX_RESPONSE_CHARACTERS) {
        throw new Error('Mobile Field credential response exceeds its size limit');
    }
    try {
        return parseCredentials(JSON.parse(body));
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error('Mobile Field credential response is not valid JSON');
        }
        throw error;
    }
}
