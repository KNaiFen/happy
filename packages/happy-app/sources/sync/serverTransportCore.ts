import {
    ServerUrlPolicyError,
    validateServerUrlForRuntime,
    type ServerUrlRuntime,
} from './serverUrlPolicy';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

export interface NativeRelayRequest {
    url: string;
    method: string;
    headers: Array<[string, string]>;
    bodyBase64: string | null;
}

export interface NativeRelayPolicy {
    baseUrl: string;
    allowInsecureHttp: boolean;
}

export interface NativeRelayResponse {
    status: number;
    statusText: string;
    url: string;
    headers: Array<[string, string]>;
    bodyBase64: string;
}

interface ServerFetchDependencies {
    browserFetch: typeof fetch;
    invokeNative: (request: NativeRelayRequest) => Promise<NativeRelayResponse>;
    invokeNativeProbe: (policy: NativeRelayPolicy) => Promise<NativeRelayResponse>;
    getServerUrl: () => string;
    getRuntime: () => ServerUrlRuntime;
    getAllowInsecureHttp: () => boolean;
}

export type ServerFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>;

export function createServerFetch(dependencies: ServerFetchDependencies): ServerFetch {
    return async (input, init) => {
        const baseInput = dependencies.getServerUrl();
        const runtime = dependencies.getRuntime();
        const allowInsecureHttp = dependencies.getAllowInsecureHttp();
        const baseValidation = validateServerUrlForRuntime(baseInput, {
            runtime,
            allowInsecureHttp,
        });
        const targetUrl = resolveRequestUrl(input, baseInput);
        const baseUrl = baseValidation.valid ? baseValidation.normalizedUrl : baseInput.trim();

        if (!sameOrigin(targetUrl, baseUrl)) {
            return dependencies.browserFetch(input, init);
        }
        if (!baseValidation.valid) {
            throw new ServerUrlPolicyError(baseValidation.errorCode);
        }

        if (runtime !== 'tauri') {
            return dependencies.browserFetch(input, init);
        }

        const request = input instanceof Request
            ? new Request(input, init)
            : new Request(targetUrl, init);
        throwIfAborted(request.signal);
        const bodyBuffer = await request.arrayBuffer();
        const nativeResponse = await dependencies.invokeNative({
            url: request.url,
            method: request.method,
            headers: Array.from(request.headers.entries()),
            bodyBase64: bodyBuffer.byteLength > 0
                ? encodeBase64(new Uint8Array(bodyBuffer))
                : null,
        });

        throwIfAborted(request.signal);
        return nativeRelayResponse(nativeResponse);
    };
}

export function createServerHealthProbe(
    dependencies: ServerFetchDependencies,
): (serverUrl: string, allowInsecureHttp: boolean) => Promise<Response> {
    return async (serverUrl, allowInsecureHttp) => {
        const runtime = dependencies.getRuntime();
        const validation = validateServerUrlForRuntime(serverUrl, {
            runtime,
            allowInsecureHttp,
        });
        if (!validation.valid) {
            throw new ServerUrlPolicyError(validation.errorCode);
        }

        const policy: NativeRelayPolicy = {
            baseUrl: validation.normalizedUrl,
            allowInsecureHttp,
        };
        if (runtime === 'tauri') {
            return nativeRelayResponse(await dependencies.invokeNativeProbe(policy));
        }
        return dependencies.browserFetch(`${policy.baseUrl}/health`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            redirect: 'error',
        });
    };
}

function resolveRequestUrl(input: RequestInfo | URL, baseUrl: string): string {
    if (typeof input === 'string') return new URL(input, baseUrl).toString();
    if (input instanceof URL) return input.toString();
    return input.url;
}

function sameOrigin(targetUrl: string, baseUrl: string): boolean {
    try {
        return new URL(targetUrl).origin === new URL(baseUrl).origin;
    } catch {
        return false;
    }
}

function nativeRelayResponse(nativeResponse: NativeRelayResponse): Response {
    // decodeBase64 always allocates its own Uint8Array-backed ArrayBuffer.
    const body: ArrayBuffer | null = nativeResponse.status === 204
        || nativeResponse.status === 205
        || nativeResponse.status === 304
        ? null
        : decodeBase64(nativeResponse.bodyBase64).buffer as ArrayBuffer;
    const response = new Response(body, {
        status: nativeResponse.status,
        statusText: nativeResponse.statusText,
        headers: nativeResponse.headers,
    });
    Object.defineProperty(response, 'url', { value: nativeResponse.url });
    return response;
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
    }
}
