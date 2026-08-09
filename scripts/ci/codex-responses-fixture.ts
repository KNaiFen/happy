import assert from 'node:assert/strict';
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'node:http';
import * as zlib from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const OFFICIAL_CODEX_RESPONSE_SENTINEL = 'Official Codex source E2E response';
export const OFFICIAL_CODEX_MCP_RESPONSE_SENTINEL = 'Official Codex MCP E2E response';
export const OFFICIAL_CODEX_TOOL_SENTINEL = 'HAPPY_OFFICIAL_CODEX_TOOL_OK';
export const OFFICIAL_CODEX_MCP_SENTINEL = 'MCP single-card field verification';
export const OFFICIAL_CODEX_MCP_CHOICE_SENTINEL = 'MCP restart-safe field choice accepted';
export const OFFICIAL_CODEX_QUEUED_FOLLOWUP_SENTINEL = 'Official Codex queued follow-up E2E response';
export const OFFICIAL_CODEX_POST_CLEAR_SENTINEL = 'Official Codex post-clear E2E response';
export const OFFICIAL_CODEX_POST_CLEAR_INPUT = 'post-clear-from-android-e2e';
export const OFFICIAL_CODEX_FIELD_MCP_SERVER = 'field_e2e';
export const OFFICIAL_CODEX_FIELD_MCP_TOOL = 'record_field_event';
export const OFFICIAL_CODEX_FIELD_ELICITATION_TOOL = 'collect_field_choice';

const maximumRequestBytes = 8 * 1024 * 1024;
const maximumDecodedRequestBytes = 32 * 1024 * 1024;
const toolCallId = 'happy-official-codex-tool-call';
const toolSearchCallId = 'happy-official-codex-tool-search';

interface RequestShape {
    contentEncoding: string;
    inputTypes: string[];
}

export interface CodexResponsesFixtureSnapshot {
    requestCount: number;
    toolOutputObserved: boolean;
    toolOutputCount: number;
    fixtureMcpOfferCount: number;
    namespaceToolOfferCount: number;
    toolSearchCallCount: number;
    toolSearchOutputObserved: boolean;
    mcpToolCallCount: number;
    mcpToolOutputObserved: boolean;
    mcpChoiceAccepted: boolean;
    queuedFollowUpObserved: boolean;
    postClearFollowUpObserved: boolean;
    clearPromptObserved: boolean;
    toolNames: string[];
    instructionSentinelObserved: boolean;
    requestShapes: RequestShape[];
}

export interface CodexResponsesFixtureOptions {
    expectedInstructionSentinel?: string;
    preferFixtureMcpTool?: boolean;
    fixtureMcpToolName?:
        | typeof OFFICIAL_CODEX_FIELD_MCP_TOOL
        | typeof OFFICIAL_CODEX_FIELD_ELICITATION_TOOL;
    expectedQueuedFollowUpText?: string;
    expectedPostClearText?: string;
    mcpFollowupDelayMs?: number;
}

export interface CodexResponsesFixtureMcpConfig {
    command: string;
    args: readonly string[];
    required?: boolean;
}

export interface CodexResponsesFixtureNamedMcpConfig extends CodexResponsesFixtureMcpConfig {
    name: string;
}

export interface CodexResponsesFixture {
    baseUrl: string;
    snapshot(): CodexResponsesFixtureSnapshot;
    close(): Promise<void>;
}

interface OfferedTool {
    name: string;
    namespace?: string;
}

