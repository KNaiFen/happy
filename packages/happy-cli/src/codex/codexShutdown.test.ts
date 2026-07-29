import { describe, expect, it, vi } from 'vitest';
import {
    closeCodexV4BindingResources,
    runCodexShutdownSteps,
    type CodexShutdownStage,
} from './codexShutdown';

describe('runCodexShutdownSteps', () => {
    it('continues through every stage and reports failures without retaining payloads', async () => {
        const calls: string[] = [];
        const failures: CodexShutdownStage[] = [];
        const secret = 'prompt-reasoning-tool-output-secret';

        const failureCount = await runCodexShutdownSteps([
            {
                stage: 'providerDisconnect',
                run: async () => {
                    calls.push('provider');
                    throw new Error(secret);
                },
            },
            {
                stage: 'protocolTrace',
                run: async () => {
                    calls.push('trace');
                },
            },
            {
                stage: 'mcpServer',
                run: () => {
                    calls.push('mcp');
                    throw new Error('mcp-close-secret');
                },
            },
            {
                stage: 'diagnosticClose',
                run: async () => {
                    calls.push('diagnostics');
                },
            },
        ], (stage) => {
            failures.push(stage);
        });

        expect(failureCount).toBe(2);
        expect(calls).toEqual(['provider', 'trace', 'mcp', 'diagnostics']);
        expect(failures).toEqual(['providerDisconnect', 'mcpServer']);
        expect(JSON.stringify(failures)).not.toContain(secret);
    });

    it('continues when the failure reporter itself throws', async () => {
        const finalStage = vi.fn();

        const failureCount = await runCodexShutdownSteps([
            {
                stage: 'sessionFlush',
                run: async () => {
                    throw new Error('session payload secret');
                },
            },
            {
                stage: 'diagnosticClose',
                run: finalStage,
            },
        ], () => {
            throw new Error('logger unavailable');
        });

        expect(failureCount).toBe(1);
        expect(finalStage).toHaveBeenCalledOnce();
    });
});

describe('closeCodexV4BindingResources', () => {
    it('attempts every close boundary and rethrows the first failure', async () => {
        const calls: string[] = [];
        const firstError = new Error('command processor failed');

        await expect(closeCodexV4BindingResources({
            commandProcessor: {
                close: () => {
                    calls.push('commandProcessor');
                    throw firstError;
                },
            },
            requestBroker: {
                failPending: async () => {
                    calls.push('requestBroker');
                    throw new Error('request broker failed');
                },
            },
            mapper: {
                close: async () => {
                    calls.push('mapper');
                    throw new Error('mapper failed');
                },
            },
            syncClient: {
                flushOutboundOnce: async () => {
                    calls.push('flushOutbound');
                    throw new Error('flush failed');
                },
                close: async () => {
                    calls.push('syncClient');
                    throw new Error('sync client failed');
                },
            },
            session: {
                close: async () => {
                    calls.push('session');
                    throw new Error('session failed');
                },
            },
        })).rejects.toBe(firstError);

        expect(calls).toEqual([
            'commandProcessor',
            'requestBroker',
            'mapper',
            'flushOutbound',
            'syncClient',
            'session',
        ]);
    });
});
