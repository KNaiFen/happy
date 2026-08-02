import WebSocket, { type RawData } from 'ws';

export const CODEX_APP_SERVER_MAX_RPC_BYTES = 4 * 1024 * 1024;

export interface CodexAppServerWebSocketEndpoint {
    socketPath?: string;
    url?: string;
    bearerToken?: string;
}

export function connectCodexAppServerWebSocket(
    endpoint: CodexAppServerWebSocketEndpoint,
): WebSocket {
    if ((endpoint.socketPath ? 1 : 0) + (endpoint.url ? 1 : 0) !== 1) {
        throw new Error('Exactly one Codex app-server WebSocket endpoint is required');
    }
    const headers = endpoint.bearerToken
        ? { authorization: `Bearer ${endpoint.bearerToken}` }
        : undefined;
    if (endpoint.socketPath) {
        if (endpoint.socketPath.includes(':')) {
            throw new Error('Codex app-server Unix socket path cannot contain a colon');
        }
        return new WebSocket(`ws+unix://${endpoint.socketPath}:/`, {
            headers,
            maxPayload: CODEX_APP_SERVER_MAX_RPC_BYTES,
        });
    }
    return new WebSocket(endpoint.url!, {
        headers,
        maxPayload: CODEX_APP_SERVER_MAX_RPC_BYTES,
    });
}

export function codexWebSocketRawDataBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    return Buffer.concat(data);
}