export async function startCodexResponsesFixture(
    options: CodexResponsesFixtureOptions = {},
): Promise<CodexResponsesFixture> {
    const state: CodexResponsesFixtureSnapshot = {
        requestCount: 0,
        toolOutputObserved: false,
        toolOutputCount: 0,
        fixtureMcpOfferCount: 0,
        namespaceToolOfferCount: 0,
        toolSearchCallCount: 0,
        toolSearchOutputObserved: false,
        mcpToolCallCount: 0,
        mcpToolOutputObserved: false,
        mcpChoiceAccepted: false,
        queuedFollowUpObserved: false,
        postClearFollowUpObserved: false,
        clearPromptObserved: false,
        toolNames: [],
        instructionSentinelObserved: false,
        requestShapes: [],
    };
    const pendingTools = new Map<string, {
        isFixtureMcp: boolean;
        expectsChoice: boolean;
    }>();
    const pendingToolSearches = new Set<string>();
    const server = createServer((request, response) => {
        void handleRequest(
            request,
            response,
            state,
            options,
            pendingTools,
            pendingToolSearches,
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
    options: {
        fieldMcp?: CodexResponsesFixtureMcpConfig;
        additionalMcpServers?: readonly CodexResponsesFixtureNamedMcpConfig[];
    } = {},
): Promise<void> {
    assert.match(fixtureBaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    if (options.fieldMcp) {
        validateMcpConfig(options.fieldMcp, 'field MCP');
    }
    for (const server of options.additionalMcpServers ?? []) {
        assert.match(server.name, /^[a-zA-Z0-9_-]+$/, 'additional MCP name must be TOML-safe');
        assert.notEqual(server.name, OFFICIAL_CODEX_FIELD_MCP_SERVER);
        validateMcpConfig(server, `additional MCP ${server.name}`);
    }
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
        ...(options.fieldMcp ? [
            `[mcp_servers.${OFFICIAL_CODEX_FIELD_MCP_SERVER}]`,
            `command = ${tomlString(options.fieldMcp.command)}`,
            `args = [${options.fieldMcp.args.map(tomlString).join(', ')}]`,
            'required = true',
            'default_tools_approval_mode = "approve"',
            '',
        ] : []),
        ...(options.additionalMcpServers ?? []).flatMap((server) => [
            `[mcp_servers.${server.name}]`,
            `command = ${tomlString(server.command)}`,
            `args = [${server.args.map(tomlString).join(', ')}]`,
            `required = ${server.required === true ? 'true' : 'false'}`,
            '',
        ]),
    ].join('\n');
    await writeFile(join(codexHome, 'config.toml'), config, {
        encoding: 'utf8',
        mode: 0o600,
    });
}

function validateMcpConfig(
    config: CodexResponsesFixtureMcpConfig,
    label: string,
): void {
    assert.equal(isAbsolute(config.command), true, `${label} command must be absolute`);
    for (const arg of config.args) {
        assert.equal(typeof arg, 'string', `${label} arguments must be strings`);
    }
}

async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    state: CodexResponsesFixtureSnapshot,
    options: CodexResponsesFixtureOptions,
    pendingTools: Map<string, { isFixtureMcp: boolean; expectsChoice: boolean }>,
    pendingToolSearches: Set<string>,
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
    if (hasExactUserInputText(body, '/clear')) state.clearPromptObserved = true;
    if (
        options.expectedInstructionSentinel
        && containsString(body, options.expectedInstructionSentinel)
    ) {
        state.instructionSentinelObserved = true;
    }

    const completedTool = findMatchingToolOutput(body, pendingTools);
    if (completedTool) {
        pendingTools.delete(completedTool.callId);
        state.toolOutputObserved = true;
        state.toolOutputCount += 1;
        if (completedTool.isFixtureMcp) state.mcpToolOutputObserved = true;
        if (
            completedTool.expectsChoice
            && containsString(completedTool.output, OFFICIAL_CODEX_MCP_CHOICE_SENTINEL)
        ) {
            state.mcpChoiceAccepted = true;
        }
    }
    const completedToolSearch = findMatchingToolSearchOutput(body, pendingToolSearches);
    if (completedToolSearch) {
        pendingToolSearches.delete(completedToolSearch.callId);
        state.toolSearchOutputObserved = true;
    }

    response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'close',
    });
    if (completedTool) {
        if (completedTool.isFixtureMcp && options.mcpFollowupDelayMs) {
            await delay(options.mcpFollowupDelayMs);
        }
        await writeFinalResponse(
            response,
            state.toolOutputCount,
            completedTool.isFixtureMcp
                ? OFFICIAL_CODEX_MCP_RESPONSE_SENTINEL
                : OFFICIAL_CODEX_RESPONSE_SENTINEL,
        );
        return;
    }

    if (
        options.expectedQueuedFollowUpText
        && state.mcpChoiceAccepted
        && hasExactUserInputText(body, options.expectedQueuedFollowUpText)
    ) {
        state.queuedFollowUpObserved = true;
        await writeFinalResponse(
            response,
            state.requestCount,
            OFFICIAL_CODEX_QUEUED_FOLLOWUP_SENTINEL,
        );
        return;
    }

    if (
        options.expectedPostClearText
        && state.queuedFollowUpObserved
        && hasExactUserInputText(body, options.expectedPostClearText)
    ) {
        state.postClearFollowUpObserved = true;
        await writeFinalResponse(
            response,
            state.requestCount,
            OFFICIAL_CODEX_POST_CLEAR_SENTINEL,
        );
        return;
    }

    // The seed turn must remain a normal shell lifecycle. The field MCP is
    // intentionally selected only for the later App-origin turn.
    const selectedTool = state.toolOutputCount > 0
        ? selectFixtureMcpTool(
            body,
            completedToolSearch?.tools ?? [],
            state,
            options,
        )
        : null;
    if (selectedTool) {
        const callId = state.toolNames.length === 0
            ? toolCallId
            : `${toolCallId}-${state.toolNames.length + 1}`;
        const isFixtureMcp = isFixtureMcpTool(selectedTool, options);
        pendingTools.set(callId, {
            isFixtureMcp,
            expectsChoice: isFixtureMcp
                && fixtureMcpToolName(options) === OFFICIAL_CODEX_FIELD_ELICITATION_TOOL,
        });
        state.toolNames.push(canonicalToolName(selectedTool));
        if (isFixtureMcp) state.mcpToolCallCount += 1;
        writeEvents(response, toolCallEvents(callId, selectedTool, options));
        response.end();
        return;
    }

    // Keep the seed history turn on the deterministic shell path. Tool search is
    // reserved for the later App-driven turn, after that warm-up has completed.
    if (state.toolNames.length === 0) {
        pendingTools.set(toolCallId, { isFixtureMcp: false, expectsChoice: false });
        state.toolNames.push('shell_command');
        writeEvents(response, toolCallEvents(toolCallId, { name: 'shell_command' }));
        response.end();
        return;
    }

    if (
        options.preferFixtureMcpTool
        && state.mcpToolCallCount === 0
        && state.toolSearchCallCount === 0
        && hasClientToolSearch(body)
    ) {
        pendingToolSearches.add(toolSearchCallId);
        state.toolSearchCallCount += 1;
        writeEvents(response, toolSearchEvents(toolSearchCallId));
        response.end();
        return;
    }

    await writeFinalResponse(response, state.requestCount);
}

