import assert from 'node:assert/strict';
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'node:http';
import * as zlib from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const OFFICIAL_CODEX_RESPONSE_SENTINEL = 'Official Codex source E2E response';
export const OFFICIAL_CODEX_TOOL_SENTINEL = 'HAPPY_OFFICIAL_CODEX_TOOL_OK';

const maximumRequestBytes = 8 * 1024 * 1024;
const maximumDecodedRequestBytes = 32 * 1024 * 1024;
const toolCallId = 'happy-official-codex-tool-call';

interface RequestShape {
    contentEncoding: string;
    inputTypes: string[];
}

export interface CodexResponsesFixtureSnapshot {
    requestCount: number;
    toolOutputObserved: boolean;
    instructionSentinelObserved: boolean;
    requestShapes: RequestShape[];
}

export interface CodexResponsesFixtureOptions {
    expectedInstructionSentinel?: string;
}

export interface CodexResponsesFixture {
    baseUrl: string;
    snapshot(): CodexResponsesFixtureSnapshot;
    close(): Promise<void>;
}

export async function startCodexResponsesFixture(
    options: CodexResponsesFixtureOptions = {},
): Promise<CodexResponsesFixture> {
    const state: CodexResponsesFixtureSnapshot = {
        requestCount: 0,
        toolOutputObserved: false,
        instructionSentinelObserved: false,
        requestShapes: [],
    };
    const server = createServer((request, response) => {
        void handleRequest(
            request,
            response,
            state,
            options.expectedInstructionSentinel,
        ).catch((error: unknown) => {
            const errorName = error instanceof Error ? error.name : 'UnknownError';
            if (!response.headersSent) {
                response.writeHead(500, {
                    'Content-Type': 'application/json',
                    Connection: 'close',
                });
            }
            response.end(JSON.stringify({ error: errorName }));
        });
    });
    await listenOnLoopback(server);
    const address = server.address();
    assert(address && typeof address === 'object');

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        snapshot: () => structuredClone(state),
        close: () => closeServer(server),
    };
}

export async function writeCodexResponsesConfig(
    codexHome: string,
    fixtureBaseUrl: string,
): Promise<void> {
    assert.match(fixtureBaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    await mkdir(codexHome, { recursive: true });
    const config = [
        'model = "mock-model"',
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        'model_provider = "happy_ci_fixture"',
        '',
        '[model_providers.happy_ci_fixture]',
        'name = "Happy CI Responses fixture"',
        `base_url = "${fixtureBaseUrl}/v1"`,
        'wire_api = "responses"',
        'requires_openai_auth = false',
        'request_max_retries = 0',
        'stream_max_retries = 0',
        'supports_websockets = false',
        '',
    ].join('\n');
    await writeFile(join(codexHome, 'config.toml'), config, {
        encoding: 'utf8',
        mode: 0o600,
    });
}

async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    state: CodexResponsesFixtureSnapshot,
    expectedInstructionSentinel: string | undefined,
): Promise<void> {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method !== 'POST' || pathname !== '/v1/responses') {
        response.writeHead(404, { Connection: 'close' });
        response.end();
        return;
    }

    const contentEncoding = normalizeContentEncoding(request.headers['content-encoding']);
    const body = parseRequestBody(await readRequestBody(request), contentEncoding);
    const inputTypes = collectInputTypes(body);
    state.requestCount += 1;
    state.requestShapes.push({ contentEncoding, inputTypes });
    if (
        expectedInstructionSentinel
        && containsString(body, expectedInstructionSentinel)
    ) {
        state.instructionSentinelObserved = true;
    }
    if (containsToolOutput(body, toolCallId)) {
        state.toolOutputObserved = true;
    }
    if (state.requestCount === 2 && !state.toolOutputObserved) {
        throw new Error('Official Codex follow-up omitted function_call_output');
    }

    response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'close',
    });
    if (state.requestCount === 1) {
        writeEvents(response, toolCallEvents());
        response.end();
        return;
    }

    await writeFinalResponse(response);
}

function toolCallEvents(): Array<Record<string, unknown>> {
    const argumentsJson = JSON.stringify({
        command: `printf '%s\\n' ${OFFICIAL_CODEX_TOOL_SENTINEL}`,
        workdir: null,
        timeout_ms: 5_000,
    });
    return [
        responseCreated('happy-tool-response'),
        {
            type: 'response.output_item.done',
            item: {
                type: 'function_call',
                call_id: toolCallId,
                name: 'shell_command',
                arguments: argumentsJson,
            },
        },
        responseCompleted('happy-tool-response'),
    ];
}

