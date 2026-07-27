import type { CodexRequestEntityV4 } from '@slopus/happy-wire';
import { describe, expect, it } from 'vitest';
import type { CodexServerRequest } from './codexAppServerClient';
import { CodexV4RequestBroker } from './codexV4RequestBroker';

class RecordingMapper {
    readonly requests: CodexRequestEntityV4[] = [];

    async upsertRequest(request: CodexRequestEntityV4): Promise<void> {
        this.requests.push(request);
    }
}

async function waitForRequest(mapper: RecordingMapper): Promise<void> {
    for (let index = 0; index < 10 && mapper.requests.length === 0; index += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

describe('CodexV4RequestBroker', () => {
    it('publishes and resolves command approval by server request id', async () => {
        const mapper = new RecordingMapper();
        let now = 100;
        const broker = new CodexV4RequestBroker({ mapper, now: () => now++ });
        const request: CodexServerRequest = {
            requestId: 'rpc-7',
            method: 'item/commandExecution/requestApproval',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                itemId: 'item-1',
                startedAtMs: 90,
                command: 'git status',
                cwd: '/workspace',
                reason: 'needs approval',
            },
        };
        const providerResponse = broker.handle(request);
        await waitForRequest(mapper);

        expect(mapper.requests[0]).toMatchObject({
            providerId: 'thread-1\0request\0rpc-7',
            requestId: 'rpc-7',
            requestType: 'commandApproval',
            status: 'pending',
            prompt: 'needs approval',
            options: { command: 'git status', cwd: '/workspace' },
        });

        await broker.resolve({
            requestId: 'rpc-7',
            threadId: 'thread-1',
            response: { decision: 'acceptForSession' },
        });
        expect(await providerResponse).toEqual({ decision: 'acceptForSession' });
        expect(mapper.requests.at(-1)).toMatchObject({
            status: 'accepted',
            response: { decision: 'acceptForSession' },
            resolvedAt: expect.any(Number),
        });
        expect(broker.pendingCount()).toBe(0);
    });

    it('round-trips structured tool user input without flattening answers', async () => {
        const mapper = new RecordingMapper();
        const broker = new CodexV4RequestBroker({ mapper });
        const providerResponse = broker.handle({
            requestId: 'rpc-8',
            method: 'item/tool/requestUserInput',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                itemId: 'item-2',
                questions: [{ id: 'choice', header: 'Mode', question: 'Choose', options: null }],
                autoResolutionMs: null,
            },
        });
        await waitForRequest(mapper);

        const response = { answers: { choice: { answers: ['safe', 'fast'] } } };
        await broker.resolve({ requestId: 'rpc-8', threadId: 'thread-1', response });
        expect(await providerResponse).toEqual(response);
        expect(mapper.requests.at(-1)).toMatchObject({ requestType: 'toolUserInput', status: 'resolved', response });
    });

    it('keeps the provider request pending when a response is invalid', async () => {
        const mapper = new RecordingMapper();
        const broker = new CodexV4RequestBroker({ mapper });
        void broker.handle({
            requestId: 'rpc-9',
            method: 'item/fileChange/requestApproval',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-3' },
        });
        await waitForRequest(mapper);

        await expect(broker.resolve({
            requestId: 'rpc-9',
            threadId: 'thread-1',
            response: { decision: 'always' },
        })).rejects.toThrow('Invalid Codex approval decision');
        expect(broker.pendingCount()).toBe(1);
        expect(mapper.requests).toHaveLength(1);
    });
});
