import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
    CODEX_CLI_VERSION_PROBE_TIMEOUT_MS,
    MINIMUM_CODEX_CLI_VERSION,
    isCodexCliVersionAtLeast,
    parseCodexCliVersion,
} from '../../packages/happy-cli/src/codex/codexCliVersion';
import {
    OFFICIAL_CODEX_RESPONSE_SENTINEL,
    OFFICIAL_CODEX_TOOL_SENTINEL,
    type CodexResponsesFixture,
    startCodexResponsesFixture,
    writeCodexResponsesConfig,
} from './codex-responses-fixture';

async function main(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'happy-codex-official-app-server-'));
    const codexHome = join(root, 'codex-home');
    const originalAppServerPath = process.env.HAPPY_CODEX_APP_SERVER_PATH;
    const originalFakeScenario = process.env.HAPPY_FAKE_CODEX_SCENARIO;
    const originalCodexHome = process.env.CODEX_HOME;
    const originalPath = process.env.PATH;
    let fixture: CodexResponsesFixture | null = null;
    let codex: InstanceType<
        typeof import('../../packages/happy-cli/src/codex/codexAppServerClient').CodexAppServerClient
    > | null = null;

    try {
        const officialVersion = configureOfficialCodexPath();
        delete process.env.HAPPY_CODEX_APP_SERVER_PATH;
        delete process.env.HAPPY_FAKE_CODEX_SCENARIO;
        fixture = await startCodexResponsesFixture();
        await writeCodexResponsesConfig(codexHome, fixture.baseUrl);
        process.env.CODEX_HOME = codexHome;

        const { CodexAppServerClient } = await import(
            '../../packages/happy-cli/src/codex/codexAppServerClient'
        );
        codex = new CodexAppServerClient();
        const notificationMethods = new Set<string>();
        const itemTypes = new Set<string>();
        let agentText = '';
        let reasoningSummary = '';
        let commandOutput = '';
        codex.setStableNotificationHandler((notification) => {
            notificationMethods.add(notification.method);
            if (
                notification.method === 'item/started'
                || notification.method === 'item/completed'
            ) {
                itemTypes.add(notification.params.item.type);
            } else if (notification.method === 'item/agentMessage/delta') {
                agentText += notification.params.delta;
            } else if (notification.method === 'item/reasoning/summaryTextDelta') {
                reasoningSummary += notification.params.delta;
            } else if (notification.method === 'item/commandExecution/outputDelta') {
                commandOutput += notification.params.delta;
            }
        });

        await codex.connect();
        await codex.startThread({
            cwd: root,
            approvalPolicy: 'never',
            sandbox: 'read-only',
        });
        await withTimeout(
            codex.sendTurnAndWait('exercise the official app-server lifecycle', {
                clientUserMessageId: 'official-app-server-command',
            }),
            90_000,
            'official app-server turn lifecycle',
        );

        const provider = fixture.snapshot();
        assert(provider.requestCount >= 2, 'official Codex did not perform the tool follow-up request');
        assert(provider.toolOutputObserved, 'official Codex did not return function_call_output to the provider');
        for (const method of [
            'turn/started',
            'item/started',
            'item/commandExecution/outputDelta',
            'item/reasoning/summaryTextDelta',
            'item/agentMessage/delta',
            'item/completed',
            'turn/completed',
        ]) {
            assert(notificationMethods.has(method), `official app-server omitted ${method}`);
        }
        for (const itemType of ['commandExecution', 'reasoning', 'agentMessage']) {
            assert(itemTypes.has(itemType), `official app-server omitted ${itemType} item lifecycle`);
        }
        assert(commandOutput.includes(OFFICIAL_CODEX_TOOL_SENTINEL));
        assert(reasoningSummary.includes('official app-server tool round trip'));
        assert.equal(agentText, OFFICIAL_CODEX_RESPONSE_SENTINEL);
        console.log(
            `Official Codex app-server lifecycle passed: version=${officialVersion} requests=${provider.requestCount} tool=ok reasoning=ok stream=ok completion=ok`,
        );
    } finally {
        if (codex) await codex.disconnect().catch(() => undefined);
        await fixture?.close().catch(() => undefined);
        restoreEnvironment('HAPPY_CODEX_APP_SERVER_PATH', originalAppServerPath);
        restoreEnvironment('HAPPY_FAKE_CODEX_SCENARIO', originalFakeScenario);
        restoreEnvironment('CODEX_HOME', originalCodexHome);
        restoreEnvironment('PATH', originalPath);
        await rm(root, { recursive: true, force: true });
    }
}

function configureOfficialCodexPath(): string {
    const binary = process.env.HAPPY_SCENARIO_CODEX_BIN?.trim();
    const expectedVersion = process.env.HAPPY_SCENARIO_CODEX_VERSION?.trim();
    if (!binary) throw new Error('HAPPY_SCENARIO_CODEX_BIN is required');
    if (!expectedVersion) throw new Error('HAPPY_SCENARIO_CODEX_VERSION is required');
    const output = execFileSync(binary, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: CODEX_CLI_VERSION_PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
    }).trim();
    assert.equal(output, `codex-cli ${expectedVersion}`);
    assert(
        isCodexCliVersionAtLeast(
            parseCodexCliVersion(output),
            MINIMUM_CODEX_CLI_VERSION,
        ),
        `${output} is below the Happy minimum`,
    );
    process.env.PATH = `${dirname(binary)}${delimiter}${process.env.PATH ?? ''}`;
    return output;
}

function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
            () => reject(new Error(`Timed out waiting for ${label}`)),
            timeoutMs,
        );
        timer.unref();
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
