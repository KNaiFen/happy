import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    OFFICIAL_CODEX_MCP_SENTINEL,
    OFFICIAL_CODEX_MCP_RESPONSE_SENTINEL,
    OFFICIAL_CODEX_RESPONSE_SENTINEL,
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

    it.each([
        'happy__change_title',
        'mcp__happy__change_title',
    ])('prefers the offered flat Happy MCP tool %s', async (toolName) => {
        fixture = await startCodexResponsesFixture({ preferHappyMcpTool: true });

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
                call_id: 'happy-official-codex-tool-call',
                output: JSON.stringify({ content: [{ type: 'text', text: 'Title changed' }] }),
            }],
        });
        expect(second).toContain(OFFICIAL_CODEX_MCP_RESPONSE_SENTINEL);

        const snapshot = fixture.snapshot();
        assert.equal(snapshot.toolOutputCount, 1);
        assert.equal(snapshot.happyMcpOfferCount, 1);
        assert.equal(snapshot.namespaceToolOfferCount, 0);
        assert.equal(snapshot.mcpToolCallCount, 1);
        assert.equal(snapshot.mcpToolOutputObserved, true);
        assert.deepEqual(snapshot.toolNames, [toolName]);
    });

    it.each([
        ['current', 'happy', 'happy__change_title'],
        ['legacy-prefixed', 'mcp__happy', 'mcp__happy__change_title'],
    ])('calls a Happy MCP tool offered through the %s Responses namespace', async (
        _variant,
        namespace,
        canonicalName,
    ) => {
        fixture = await startCodexResponsesFixture({ preferHappyMcpTool: true });

        const first = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{ type: 'message', role: 'user' }],
            tools: [{
                type: 'namespace',
                name: namespace,
                description: 'Happy tools',
                tools: [{ type: 'function', name: 'change_title' }],
            }],
        });
        expect(first).toContain('"name":"change_title"');
        expect(first).toContain(`"namespace":"${namespace}"`);
        expect(first).toContain(OFFICIAL_CODEX_MCP_SENTINEL);

        const second = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{
                type: 'function_call_output',
                call_id: 'happy-official-codex-tool-call',
                output: JSON.stringify({ content: [{ type: 'text', text: 'Title changed' }] }),
            }],
        });
        expect(second).toContain(OFFICIAL_CODEX_MCP_RESPONSE_SENTINEL);

        const snapshot = fixture.snapshot();
        assert.equal(snapshot.happyMcpOfferCount, 1);
        assert.equal(snapshot.namespaceToolOfferCount, 1);
        assert.equal(snapshot.mcpToolCallCount, 1);
        assert.equal(snapshot.mcpToolOutputObserved, true);
        assert.deepEqual(snapshot.toolNames, [canonicalName]);
    });

    it('rejects bare and lookalike Happy MCP tool identities', async () => {
        fixture = await startCodexResponsesFixture({ preferHappyMcpTool: true });

        const response = await postResponses(fixture.baseUrl, {
            model: 'mock-model',
            input: [{ type: 'message', role: 'user' }],
            tools: [
                { type: 'function', name: 'change_title' },
                { type: 'function', name: 'unhappy__change_title' },
                {
                    type: 'namespace',
                    name: 'happy-tools',
                    tools: [{ type: 'function', name: 'change_title' }],
                },
                {
                    type: 'namespace',
                    name: 'happy',
                    tools: [{ type: 'function', name: 'change_title_and_run' }],
                },
            ],
        });
        expect(response).toContain('"name":"shell_command"');

        const snapshot = fixture.snapshot();
        assert.equal(snapshot.happyMcpOfferCount, 0);
        assert.equal(snapshot.namespaceToolOfferCount, 2);
        assert.equal(snapshot.mcpToolCallCount, 0);
        assert.deepEqual(snapshot.toolNames, ['shell_command']);
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
