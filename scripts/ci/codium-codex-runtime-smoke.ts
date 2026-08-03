import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
    OFFICIAL_CODEX_RESPONSE_SENTINEL,
    OFFICIAL_CODEX_TOOL_SENTINEL,
    startCodexResponsesFixture,
    writeCodexResponsesConfig,
    type CodexResponsesFixtureSnapshot,
} from './codex-responses-fixture';
import {
    launchCodexTurn,
    resolveCodexExecutable,
    type CodexTurnObserver,
} from '../../packages/codium/sources/boot/main/agent-worker/codex-cli';

async function main(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'codium-codex-runtime-'));
    const codexHome = join(root, 'codex-home');
    const originalCodexHome = process.env.CODEX_HOME;
    const originalPath = process.env.PATH;
    const fixture = await startCodexResponsesFixture();
    try {
        execFileSync('git', ['init', '--quiet'], {
            cwd: root,
            stdio: 'ignore',
            timeout: 15_000,
        });
        await writeCodexResponsesConfig(codexHome, fixture.baseUrl);
        process.env.CODEX_HOME = codexHome;

        const runtime = resolveCodexExecutable();
        assert(existsSync(runtime.executable), `Bundled Codex executable is missing: ${runtime.executable}`);
        process.env.PATH = [...runtime.extraPathDirs, originalPath ?? ''].filter(Boolean).join(delimiter);
        const version = execFileSync(runtime.executable, ['--version'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 15_000,
            maxBuffer: 64 * 1024,
        }).trim();
        assert.match(version, /^codex-cli \d+\.\d+\.\d+$/);

        let finalText = '';
        const errors: string[] = [];
        let turnResult: { subtype: 'success' | 'error'; error?: string } | null = null;
        const observer = {
            onAssistantComplete(text) {
                finalText += text;
            },
            onTurnDone(result) {
                turnResult = result;
            },
            onError(message) {
                errors.push(message);
            },
        } satisfies CodexTurnObserver;
        const turn = await launchCodexTurn({
            prompt: 'exercise the Codium bundled Codex one-shot lifecycle',
            cwd: root,
            effort: 'high',
        }, observer);
        try {
            await withTimeout(turn.completed, 90_000, 'Codium bundled Codex one-shot turn');
        } catch (error) {
            turn.stop();
            reportTimeoutDiagnostics(fixture.snapshot());
            await withTimeout(
                turn.completed,
                10_000,
                'Codium bundled Codex turn termination',
            ).catch((terminationError) => {
                console.error(`Codium Codex termination diagnostic: ${errorMessage(terminationError)}`);
            });
            throw error;
        }

        assert.deepEqual(errors, []);
        assert.deepEqual(turnResult, { subtype: 'success' });
        assert.equal(finalText, OFFICIAL_CODEX_RESPONSE_SENTINEL);
        const snapshot = fixture.snapshot();
        assert(snapshot.requestCount >= 2, 'Codium Codex did not issue a tool follow-up request');
        assert(snapshot.toolOutputObserved, 'Codium Codex did not return function_call_output');
        console.log(`Codium Codex runtime passed: ${version}; requests=${snapshot.requestCount}; tool=${OFFICIAL_CODEX_TOOL_SENTINEL}`);
    } finally {
        await fixture.close().catch(() => undefined);
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = originalCodexHome;
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await rm(root, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
        });
    }
}

function reportTimeoutDiagnostics(snapshot: CodexResponsesFixtureSnapshot): void {
    const shapes = snapshot.requestShapes
        .map(({ contentEncoding, inputTypes }) => `${contentEncoding}:${inputTypes.join(',') || 'none'}`)
        .join('|') || 'none';
    console.error(
        `Codium Codex timeout diagnostics: requests=${snapshot.requestCount}; tool_output=${snapshot.toolOutputObserved}; input_shapes=${shapes}`,
    );
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function withTimeout(promise: Promise<void>, timeoutMs: number, label: string): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
        timer.unref();
    });
    try {
        await Promise.race([promise, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