async function writeFinalResponse(response: ServerResponse): Promise<void> {
    const messageId = 'happy-official-message';
    const reasoningId = 'happy-official-reasoning';
    const splitAt = Math.floor(OFFICIAL_CODEX_RESPONSE_SENTINEL.length / 2);
    const firstDelta = OFFICIAL_CODEX_RESPONSE_SENTINEL.slice(0, splitAt);
    const secondDelta = OFFICIAL_CODEX_RESPONSE_SENTINEL.slice(splitAt);
    const events: Array<Record<string, unknown>> = [
        responseCreated('happy-final-response'),
        {
            type: 'response.output_item.added',
            item: { type: 'reasoning', id: reasoningId, summary: [] },
        },
        {
            type: 'response.reasoning_summary_text.delta',
            delta: 'Verified the official app-server tool round trip.',
            summary_index: 0,
        },
        {
            type: 'response.output_item.done',
            item: {
                type: 'reasoning',
                id: reasoningId,
                summary: [{
                    type: 'summary_text',
                    text: 'Verified the official app-server tool round trip.',
                }],
                encrypted_content: Buffer.from('b'.repeat(550)).toString('base64'),
            },
        },
        {
            type: 'response.output_item.added',
            item: {
                type: 'message',
                role: 'assistant',
                id: messageId,
                content: [{ type: 'output_text', text: '' }],
            },
        },
        { type: 'response.output_text.delta', delta: firstDelta },
        { type: 'response.output_text.delta', delta: secondDelta },
        {
            type: 'response.output_item.done',
            item: {
                type: 'message',
                role: 'assistant',
                id: messageId,
                content: [{
                    type: 'output_text',
                    text: OFFICIAL_CODEX_RESPONSE_SENTINEL,
                }],
            },
        },
        responseCompleted('happy-final-response'),
    ];

    for (const [index, event] of events.entries()) {
        writeEvent(response, event);
        if (index > 3 && index < events.length - 1) {
            await delay(40);
        }
    }
    response.end();
}

function responseCreated(id: string): Record<string, unknown> {
    return {
        type: 'response.created',
        response: { id },
    };
}

function responseCompleted(id: string): Record<string, unknown> {
    return {
        type: 'response.completed',
        response: {
            id,
            usage: {
                input_tokens: 0,
                input_tokens_details: null,
                output_tokens: 0,
                output_tokens_details: null,
                total_tokens: 0,
            },
        },
    };
}

function writeEvents(
    response: ServerResponse,
    events: Array<Record<string, unknown>>,
): void {
    for (const event of events) writeEvent(response, event);
}

function writeEvent(response: ServerResponse, event: Record<string, unknown>): void {
    const type = event.type;
    assert.equal(typeof type, 'string');
    response.write(`event: ${type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > maximumRequestBytes) {
            throw new RangeError('Codex Responses request exceeded fixture byte limit');
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

function parseRequestBody(buffer: Buffer, contentEncoding: string): unknown {
    let decoded: Buffer;
    switch (contentEncoding) {
        case 'identity':
            decoded = buffer;
            break;
        case 'gzip':
            decoded = zlib.gunzipSync(buffer, {
                maxOutputLength: maximumDecodedRequestBytes,
            });
            break;
        case 'deflate':
            decoded = zlib.inflateSync(buffer, {
                maxOutputLength: maximumDecodedRequestBytes,
            });
            break;
        case 'br':
            decoded = zlib.brotliDecompressSync(buffer, {
                maxOutputLength: maximumDecodedRequestBytes,
            });
            break;
        case 'zstd': {
            const zstdDecompressSync = (
                zlib as unknown as {
                    zstdDecompressSync?: (
                        value: Buffer,
                        options: { maxOutputLength: number },
                    ) => Buffer;
                }
            ).zstdDecompressSync;
            if (!zstdDecompressSync) {
                throw new Error('This Node.js runtime cannot decode zstd requests');
            }
            decoded = zstdDecompressSync(buffer, {
                maxOutputLength: maximumDecodedRequestBytes,
            });
            break;
        }
        default:
            throw new Error(`Unsupported content encoding: ${contentEncoding}`);
    }
    if (decoded.length > maximumDecodedRequestBytes) {
        throw new RangeError('Decoded Codex Responses request exceeded fixture byte limit');
    }
    return JSON.parse(decoded.toString('utf8')) as unknown;
}

function normalizeContentEncoding(value: string | string[] | undefined): string {
    if (value === undefined) return 'identity';
    const normalized = (Array.isArray(value) ? value.join(',') : value)
        .trim()
        .toLowerCase();
    return normalized || 'identity';
}

function collectInputTypes(body: unknown): string[] {
    if (!isRecord(body) || !Array.isArray(body.input)) return [];
    return body.input
        .map((item) => isRecord(item) && typeof item.type === 'string' ? item.type : 'unknown')
        .sort();
}

function containsToolOutput(body: unknown, callId: string): boolean {
    if (!isRecord(body) || !Array.isArray(body.input)) return false;
    return body.input.some((item) => (
        isRecord(item)
        && item.type === 'function_call_output'
        && item.call_id === callId
    ));
}

function containsString(value: unknown, expected: string): boolean {
    if (typeof value === 'string') return value.includes(expected);
    if (Array.isArray(value)) {
        return value.some((entry) => containsString(entry, expected));
    }
    if (!isRecord(value)) return false;
    return Object.values(value).some((entry) => containsString(entry, expected));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function listenOnLoopback(server: Server): Promise<void> {
    return new Promise((resolveListen, rejectListen) => {
        const onError = (error: Error): void => rejectListen(error);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', onError);
            resolveListen();
        });
    });
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
            if (error) rejectClose(error);
            else resolveClose();
        });
        server.closeIdleConnections?.();
    });
}

function delay(ms: number): Promise<void> {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
