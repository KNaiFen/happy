import assert from 'node:assert/strict';
import { test, expect } from '@microsoft/tui-test';

const controlUrl = requiredEnvironment('HAPPY_GATEWAY_TUI_CONTROL_URL');
const cliEntrypoint = requiredEnvironment('HAPPY_GATEWAY_TUI_CLI_ENTRYPOINT');
const terminalPrompt = requiredEnvironment('HAPPY_GATEWAY_TUI_TERMINAL_PROMPT');
const appPrompt = requiredEnvironment('HAPPY_GATEWAY_TUI_APP_PROMPT');
const attachPrompt = requiredEnvironment('HAPPY_GATEWAY_TUI_ATTACH_PROMPT');
const officialResponse = requiredEnvironment('HAPPY_GATEWAY_TUI_RESPONSE_SENTINEL');

const programEnvironment = {
    ...process.env,
    HAPPY_HOME_DIR: requiredEnvironment('HAPPY_GATEWAY_TUI_HAPPY_HOME'),
    HAPPY_SERVER_URL: requiredEnvironment('HAPPY_GATEWAY_TUI_SERVER_URL'),
    CODEX_HOME: requiredEnvironment('HAPPY_GATEWAY_TUI_CODEX_HOME'),
    HAPPY_DISABLE_CAFFEINATE: '1',
    HAPPY_EXPERIMENTAL: '0',
    NODE_ENV: 'test',
};

interface GatewayStatus {
    gatewayId: string;
    pid: number;
    providerPid: number | null;
    state: string;
    terminalState: string;
    threadId: string | null;
    sessionId: string | null;
    generation: number | null;
    workerAlive: boolean;
    providerAlive: boolean;
    lastError: string | null;
}

interface FixtureStatus {
    gateway: GatewayStatus | null;
    sessionActive: boolean | null;
    projectionReady: boolean;
    messageObserved: boolean | null;
    agentMessageCount: number;
    reasoningSummaryCount: number;
    commandOutputCount: number;
    officialResponseCount: number;
    rawReasoningLeak: boolean;
    commandResultStatus: string | null;
    providerUserMessageObserved: boolean | null;
    responseAfterCommand: boolean | null;
    providerRequestCount: number;
    providerToolOutputObserved: boolean;
    v3MessageCount: number;
    projectionLagSamples: number;
    projectionLagP95Ms: number | null;
    payloadLeakInLogs: boolean;
}

let initialGateway: GatewayStatus | null = null;
let appCommandId = '';
let requestCountBeforeAttach = 0;

test.describe('terminal-origin Gateway', () => {
    test.use({
        rows: 42,
        columns: 132,
        env: programEnvironment,
        program: {
            file: process.execPath,
            args: [
                cliEntrypoint,
                'codex',
                '--no-alt-screen',
                terminalPrompt,
            ],
        },
    });

    test('keeps terminal and App on one official provider before abnormal detach', async ({ terminal }) => {
        const terminalPromptLocator = terminal.getByText(terminalPrompt, {
            full: true,
            strict: false,
        });
        await waitUntil(async () => {
            const status = await readStatus({});
            if (status.gateway?.lastError?.startsWith('rootBinding:')) {
                throw new Error(`Codex Gateway failed with ${status.gateway.lastError}`);
            }
            try {
                await expect(terminalPromptLocator).toBeVisible({ timeout: 100 });
                return true;
            } catch {
                return false;
            }
        }, 120_000, 'terminal prompt or root binding diagnosis');
        const officialResponseLocator = terminal.getByText(officialResponse, {
            full: true,
            strict: false,
        });
        await waitUntil(async () => {
            const status = await readStatus({});
            if (status.gateway?.lastError?.startsWith('rootBinding:')) {
                throw new Error(`Codex Gateway failed with ${status.gateway.lastError}`);
            }
            try {
                await expect(officialResponseLocator).toBeVisible({ timeout: 100 });
                return true;
            } catch {
                return false;
            }
        }, 120_000, 'official response or root binding diagnosis');

        const terminalState = await waitForStatus(
            { message: terminalPrompt },
            (status) => Boolean(
                status.gateway?.state === 'running'
                && status.gateway.terminalState === 'attached'
                && status.gateway.workerAlive
                && status.gateway.providerAlive
                && status.gateway.threadId
                && status.gateway.sessionId
                && status.projectionReady
                && status.messageObserved
                && status.reasoningSummaryCount >= 1
                && status.commandOutputCount >= 1
                && status.officialResponseCount >= 1
                && status.providerToolOutputObserved,
            ),
            'terminal prompt projection',
        );
        assert.equal(terminalState.v3MessageCount, 0, 'Codex terminal prompt fell back to v3');
        assert.equal(terminalState.rawReasoningLeak, false, 'raw reasoning reached Sync v4');
        assert.equal(terminalState.payloadLeakInLogs, false, 'terminal prompt reached operational logs');
        initialGateway = terminalState.gateway;
        assert(initialGateway?.providerPid);

        const published = await postJson<{ commandId: string }>('/app/prompt', { text: appPrompt });
        appCommandId = published.commandId;
        const appState = await waitForStatus(
            { message: appPrompt, commandId: appCommandId },
            (status) => Boolean(
                status.messageObserved
                && status.providerUserMessageObserved
                && status.responseAfterCommand
                && status.commandResultStatus === 'succeeded'
                && status.projectionLagSamples >= 1,
            ),
            'App prompt provider round trip',
        );
        await expect(terminal.getByText(appPrompt, { full: true, strict: false }))
            .toBeVisible({ timeout: 120_000 });
        assert.equal(appState.gateway?.gatewayId, initialGateway.gatewayId);
        assert.equal(appState.gateway?.providerPid, initialGateway.providerPid);
        assert.equal(appState.gateway?.threadId, initialGateway.threadId);
        assert.equal(appState.v3MessageCount, 0, 'App prompt fell back to v3');
        assert.equal(appState.rawReasoningLeak, false, 'raw reasoning reached App projection');
        assert.equal(appState.payloadLeakInLogs, false, 'App prompt reached operational logs');
        assert(
            appState.projectionLagP95Ms !== null && appState.projectionLagP95Ms < 750,
            `App stream projection p95 was ${appState.projectionLagP95Ms ?? 'missing'}ms`,
        );
        requestCountBeforeAttach = appState.providerRequestCount;

        terminal.kill();
        const detached = await waitForStatus(
            {},
            (status) => Boolean(
                status.gateway?.terminalState === 'detached'
                && status.gateway.state === 'running'
                && status.gateway.workerAlive
                && status.gateway.providerAlive,
            ),
            'abnormal terminal detach',
            30_000,
        );
        assert.equal(detached.gateway?.gatewayId, initialGateway.gatewayId);
        assert.equal(detached.gateway?.providerPid, initialGateway.providerPid);
        assert.equal(detached.gateway?.threadId, initialGateway.threadId);
    });
});

