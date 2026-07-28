export type ServerUrlRuntime = 'native' | 'tauri' | 'web';

export type ServerUrlErrorCode =
    | 'empty'
    | 'invalidUrl'
    | 'unsupportedProtocol'
    | 'credentialsNotAllowed'
    | 'queryNotAllowed'
    | 'fragmentNotAllowed'
    | 'insecureHttpNotAllowed'
    | 'webHttpRequiresLoopback';

export type ServerUrlValidationResult =
    | { valid: true; normalizedUrl: string }
    | { valid: false; errorCode: ServerUrlErrorCode };

export interface ServerUrlPolicy {
    runtime: ServerUrlRuntime;
    allowInsecureHttp: boolean;
}

export class ServerUrlPolicyError extends Error {
    constructor(readonly errorCode: ServerUrlErrorCode) {
        super(`Server URL is not allowed: ${errorCode}`);
        this.name = 'ServerUrlPolicyError';
    }
}

interface ServerUrlResolution {
    persistedUrl?: string | null;
    injectedUrl?: string | null;
    useWindowLocationOrigin?: boolean;
    windowLocationOrigin?: string | null;
    environmentUrl?: string | null;
    defaultUrl: string;
}

export function validateServerUrlForRuntime(
    input: string,
    policy: ServerUrlPolicy,
): ServerUrlValidationResult {
    const value = input.trim();
    if (!value) return { valid: false, errorCode: 'empty' };

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return { valid: false, errorCode: 'invalidUrl' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { valid: false, errorCode: 'unsupportedProtocol' };
    }
    if (parsed.username || parsed.password) {
        return { valid: false, errorCode: 'credentialsNotAllowed' };
    }
    if (parsed.search) {
        return { valid: false, errorCode: 'queryNotAllowed' };
    }
    if (parsed.hash) {
        return { valid: false, errorCode: 'fragmentNotAllowed' };
    }

    if (parsed.protocol === 'http:') {
        if (policy.runtime === 'web') {
            if (!isLoopbackHostname(parsed.hostname)) {
                return { valid: false, errorCode: 'webHttpRequiresLoopback' };
            }
        } else if (!policy.allowInsecureHttp) {
            return { valid: false, errorCode: 'insecureHttpNotAllowed' };
        }
    }

    return {
        valid: true,
        normalizedUrl: normalizeParsedServerUrl(parsed),
    };
}

export function resolveServerUrl(input: ServerUrlResolution): string {
    const selected = [
        input.persistedUrl,
        input.injectedUrl,
        input.useWindowLocationOrigin ? input.windowLocationOrigin : null,
        input.environmentUrl,
        input.defaultUrl,
    ].find((value): value is string => typeof value === 'string' && value.trim().length > 0);

    const value = (selected ?? input.defaultUrl).trim();
    try {
        return normalizeParsedServerUrl(new URL(value));
    } catch {
        return value.replace(/\/+$/, '');
    }
}

export function isLoopbackHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') {
        return true;
    }

    const octets = normalized.split('.');
    if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) {
        return false;
    }
    const numbers = octets.map(Number);
    return numbers.every((octet) => octet >= 0 && octet <= 255) && numbers[0] === 127;
}

function normalizeParsedServerUrl(parsed: URL): string {
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${pathname}`;
}
