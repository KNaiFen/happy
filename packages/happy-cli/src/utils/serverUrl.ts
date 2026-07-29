import { isIP } from 'node:net';

export interface ServerUrlOptions {
    host: string;
    port: number;
    publicUrl?: string;
}

export interface ResolvedServerUrls {
    bindHost: string;
    bindUrl: string;
    localUrl: string;
    advertisedUrl: string;
}

export function resolveServerUrls(options: ServerUrlOptions): ResolvedServerUrls {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
        throw new Error('Server port must be an integer between 1 and 65535');
    }

    const bindHost = normalizeBindHost(options.host);
    const localHost = bindHost === '0.0.0.0'
        ? '127.0.0.1'
        : bindHost === '::'
            ? '::1'
            : bindHost;
    const bindUrl = `http://${formatUrlHost(bindHost)}:${options.port}`;
    const localUrl = `http://${formatUrlHost(localHost)}:${options.port}`;

    return {
        bindHost,
        bindUrl,
        localUrl,
        advertisedUrl: options.publicUrl
            ? normalizePublicUrl(options.publicUrl)
            : localUrl,
    };
}

export function isInsecureHttpUrl(value: string): boolean {
    try {
        return new URL(value).protocol === 'http:';
    } catch {
        return false;
    }
}

export function getInsecureRelayWarning(serverUrl: string): string {
    const displayUrl = safeDisplayOrigin(serverUrl);
    return (
        `Security warning: ${displayUrl} uses insecure HTTP. Use it only on a trusted network. ` +
        'Against an active MITM, Happy cannot protect the bearer token, server identity, ' +
        'mutation acknowledgements, or transport metadata, and the zero-loss guarantee does not apply.'
    );
}

export function normalizeRelayOrigin(value: string): string {
    let parsed: URL;
    try {
        parsed = new URL(value.trim());
    } catch {
        throw new Error('Happy Server URL is invalid');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Happy Server URL must use HTTP or HTTPS');
    }
    if (parsed.username || parsed.password) {
        throw new Error('Happy Server URL cannot contain credentials');
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new Error('Happy Server URL must be an origin without path, query, or fragment');
    }
    return parsed.origin;
}

function safeDisplayOrigin(value: string): string {
    try {
        return new URL(value).origin;
    } catch {
        return 'the configured relay';
    }
}

function normalizeBindHost(value: string): string {
    const trimmed = value.trim();
    const hasOpeningBracket = trimmed.startsWith('[');
    const hasClosingBracket = trimmed.endsWith(']');
    if (hasOpeningBracket !== hasClosingBracket) {
        throw new Error('Invalid server bind host');
    }
    const host = hasOpeningBracket ? trimmed.slice(1, -1) : trimmed;
    if (!host) throw new Error('Server host cannot be empty');
    const ipVersion = isIP(host);
    if (hasOpeningBracket && ipVersion !== 6) {
        throw new Error('Invalid server bind host');
    }
    if (ipVersion !== 0) return host;
    const labels = host.split('.');
    if (host.length > 253 || labels.some((label) => (
        label.length === 0
        || label.length > 63
        || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)
    ))) {
        throw new Error('Invalid server bind host');
    }
    return host.toLowerCase();
}

function formatUrlHost(host: string): string {
    return isIP(host) === 6 ? `[${host}]` : host;
}

function normalizePublicUrl(value: string): string {
    try {
        return normalizeRelayOrigin(value);
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message.includes('must use HTTP or HTTPS')) {
            throw new Error('--public-url must use HTTP or HTTPS');
        }
        if (message.includes('cannot contain credentials')) {
            throw new Error('--public-url cannot contain credentials');
        }
        if (message.includes('must be an origin')) {
            throw new Error('--public-url must be an origin without path, query, or fragment');
        }
        throw new Error('Invalid --public-url');
    }
}