function toolSearchEvents(callId: string): Array<Record<string, unknown>> {
    return [
        responseCreated(`happy-tool-search-response-${callId}`),
        {
            type: 'response.output_item.done',
            item: {
                type: 'tool_search_call',
                call_id: callId,
                execution: 'client',
                arguments: {
                    query: 'field verification record event',
                    limit: 8,
                },
            },
        },
        responseCompleted(`happy-tool-search-response-${callId}`),
    ];
}

function toolCallEvents(
    callId: string,
    tool: OfferedTool,
    options: CodexResponsesFixtureOptions = {},
): Array<Record<string, unknown>> {
    const argumentsJson = JSON.stringify(isFixtureMcpTool(tool, options)
        ? fixtureMcpToolName(options) === OFFICIAL_CODEX_FIELD_MCP_TOOL
            ? { marker: OFFICIAL_CODEX_MCP_SENTINEL }
            : {}
        : {
            command: `printf '%s\\n' ${OFFICIAL_CODEX_TOOL_SENTINEL}`,
            workdir: null,
            timeout_ms: 5_000,
        });
    return [
        responseCreated(`happy-tool-response-${callId}`),
        {
            type: 'response.output_item.done',
            item: {
                type: 'function_call',
                call_id: callId,
                name: tool.name,
                ...(tool.namespace ? { namespace: tool.namespace } : {}),
                arguments: argumentsJson,
            },
        },
        responseCompleted(`happy-tool-response-${callId}`),
    ];
}

async function writeFinalResponse(
    response: ServerResponse,
    sequence: number,
    responseText = OFFICIAL_CODEX_RESPONSE_SENTINEL,
): Promise<void> {
    const messageId = `happy-official-message-${sequence}`;
    const reasoningId = `happy-official-reasoning-${sequence}`;
    const splitAt = Math.floor(responseText.length / 2);
    const firstDelta = responseText.slice(0, splitAt);
    const secondDelta = responseText.slice(splitAt);
    const events: Array<Record<string, unknown>> = [
        responseCreated(`happy-final-response-${sequence}`),
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
                    text: responseText,
                }],
            },
        },
        responseCompleted(`happy-final-response-${sequence}`),
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

function hasExactUserInputText(body: unknown, expected: string): boolean {
    if (!isRecord(body) || !Array.isArray(body.input)) return false;
    return body.input.some((item) => {
        if (!isRecord(item) || item.type !== 'message' || item.role !== 'user') return false;
        if (typeof item.content === 'string') return item.content === expected;
        if (!Array.isArray(item.content)) return false;
        return item.content.some((part) => (
            isRecord(part)
            && (part.type === 'input_text' || part.type === 'text')
            && part.text === expected
        ));
    });
}

