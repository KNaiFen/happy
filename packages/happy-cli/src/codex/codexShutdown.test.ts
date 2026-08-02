import { describe, expect, it, vi } from 'vitest';
import { closeCodexV4BindingResources } from './codexShutdown';

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
