import { invoke } from '@tauri-apps/api/core';
import {
    createServerHealthProbe,
    createServerFetch,
    type NativeRelayRequest,
    type NativeRelayPolicy,
    type NativeRelayResponse,
} from './serverTransportCore';
import {
    assertServerUrlAllowed,
    getAllowInsecureHttp,
    getServerUrl,
    getServerUrlRuntime,
} from './serverConfig';
import { AsyncLock } from '@/utils/lock';

let originalFetch: typeof fetch | null = null;
let isInstalled = false;
const policyCommitLock = new AsyncLock();

const transportDependencies = {
    browserFetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const implementation = originalFetch ?? globalThis.fetch.bind(globalThis);
        return implementation(input, init);
    },
    invokeNative: invokeCommittedRelayRequest,
    invokeNativeProbe: (request: NativeRelayPolicy) => (
        invoke<NativeRelayResponse>('relay_http_probe', { request })
    ),
    getServerUrl,
    getRuntime: getServerUrlRuntime,
    getAllowInsecureHttp,
};

const transportFetch = createServerFetch(transportDependencies);
const transportHealthProbe = createServerHealthProbe(transportDependencies);

export function serverFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<Response> {
    return transportFetch(input, init);
}

export function probeServerHealth(
    serverUrl: string,
    allowInsecureHttp: boolean,
): Promise<Response> {
    return transportHealthProbe(serverUrl, allowInsecureHttp);
}

export function installServerFetchTransport(): void {
    if (isInstalled) return;
    originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => (
        serverFetch(input, init)
    )) as typeof fetch;
    isInstalled = true;
}

export async function commitServerTransportPolicy(): Promise<void> {
    await policyCommitLock.inLock(commitCurrentServerTransportPolicy);
}

async function commitCurrentServerTransportPolicy(): Promise<void> {
    const runtime = getServerUrlRuntime();
    let baseUrl: string;
    try {
        baseUrl = assertServerUrlAllowed();
    } catch (error) {
        if (runtime === 'tauri') {
            await invoke('relay_http_clear_policy');
        }
        throw error;
    }

    if (runtime !== 'tauri') return;
    const policy: NativeRelayPolicy = {
        baseUrl,
        allowInsecureHttp: getAllowInsecureHttp(),
    };
    await invoke('relay_http_set_policy', { policy });
}

function invokeCommittedRelayRequest(
    request: NativeRelayRequest,
): Promise<NativeRelayResponse> {
    return invoke<NativeRelayResponse>('relay_http_request', { request });
}
