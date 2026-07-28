import { describe, expect, it, vi } from 'vitest';
import {
    createServerFetch,
    createServerHealthProbe,
    type NativeRelayRequest,
    type NativeRelayResponse,
} from './serverTransportCore';

function response(status = 200, body = 'browser'): Response {
    return new Response(body, { status });
}

describe('server transport', () => {
    it('rejects native HTTP before making a browser request when opt-in is disabled', async () => {
        const browserFetch = vi.fn(async () => response());
        const serverFetch = createServerFetch({
            browserFetch,
            invokeNative: vi.fn(),
            invokeNativeProbe: vi.fn(),
            getServerUrl: () => 'http://192.168.1.20:3005',
            getRuntime: () => 'native',
            getAllowInsecureHttp: () => false,
        });

        await expect(serverFetch('http://192.168.1.20:3005/health'))
            .rejects.toThrow('insecureHttpNotAllowed');
        expect(browserFetch).not.toHaveBeenCalled();
    });

    it('rejects non-loopback Web HTTP even if local storage claims it is allowed', async () => {
        const browserFetch = vi.fn(async () => response());
        const serverFetch = createServerFetch({
            browserFetch,
            invokeNative: vi.fn(),
            invokeNativeProbe: vi.fn(),
            getServerUrl: () => 'http://192.168.1.20:3005',
            getRuntime: () => 'web',
            getAllowInsecureHttp: () => true,
        });

        await expect(serverFetch('http://192.168.1.20:3005/health'))
            .rejects.toThrow('webHttpRequiresLoopback');
        expect(browserFetch).not.toHaveBeenCalled();
    });

    it('uses the native request command only for the configured Tauri relay origin', async () => {
        const browserFetch = vi.fn(async () => response());
        const nativeResponse: NativeRelayResponse = {
            status: 200,
            statusText: 'OK',
            url: 'http://192.168.1.20:3005/v4/capabilities',
            headers: [['content-type', 'application/json']],
            bodyBase64: btoa('{"ok":true}'),
        };
        const invokeNative = vi.fn(async (_request: NativeRelayRequest) => nativeResponse);
        const serverFetch = createServerFetch({
            browserFetch,
            invokeNative,
            invokeNativeProbe: vi.fn(),
            getServerUrl: () => 'http://192.168.1.20:3005',
            getRuntime: () => 'tauri',
            getAllowInsecureHttp: () => true,
        });

        const result = await serverFetch('http://192.168.1.20:3005/v4/capabilities', {
            headers: { Authorization: 'Bearer token' },
        });

        expect(await result.json()).toEqual({ ok: true });
        expect(browserFetch).not.toHaveBeenCalled();
        expect(invokeNative).toHaveBeenCalledWith(expect.objectContaining({
            url: 'http://192.168.1.20:3005/v4/capabilities',
            method: 'GET',
            headers: expect.arrayContaining([['authorization', 'Bearer token']]),
            bodyBase64: null,
        }));
        expect(invokeNative.mock.calls[0]?.[0]).not.toHaveProperty('baseUrl');
        expect(invokeNative.mock.calls[0]?.[0]).not.toHaveProperty('allowInsecureHttp');
    });

    it('keeps third-party HTTPS requests on the browser transport', async () => {
        const browserFetch = vi.fn(async () => response(200, 'external'));
        const invokeNative = vi.fn();
        const serverFetch = createServerFetch({
            browserFetch,
            invokeNative,
            invokeNativeProbe: vi.fn(),
            getServerUrl: () => 'http://192.168.1.20:3005',
            getRuntime: () => 'tauri',
            getAllowInsecureHttp: () => true,
        });

        const result = await serverFetch('https://files.example.test/object');

        expect(await result.text()).toBe('external');
        expect(browserFetch).toHaveBeenCalledOnce();
        expect(invokeNative).not.toHaveBeenCalled();
    });

    it('uses a separate credential-free native probe for a pre-save candidate', async () => {
        const browserFetch = vi.fn(async () => response());
        const invokeNative = vi.fn();
        const invokeNativeProbe = vi.fn(async () => ({
            status: 200,
            statusText: 'OK',
            url: 'http://10.0.0.8:3005/health',
            headers: [],
            bodyBase64: '',
        }));
        const probeServerHealth = createServerHealthProbe({
            browserFetch,
            invokeNative,
            invokeNativeProbe,
            getServerUrl: () => 'https://api.example.test',
            getRuntime: () => 'tauri',
            getAllowInsecureHttp: () => false,
        });

        await probeServerHealth('http://10.0.0.8:3005', true);

        expect(invokeNativeProbe).toHaveBeenCalledWith({
            baseUrl: 'http://10.0.0.8:3005',
            allowInsecureHttp: true,
        });
        expect(invokeNative).not.toHaveBeenCalled();
        expect(browserFetch).not.toHaveBeenCalled();
    });

    it('resolves relative relay URLs before constructing the native request', async () => {
        const invokeNative = vi.fn(async () => ({
            status: 204,
            statusText: 'No Content',
            url: 'https://relay.example.test/v4/capabilities',
            headers: [],
            bodyBase64: '',
        }));
        const serverFetch = createServerFetch({
            browserFetch: vi.fn(),
            invokeNative,
            invokeNativeProbe: vi.fn(),
            getServerUrl: () => 'https://relay.example.test',
            getRuntime: () => 'tauri',
            getAllowInsecureHttp: () => false,
        });

        await serverFetch('/v4/capabilities');

        expect(invokeNative).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://relay.example.test/v4/capabilities',
        }));
    });

    it('encodes request bodies as bounded-string IPC payloads', async () => {
        const invokeNative = vi.fn(async (request: NativeRelayRequest) => ({
            status: 200,
            statusText: 'OK',
            url: request.url,
            headers: [],
            bodyBase64: request.bodyBase64 ?? '',
        }));
        const serverFetch = createServerFetch({
            browserFetch: vi.fn(),
            invokeNative,
            invokeNativeProbe: vi.fn(),
            getServerUrl: () => 'https://relay.example.test',
            getRuntime: () => 'tauri',
            getAllowInsecureHttp: () => false,
        });

        const result = await serverFetch('/echo', {
            method: 'POST',
            body: new Uint8Array([0, 1, 127, 255]),
        });

        expect(invokeNative).toHaveBeenCalledWith(expect.objectContaining({
            bodyBase64: 'AAF//w==',
        }));
        expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([0, 1, 127, 255]);
    });
});
