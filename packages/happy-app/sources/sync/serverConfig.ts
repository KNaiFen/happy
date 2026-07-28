import { MMKV } from 'react-native-mmkv';
import { Platform } from 'react-native';
import { isTauri } from '@/utils/isTauri';
import {
    resolveServerUrl,
    ServerUrlPolicyError,
    validateServerUrlForRuntime,
    type ServerUrlErrorCode,
    type ServerUrlPolicy,
    type ServerUrlRuntime,
} from './serverUrlPolicy';

// Separate MMKV instance for server config that persists across logouts
const serverConfigStorage = new MMKV({ id: 'server-config' });

const SERVER_KEY = 'custom-server-url';
const LOG_SERVER_KEY = 'log-server-url';
const ALLOW_INSECURE_HTTP_KEY = 'allow-insecure-http';
const DEFAULT_SERVER_URL = 'https://api.cluster-fluster.com';

export function getServerUrl(): string {
    const injected = (globalThis as {
        __HAPPY_CONFIG__?: {
            serverUrl?: string;
            useWindowLocationOrigin?: boolean;
        };
    }).__HAPPY_CONFIG__;
    return resolveServerUrl({
        persistedUrl: serverConfigStorage.getString(SERVER_KEY),
        injectedUrl: injected?.serverUrl,
        useWindowLocationOrigin: injected?.useWindowLocationOrigin === true,
        windowLocationOrigin: Platform.OS === 'web' && typeof window !== 'undefined'
            ? window.location.origin
            : null,
        environmentUrl:
            process.env.EXPO_PUBLIC_HAPPY_SERVER_URL ||
            process.env.EXPO_PUBLIC_SERVER_URL,
        defaultUrl: DEFAULT_SERVER_URL,
    });
}

export function setServerUrl(url: string | null): void {
    if (url && url.trim()) {
        const validation = validateServerUrl(url);
        if (!validation.valid) {
            throw new Error(validation.errorCode);
        }
        serverConfigStorage.set(SERVER_KEY, validation.normalizedUrl);
    } else {
        serverConfigStorage.delete(SERVER_KEY);
    }
}

export function getAllowInsecureHttp(): boolean {
    return serverConfigStorage.getBoolean(ALLOW_INSECURE_HTTP_KEY) === true;
}

export function setAllowInsecureHttp(value: boolean): void {
    if (value) {
        serverConfigStorage.set(ALLOW_INSECURE_HTTP_KEY, true);
    } else {
        serverConfigStorage.delete(ALLOW_INSECURE_HTTP_KEY);
    }
}

export function getLogServerUrl(): string | null {
    return serverConfigStorage.getString(LOG_SERVER_KEY) ||
           process.env.EXPO_PUBLIC_LOG_SERVER_URL ||
           null;
}

export function setLogServerUrl(url: string | null): void {
    if (url && url.trim()) {
        serverConfigStorage.set(LOG_SERVER_KEY, url.trim());
    } else {
        serverConfigStorage.delete(LOG_SERVER_KEY);
    }
}

export function isUsingCustomServer(): boolean {
    return getServerUrl() !== DEFAULT_SERVER_URL;
}

export function getServerInfo(): { hostname: string; port?: number; isCustom: boolean } {
    const url = getServerUrl();
    const isCustom = isUsingCustomServer();
    
    try {
        const parsed = new URL(url);
        const port = parsed.port ? parseInt(parsed.port) : undefined;
        return {
            hostname: parsed.hostname,
            port,
            isCustom
        };
    } catch {
        // Fallback if URL parsing fails
        return {
            hostname: url,
            port: undefined,
            isCustom
        };
    }
}

export type ServerUrlValidation = {
    valid: true;
    normalizedUrl: string;
} | {
    valid: false;
    errorCode: ServerUrlErrorCode;
    error: string;
};

export function validateServerUrl(
    url: string,
    overrides: Partial<ServerUrlPolicy> = {},
): ServerUrlValidation {
    const validation = validateServerUrlForRuntime(url, {
        runtime: overrides.runtime ?? getServerUrlRuntime(),
        allowInsecureHttp: overrides.allowInsecureHttp ?? getAllowInsecureHttp(),
    });
    if (validation.valid) return validation;
    return {
        ...validation,
        error: serverUrlErrorMessage(validation.errorCode),
    };
}

export function assertServerUrlAllowed(
    url: string = getServerUrl(),
    overrides: Partial<ServerUrlPolicy> = {},
): string {
    const validation = validateServerUrl(url, overrides);
    if (!validation.valid) {
        throw new ServerUrlPolicyError(validation.errorCode);
    }
    return validation.normalizedUrl;
}

export function getServerUrlRuntime(): ServerUrlRuntime {
    if (isTauri()) return 'tauri';
    return Platform.OS === 'web' ? 'web' : 'native';
}

function serverUrlErrorMessage(errorCode: ServerUrlErrorCode): string {
    switch (errorCode) {
        case 'empty':
            return 'Server URL cannot be empty';
        case 'invalidUrl':
            return 'Invalid URL format';
        case 'unsupportedProtocol':
            return 'Server URL must use HTTP or HTTPS';
        case 'credentialsNotAllowed':
            return 'Server URL cannot contain credentials';
        case 'queryNotAllowed':
            return 'Server URL cannot contain a query string';
        case 'fragmentNotAllowed':
            return 'Server URL cannot contain a fragment';
        case 'insecureHttpNotAllowed':
            return 'Enable insecure HTTP before using this server';
        case 'webHttpRequiresLoopback':
            return 'Web only supports HTTP servers on localhost';
    }
}
