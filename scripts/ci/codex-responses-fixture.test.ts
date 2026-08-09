import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    OFFICIAL_CODEX_MCP_SENTINEL,
    OFFICIAL_CODEX_MCP_CHOICE_SENTINEL,
    OFFICIAL_CODEX_MCP_RESPONSE_SENTINEL,
    OFFICIAL_CODEX_QUEUED_FOLLOWUP_SENTINEL,
    OFFICIAL_CODEX_POST_CLEAR_INPUT,
    OFFICIAL_CODEX_POST_CLEAR_SENTINEL,
    OFFICIAL_CODEX_RESPONSE_SENTINEL,
    OFFICIAL_CODEX_FIELD_ELICITATION_TOOL,
    OFFICIAL_CODEX_FIELD_MCP_SERVER,
    OFFICIAL_CODEX_FIELD_MCP_TOOL,
    OFFICIAL_CODEX_TOOL_SENTINEL,
    type CodexResponsesFixture,
    startCodexResponsesFixture,
    writeCodexResponsesConfig,
} from './codex-responses-fixture';

describe('official Codex Responses fixture', () => {
    let fixture: CodexResponsesFixture | null = null;
    let root: string | null = null;

    afterEach(async () => {
        await fixture?.close();
        if (root) await rm(root, { recursive: true, force: true });
        fixture = null;
        root = null;
    });

    it('drives a tool follow-up and a streamed final response without auth', async () => {
        const instructionSentinel = 'HAPPY_TEST_PROJECT_INSTRUCTIONS';
        fixture = await startCodexResponsesFixture({
            expectedInstructionSentinel: instructionSentinel,
        });
        root = await mkdtemp(join(tmpdir(), 'happy-codex-responses-fixture-'));
        await writeCodexResponsesConfig(root, fixture.baseUrl);

        const config = await readFile(join(root, 'config.toml'), 'utf8');
        expect(config).toContain('requires_openai_auth = false');
        expect(config).toContain('wire_api = "responses"');
        expect(config).not.toContain('[features]');

        const first = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            instructions: `Apply ${instructionSentinel} before responding.`,
            input: [{ type: 'message', role: 'user' }],
        });
        expect(first).toContain('"name":"shell_command"');
        expect(first).toContain(OFFICIAL_CODEX_TOOL_SENTINEL);

        const second = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{
                type: 'function_call_output',
                call_id: 'happy-official-codex-tool-call',
                output: OFFICIAL_CODEX_TOOL_SENTINEL,
            }],
        });
        expect(second).toContain('response.reasoning_summary_text.delta');
        expect(second).toContain('response.output_text.delta');
        expect(second).toContain(OFFICIAL_CODEX_RESPONSE_SENTINEL);

        const snapshot = fixture.snapshot();
        assert.equal(snapshot.requestCount, 2);
        assert.equal(snapshot.toolOutputObserved, true);
        assert.equal(snapshot.instructionSentinelObserved, true);
        assert.deepEqual(snapshot.requestShapes[1]?.inputTypes, ['function_call_output']);
    });

    it('writes the test-only field MCP into the temporary Codex config', async () => {
        fixture = await startCodexResponsesFixture();
        root = await mkdtemp(join(tmpdir(), 'happy-codex-responses-fixture-'));
        await writeCodexResponsesConfig(root, fixture.baseUrl, {
            fieldMcp: {
                command: '/usr/bin/node',
                args: ['/tmp/codex-field-mcp-server.mjs'],
            },
            additionalMcpServers: [{
                name: 'startup_failure_e2e',
                command: '/usr/bin/node',
                args: ['-e', 'process.exit(17)'],
                required: false,
            }],
        });

        const config = await readFile(join(root, 'config.toml'), 'utf8');
        expect(config).toContain(`[mcp_servers.${OFFICIAL_CODEX_FIELD_MCP_SERVER}]`);
        expect(config).toContain('command = "/usr/bin/node"');
        expect(config).toContain('args = ["/tmp/codex-field-mcp-server.mjs"]');
        expect(config).toContain('default_tools_approval_mode = "approve"');
        expect(config).toContain('[mcp_servers.startup_failure_e2e]');
        expect(config).toContain('args = ["-e", "process.exit(17)"]');
        expect(config).toContain('required = false');
        expect(config).not.toContain('[mcp_servers.happy]');
    });

    it.each([
        `${OFFICIAL_CODEX_FIELD_MCP_SERVER}__${OFFICIAL_CODEX_FIELD_MCP_TOOL}`,
        `mcp__${OFFICIAL_CODEX_FIELD_MCP_SERVER}__${OFFICIAL_CODEX_FIELD_MCP_TOOL}`,
    ])('prefers the offered flat field MCP tool %s after the seed turn', async (toolName) => {
        fixture = await startCodexResponsesFixture({ preferFixtureMcpTool: true });
        await warmFixture(fixture);

        const first = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{ type: 'message', role: 'user' }],
            tools: [
                { type: 'function', name: 'shell_command' },
                { type: 'function', name: toolName },
            ],
        });
        expect(first).toContain(`"name":"${toolName}"`);
        expect(first).toContain(OFFICIAL_CODEX_MCP_SENTINEL);

        const second = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{
                type: 'function_call_output',
                call_id: 'happy-official-codex-tool-call-2',
                output: JSON.stringify({ content: [{ type: 'text', text: 'Field marker recorded' }] }),
            }],
        });
        expect(second).toContain(OFFICIAL_CODEX_MCP_RESPONSE_SENTINEL);

        const snapshot = fixture.snapshot();
        assert.equal(snapshot.toolOutputCount, 2);
        assert.equal(snapshot.fixtureMcpOfferCount, 1);
        assert.equal(snapshot.namespaceToolOfferCount, 0);
        assert.equal(snapshot.mcpToolCallCount, 1);
        assert.equal(snapshot.mcpToolOutputObserved, true);
        assert.deepEqual(snapshot.toolNames, ['shell_command', toolName]);
    });

    it('selects the configured elicitation tool and proves the accepted choice output', async () => {
        fixture = await startCodexResponsesFixture({
            preferFixtureMcpTool: true,
            fixtureMcpToolName: OFFICIAL_CODEX_FIELD_ELICITATION_TOOL,
            expectedQueuedFollowUpText: 'Q',
            expectedPostClearText: OFFICIAL_CODEX_POST_CLEAR_INPUT,
        });
        await warmFixture(fixture);
        const elicitationTool = `${OFFICIAL_CODEX_FIELD_MCP_SERVER}__${OFFICIAL_CODEX_FIELD_ELICITATION_TOOL}`;

        const first = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{ type: 'message', role: 'user' }],
            tools: [
                {
                    type: 'function',
                    name: `${OFFICIAL_CODEX_FIELD_MCP_SERVER}__${OFFICIAL_CODEX_FIELD_MCP_TOOL}`,
                },
                { type: 'function', name: elicitationTool },
            ],
        });
        expect(first).toContain(`\"name\":\"${elicitationTool}\"`);
        expect(first).toContain('\"arguments\":\"{}\"');
        expect(first).not.toContain(OFFICIAL_CODEX_MCP_SENTINEL);

        const second = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{
                type: 'function_call_output',
                call_id: 'happy-official-codex-tool-call-2',
                output: JSON.stringify({
                    content: [{ type: 'text', text: OFFICIAL_CODEX_MCP_CHOICE_SENTINEL }],
                }),
            }],
        });
        expect(second).toContain(OFFICIAL_CODEX_MCP_RESPONSE_SENTINEL);

        const queuedFollowUp = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'Q' }],
            }],
        });
        expect(queuedFollowUp).toContain(OFFICIAL_CODEX_QUEUED_FOLLOWUP_SENTINEL);

        const postClearFollowUp = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: OFFICIAL_CODEX_POST_CLEAR_INPUT }],
            }],
        });
        expect(postClearFollowUp).toContain(OFFICIAL_CODEX_POST_CLEAR_SENTINEL);

        const snapshot = fixture.snapshot();
        assert.equal(snapshot.fixtureMcpOfferCount, 1);
        assert.equal(snapshot.mcpToolCallCount, 1);
        assert.equal(snapshot.mcpToolOutputObserved, true);
        assert.equal(snapshot.mcpChoiceAccepted, true);
        assert.equal(snapshot.queuedFollowUpObserved, true);
        assert.equal(snapshot.postClearFollowUpObserved, true);
        assert.equal(snapshot.clearPromptObserved, false);
        assert.deepEqual(snapshot.toolNames, ['shell_command', elicitationTool]);
    });

    it('does not unlock a queued follow-up when the elicitation output is rejected', async () => {
        fixture = await startCodexResponsesFixture({
            preferFixtureMcpTool: true,
            fixtureMcpToolName: OFFICIAL_CODEX_FIELD_ELICITATION_TOOL,
            expectedQueuedFollowUpText: 'Q',
        });
        await warmFixture(fixture);
        const elicitationTool = `${OFFICIAL_CODEX_FIELD_MCP_SERVER}__${OFFICIAL_CODEX_FIELD_ELICITATION_TOOL}`;

        await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{ type: 'message', role: 'user' }],
            tools: [{ type: 'function', name: elicitationTool }],
        });
        const rejected = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{
                type: 'function_call_output',
                call_id: 'happy-official-codex-tool-call-2',
                output: JSON.stringify({
                    isError: true,
                    content: [{
                        type: 'text',
                        text: 'MCP restart-safe field choice was not accepted',
                    }],
                }),
            }],
        });
        expect(rejected).toContain(OFFICIAL_CODEX_MCP_RESPONSE_SENTINEL);

        const queuedFollowUp = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'Q' }],
            }],
        });
        expect(queuedFollowUp).toContain(OFFICIAL_CODEX_RESPONSE_SENTINEL);
        expect(queuedFollowUp).not.toContain(OFFICIAL_CODEX_QUEUED_FOLLOWUP_SENTINEL);

        const snapshot = fixture.snapshot();
        assert.equal(snapshot.mcpToolOutputObserved, true);
        assert.equal(snapshot.mcpChoiceAccepted, false);
        assert.equal(snapshot.queuedFollowUpObserved, false);
    });

    it.each([
        ['current', OFFICIAL_CODEX_FIELD_MCP_SERVER, `${OFFICIAL_CODEX_FIELD_MCP_SERVER}__${OFFICIAL_CODEX_FIELD_MCP_TOOL}`],
        ['prefixed', `mcp__${OFFICIAL_CODEX_FIELD_MCP_SERVER}`, `mcp__${OFFICIAL_CODEX_FIELD_MCP_SERVER}__${OFFICIAL_CODEX_FIELD_MCP_TOOL}`],
    ])('calls a field MCP tool offered through the %s Responses namespace', async (
        _variant,
        namespace,
        canonicalName,
    ) => {
        fixture = await startCodexResponsesFixture({ preferFixtureMcpTool: true });
        await warmFixture(fixture);

        const first = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{ type: 'message', role: 'user' }],
            tools: [{
                type: 'namespace',
                name: namespace,
                description: 'Field test tools',
                tools: [{ type: 'function', name: OFFICIAL_CODEX_FIELD_MCP_TOOL }],
            }],
        });
        expect(first).toContain(`"name":"${OFFICIAL_CODEX_FIELD_MCP_TOOL}"`);
        expect(first).toContain(`"namespace":"${namespace}"`);
        expect(first).toContain(OFFICIAL_CODEX_MCP_SENTINEL);

        const second = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{
                type: 'function_call_output',
                call_id: 'happy-official-codex-tool-call-2',
                output: JSON.stringify({ content: [{ type: 'text', text: 'Field marker recorded' }] }),
            }],
        });
        expect(second).toContain(OFFICIAL_CODEX_MCP_RESPONSE_SENTINEL);

        const snapshot = fixture.snapshot();
        assert.equal(snapshot.fixtureMcpOfferCount, 1);
        assert.equal(snapshot.namespaceToolOfferCount, 1);
        assert.equal(snapshot.mcpToolCallCount, 1);
        assert.equal(snapshot.mcpToolOutputObserved, true);
        assert.deepEqual(snapshot.toolNames, ['shell_command', canonicalName]);
    });

    it('rejects bare and lookalike field MCP tool identities', async () => {
        fixture = await startCodexResponsesFixture({ preferFixtureMcpTool: true });
        await warmFixture(fixture);

        const response = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{ type: 'message', role: 'user' }],
            tools: [
                { type: 'function', name: OFFICIAL_CODEX_FIELD_MCP_TOOL },
                { type: 'function', name: `un${OFFICIAL_CODEX_FIELD_MCP_SERVER}__${OFFICIAL_CODEX_FIELD_MCP_TOOL}` },
                {
                    type: 'namespace',
                    name: `${OFFICIAL_CODEX_FIELD_MCP_SERVER}-tools`,
                    tools: [{ type: 'function', name: OFFICIAL_CODEX_FIELD_MCP_TOOL }],
                },
                {
                    type: 'namespace',
                    name: OFFICIAL_CODEX_FIELD_MCP_SERVER,
                    tools: [{ type: 'function', name: `${OFFICIAL_CODEX_FIELD_MCP_TOOL}_and_run` }],
                },
            ],
        });
        expect(response).toContain(OFFICIAL_CODEX_RESPONSE_SENTINEL);

        const snapshot = fixture.snapshot();
        assert.equal(snapshot.fixtureMcpOfferCount, 0);
        assert.equal(snapshot.namespaceToolOfferCount, 2);
        assert.equal(snapshot.mcpToolCallCount, 0);
        assert.deepEqual(snapshot.toolNames, ['shell_command']);
    });

    it('discovers a deferred field MCP tool through client tool search', async () => {
        fixture = await startCodexResponsesFixture({ preferFixtureMcpTool: true });
        await warmFixture(fixture, { tools: [{ type: 'tool_search', execution: 'client' }] });
        assert.equal(fixture.snapshot().toolSearchCallCount, 0);

        const search = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{ type: 'message', role: 'user' }],
            tools: [{ type: 'tool_search', execution: 'client' }],
        });
        expect(search).toContain('"type":"tool_search_call"');
        expect(search).toContain('"call_id":"happy-official-codex-tool-search"');
        expect(search).toContain('field verification record event');

        const mcpCall = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [
                {
                    type: 'tool_search_call',
                    call_id: 'happy-official-codex-tool-search',
                    execution: 'client',
                    arguments: { query: 'field verification record event' },
                },
                {
                    type: 'tool_search_output',
                    call_id: 'happy-official-codex-tool-search',
                    status: 'completed',
                    execution: 'client',
                    tools: [{
                        type: 'namespace',
                        name: OFFICIAL_CODEX_FIELD_MCP_SERVER,
                        description: 'Field test tools',
                        tools: [{ type: 'function', name: OFFICIAL_CODEX_FIELD_MCP_TOOL }],
                    }],
                },
            ],
            tools: [{ type: 'tool_search', execution: 'client' }],
        });
        expect(mcpCall).toContain(`"name":"${OFFICIAL_CODEX_FIELD_MCP_TOOL}"`);
        expect(mcpCall).toContain(`"namespace":"${OFFICIAL_CODEX_FIELD_MCP_SERVER}"`);

        const final = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{
                type: 'function_call_output',
                call_id: 'happy-official-codex-tool-call-2',
                output: JSON.stringify({ content: [{ type: 'text', text: 'Field marker recorded' }] }),
            }],
        });
        expect(final).toContain(OFFICIAL_CODEX_MCP_RESPONSE_SENTINEL);

        const snapshot = fixture.snapshot();
        assert.equal(snapshot.requestCount, 5);
        assert.equal(snapshot.toolSearchCallCount, 1);
        assert.equal(snapshot.toolSearchOutputObserved, true);
        assert.equal(snapshot.fixtureMcpOfferCount, 1);
        assert.equal(snapshot.mcpToolCallCount, 1);
        assert.equal(snapshot.mcpToolOutputObserved, true);
        assert.deepEqual(snapshot.toolNames, [
            'shell_command',
            `${OFFICIAL_CODEX_FIELD_MCP_SERVER}__${OFFICIAL_CODEX_FIELD_MCP_TOOL}`,
        ]);
    });
});

async function postResponses(baseUrl: string, body: unknown): Promise<string> {
    const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    return response.text();
}

async function warmFixture(
    fixture: CodexResponsesFixture,
    input: Record<string, unknown> = {},
): Promise<void> {
    const first = await postResponses(fixture.baseUrl, {
        model: 'mock-model',
        input: [{ type: 'message', role: 'user' }],
        ...input,
    });
    expect(first).toContain('"name":"shell_command"');
    const second = await postResponses(fixture.baseUrl, {
        model: 'mock-model',
        input: [{
            type: 'function_call_output',
            call_id: 'happy-official-codex-tool-call',
            output: OFFICIAL_CODEX_TOOL_SENTINEL,
        }],
    });
    expect(second).toContain(OFFICIAL_CODEX_RESPONSE_SENTINEL);
}