test.describe('Gateway attach', () => {
    test.use({
        rows: 42,
        columns: 132,
        env: programEnvironment,
        program: {
            file: process.execPath,
            args: [cliEntrypoint, 'codex', 'attach'],
        },
    });

    test('reattaches the same provider and stops only after a normal TUI exit', async ({ terminal }) => {
        assert(initialGateway, 'detach test did not preserve a Gateway identity');
        await expect(terminal.getByText('Select a Codex Gateway to attach:', {
            full: true,
            strict: false,
        })).toBeVisible({ timeout: 30_000 });
        terminal.submit('1');

        const attached = await waitForStatus(
            {},
            (status) => Boolean(
                status.gateway?.terminalState === 'attached'
                && status.gateway.state === 'running'
                && status.gateway.workerAlive
                && status.gateway.providerAlive,
            ),
            'Gateway attach',
        );
        assert.equal(attached.gateway?.gatewayId, initialGateway.gatewayId);
        assert.equal(attached.gateway?.providerPid, initialGateway.providerPid);
        assert.equal(attached.gateway?.threadId, initialGateway.threadId);
        assert.equal(attached.gateway?.sessionId, initialGateway.sessionId);
        assert.equal(attached.gateway?.generation, initialGateway.generation);

        terminal.submit(attachPrompt);
        await expect(terminal.getByText(attachPrompt, { full: true, strict: false }))
            .toBeVisible({ timeout: 60_000 });
        const attachState = await waitForStatus(
            { message: attachPrompt },
            (status) => Boolean(
                status.messageObserved
                && status.providerRequestCount > requestCountBeforeAttach
                && status.agentMessageCount >= 3,
            ),
            'reattached terminal round trip',
        );
        assert.equal(attachState.gateway?.gatewayId, initialGateway.gatewayId);
        assert.equal(attachState.gateway?.providerPid, initialGateway.providerPid);
        assert.equal(attachState.gateway?.threadId, initialGateway.threadId);
        assert.equal(attachState.gateway?.sessionId, initialGateway.sessionId);
        assert.equal(attachState.payloadLeakInLogs, false, 'attach prompt reached operational logs');
        await expect(terminal.getByText(officialResponse, { full: true, strict: false }))
            .toBeVisible({ timeout: 120_000 });

        terminal.keyCtrlC();
        await delay(500);
        terminal.keyCtrlC();
        await waitUntil(
            () => terminal.exitResult !== null,
            20_000,
            'normal TUI exit',
        );
        assert.equal(terminal.exitResult?.exitCode, 0);

        const stopped = await waitForStatus(
            { commandId: appCommandId },
            (status) => Boolean(
                status.gateway?.state === 'stopped'
                && !status.gateway.workerAlive
                && status.sessionActive === false,
            ),
            'normal Gateway stop',
            45_000,
        );
        assert.equal(stopped.gateway?.gatewayId, initialGateway.gatewayId);
        assert.equal(stopped.v3MessageCount, 0);
        assert.equal(stopped.rawReasoningLeak, false);
        assert.equal(stopped.payloadLeakInLogs, false);
        assert.equal(stopped.commandResultStatus, 'succeeded');
    });
});

async function waitForStatus(
    query: { message?: string; commandId?: string },
    predicate: (status: FixtureStatus) => boolean,
    label: string,
    timeoutMs = 120_000,
): Promise<FixtureStatus> {
    let latest: FixtureStatus | null = null;
    await waitUntil(async () => {
        latest = await readStatus(query);
        return predicate(latest);
    }, timeoutMs, label);
    assert(latest);
    return latest;
}

async function readStatus(query: {
    message?: string;
    commandId?: string;
}): Promise<FixtureStatus> {
    const params = new URLSearchParams();
    if (query.message) params.set('message', query.message);
    if (query.commandId) params.set('commandId', query.commandId);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const response = await fetch(`${controlUrl}/state${suffix}`);
    assert.equal(response.status, 200, `fixture state returned HTTP ${response.status}`);
    return await response.json() as FixtureStatus;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${controlUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `fixture control returned HTTP ${response.status}`);
    return await response.json() as T;
}

async function waitUntil(
    condition: () => boolean | Promise<boolean>,
    timeoutMs: number,
    label: string,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await delay(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

function requiredEnvironment(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