function findMatchingToolOutput(
    body: unknown,
    pendingTools: Map<string, { isFixtureMcp: boolean; expectsChoice: boolean }>,
): { callId: string; isFixtureMcp: boolean; expectsChoice: boolean; output: unknown } | null {
    if (!isRecord(body) || !Array.isArray(body.input)) return null;
    for (const item of body.input) {
        if (
            !isRecord(item)
            || item.type !== 'function_call_output'
            || typeof item.call_id !== 'string'
        ) {
            continue;
        }
        const pending = pendingTools.get(item.call_id);
        if (pending) return { callId: item.call_id, output: item.output, ...pending };
    }
    return null;
}

function findMatchingToolSearchOutput(
    body: unknown,
    pendingToolSearches: Set<string>,
): { callId: string; tools: OfferedTool[] } | null {
    if (!isRecord(body) || !Array.isArray(body.input)) return null;
    for (const item of body.input) {
        if (
            !isRecord(item)
            || item.type !== 'tool_search_output'
            || item.execution !== 'client'
            || item.status !== 'completed'
            || typeof item.call_id !== 'string'
            || !pendingToolSearches.has(item.call_id)
            || !Array.isArray(item.tools)
        ) {
            continue;
        }
        return {
            callId: item.call_id,
            tools: collectToolSpecs(item.tools),
        };
    }
    return null;
}

function selectFixtureMcpTool(
    body: unknown,
    discoveredTools: OfferedTool[],
    state: CodexResponsesFixtureSnapshot,
    options: CodexResponsesFixtureOptions,
): OfferedTool | null {
    const offeredTools = [...collectOfferedTools(body), ...discoveredTools];
    state.fixtureMcpOfferCount += offeredTools.filter((tool) => isFixtureMcpTool(tool, options)).length;
    state.namespaceToolOfferCount += offeredTools.filter((tool) => tool.namespace).length;
    if (options.preferFixtureMcpTool && state.mcpToolCallCount === 0) {
        const fixtureMcp = offeredTools.find((tool) => isFixtureMcpTool(tool, options));
        if (fixtureMcp) return fixtureMcp;
    }
    return null;
}

function collectOfferedTools(body: unknown): OfferedTool[] {
    if (!isRecord(body) || !Array.isArray(body.tools)) return [];
    return collectToolSpecs(body.tools);
}

function collectToolSpecs(tools: unknown[]): OfferedTool[] {
    return tools.flatMap((tool) => {
        if (!isRecord(tool)) return [];
        if (
            tool.type === 'namespace'
            && typeof tool.name === 'string'
            && Array.isArray(tool.tools)
        ) {
            const namespace = tool.name;
            return tool.tools.flatMap((nestedTool): OfferedTool[] => {
                if (!isRecord(nestedTool)) return [];
                if (typeof nestedTool.name === 'string') {
                    return [{ name: nestedTool.name, namespace }];
                }
                if (
                    isRecord(nestedTool.function)
                    && typeof nestedTool.function.name === 'string'
                ) {
                    return [{ name: nestedTool.function.name, namespace }];
                }
                return [];
            });
        }
        if (typeof tool.name === 'string') return [{ name: tool.name }];
        if (isRecord(tool.function) && typeof tool.function.name === 'string') {
            return [{ name: tool.function.name }];
        }
        return [];
    });
}

function hasClientToolSearch(body: unknown): boolean {
    if (!isRecord(body) || !Array.isArray(body.tools)) return false;
    return body.tools.some((tool) => (
        isRecord(tool)
        && tool.type === 'tool_search'
        && tool.execution === 'client'
    ));
}

function canonicalToolName(tool: OfferedTool): string {
    if (!tool.namespace) return tool.name;
    const separator = tool.namespace.endsWith('__') ? '' : '__';
    return `${tool.namespace}${separator}${tool.name}`;
}

function isFixtureMcpTool(
    tool: OfferedTool,
    options: CodexResponsesFixtureOptions,
): boolean {
    const name = tool.name.toLowerCase();
    const expectedToolName = fixtureMcpToolName(options).toLowerCase();
    if (tool.namespace) {
        const namespace = tool.namespace.toLowerCase().replace(/__$/, '');
        return name === expectedToolName
            && (
                namespace === OFFICIAL_CODEX_FIELD_MCP_SERVER
                || namespace === `mcp__${OFFICIAL_CODEX_FIELD_MCP_SERVER}`
            );
    }
    return name === `${OFFICIAL_CODEX_FIELD_MCP_SERVER}__${expectedToolName}`
        || name === `mcp__${OFFICIAL_CODEX_FIELD_MCP_SERVER}__${expectedToolName}`;
}

function fixtureMcpToolName(options: CodexResponsesFixtureOptions): string {
    return options.fixtureMcpToolName ?? OFFICIAL_CODEX_FIELD_MCP_TOOL;
}

function tomlString(value: string): string {
    return JSON.stringify(value);
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
