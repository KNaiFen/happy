import type { CodexRequestEntityV4 } from '@slopus/happy-wire';
import { describe, expect, it } from 'vitest';
import type { SyncV4ProviderRequestJournalState } from '@/api/syncV4Journal';
import type { CodexServerRequest } from './codexAppServerClient';
import { CodexV4RequestBroker } from './codexV4RequestBroker';

class RecordingMapper {
    readonly requests: CodexRequestEntityV4[] = [];
    readonly transitions: Array<{
        state: SyncV4ProviderRequestJournalState;
        response: CodexRequestEntityV4['response'];
    }> = [];

    async upsertRequest(
        request: CodexRequestEntityV4,
        state: Extract<
            SyncV4ProviderRequestJournalState,
            'pending' | 'resolved' | 'outcomeUnknown'
        > = request.status === 'pending' ? 'pending' : 'resolved',
    ): Promise<void> {
        this.requests.push(request);
        this.transitions.push({ state, response: request.response });
    }

    async persistRequestState(
        _request: CodexRequestEntityV4,
        state: Extract<
            SyncV4ProviderRequestJournalState,
            'responseReady' | 'responseSupplied'
        >,
        response: CodexRequestEntityV4['response'],
    ): Promise<void> {
        this.transitions.push({ state, response });
    }
}

class FailingResponseReadyMapper extends RecordingMapper {
    override async persistRequestState(
        request: CodexRequestEntityV4,
        state: 'responseReady' | 'responseSupplied',
        response: CodexRequestEntityV4['response'],
    ): Promise<void> {
        if (state === 'responseReady') throw new Error('simulated responseReady fsync failure');
        await super.persistRequestState(request, state, response);
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

        const resolution = broker.resolve({
            requestId: 'rpc-7',
            threadId: 'thread-1',
            response: { decision: 'acceptForSession' },
        });
        const managed = await providerResponse;
        expect(managed.response).toEqual({ decision: 'acceptForSession' });
        expect(mapper.requests.at(-1)?.status).toBe('pending');
        await managed.markResponseSupplied();
        await broker.markProviderResolved('thread-1', 'rpc-7');
        await expect(resolution).resolves.toEqual({ providerRequestId: 'rpc-7' });
        expect(mapper.requests.at(-1)).toMatchObject({
            status: 'accepted',
            response: { decision: 'acceptForSession' },
            resolvedAt: expect.any(Number),
        });
        expect(mapper.transitions.map((transition) => transition.state)).toEqual([
            'pending',
            'responseReady',
            'responseSupplied',
            'resolved',
        ]);
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
        const resolution = broker.resolve({ requestId: 'rpc-8', threadId: 'thread-1', response });
        const managed = await providerResponse;
        expect(managed.response).toEqual(response);
        await managed.markResponseSupplied();
        await broker.markProviderResolved('thread-1', 'rpc-8');
        await resolution;
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

    it('does not wake the provider response writer before responseReady is durable', async () => {
        const mapper = new FailingResponseReadyMapper();
        const broker = new CodexV4RequestBroker({ mapper });
        const providerResponse = broker.handle({
            requestId: 'rpc-fsync',
            method: 'item/fileChange/requestApproval',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-fsync' },
        });
        let writerWoke = false;
        const providerSettled = providerResponse.then(
            () => {
                writerWoke = true;
                return null;
            },
            (error: unknown) => error,
        );
        await waitForRequest(mapper);

        await expect(broker.resolve({
            requestId: 'rpc-fsync',
            threadId: 'thread-1',
            response: { decision: 'accept' },
        })).rejects.toThrow('responseReady fsync failure');

        expect(writerWoke).toBe(false);
        expect(mapper.transitions.map((transition) => transition.state)).toEqual(['pending']);
        await broker.failPending('brokerClosed');
        expect(await providerSettled).toBeInstanceOf(Error);
    });

    it('marks unresolved provider requests as errors when their transport is lost', async () => {
        const mapper = new RecordingMapper();
        const broker = new CodexV4RequestBroker({ mapper, now: () => 200 });
        const providerResponse = broker.handle({
            requestId: 'rpc-10',
            method: 'item/fileChange/requestApproval',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-4' },
        });
        const settled = providerResponse.then(
            () => 'resolved',
            (error: unknown) => error,
        );
        await waitForRequest(mapper);

        await broker.failPending('transportDisconnected');

        expect(await settled).toBeInstanceOf(Error);
        expect(mapper.requests.at(-1)).toMatchObject({
            status: 'error',
            response: { error: 'transportDisconnected' },
            resolvedAt: 200,
        });
        expect(broker.pendingCount()).toBe(0);
    });

    it('closes provider requests left pending by a previous CLI process', async () => {
        const mapper = new RecordingMapper();
        const broker = new CodexV4RequestBroker({ mapper, now: () => 250 });
        const staleRequest: CodexRequestEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.request',
            providerId: 'thread-1\0request\0rpc-stale',
            createdAt: 100,
            updatedAt: 100,
            requestId: 'rpc-stale',
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-stale',
            requestType: 'fileChangeApproval',
            status: 'pending',
            title: null,
            prompt: null,
            options: {},
            response: null,
            resolvedAt: null,
        };

        await expect(broker.recoverPending([{
            request: staleRequest,
            state: 'pending',
            response: null,
        }])).resolves.toBe(1);

        expect(mapper.requests).toEqual([{
            ...staleRequest,
            status: 'error',
            response: { error: 'providerProcessRestarted' },
            resolvedAt: 250,
            updatedAt: 250,
        }]);
        expect(mapper.transitions.at(-1)?.state).toBe('resolved');
    });

    it.each(['responseReady', 'responseSupplied'] as const)(
        'recovers a %s provider response as outcome unknown without replaying it',
        async (state) => {
            const mapper = new RecordingMapper();
            const broker = new CodexV4RequestBroker({ mapper, now: () => 275 });
            const staleRequest: CodexRequestEntityV4 = {
                schemaVersion: 1,
                entityType: 'codex.request',
                providerId: `thread-1\0request\0rpc-${state}`,
                createdAt: 100,
                updatedAt: 100,
                requestId: `rpc-${state}`,
                threadId: 'thread-1',
                turnId: 'turn-1',
                itemId: 'item-stale',
                requestType: 'fileChangeApproval',
                status: 'pending',
                title: null,
                prompt: null,
                options: {},
                response: null,
                resolvedAt: null,
            };

            await broker.recoverPending([{
                request: staleRequest,
                state,
                response: { decision: 'accept' },
            }]);

            expect(mapper.requests.at(-1)).toMatchObject({
                status: 'error',
                response: {
                    error: 'providerResponseOutcomeUnknown',
                    previousState: state,
                },
            });
            expect(mapper.transitions.at(-1)?.state).toBe('outcomeUnknown');
        },
    );

    it('marks command resolution unknown after the response reached provider stdin', async () => {
        const mapper = new RecordingMapper();
        const broker = new CodexV4RequestBroker({ mapper });
        const providerResponse = broker.handle({
            requestId: 'rpc-11',
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-5' },
        });
        await waitForRequest(mapper);
        const resolution = broker.resolve({
            requestId: 'rpc-11',
            threadId: 'thread-1',
            response: { decision: 'accept' },
        });
        const managed = await providerResponse;

        await managed.markResponseSupplied();
        await managed.markAbandoned();

        await expect(resolution).rejects.toThrow('transportDisconnected');
        await expect(resolution).rejects.toMatchObject({ name: 'CodexRpcOutcomeUnknownError' });
        expect(mapper.requests.at(-1)).toMatchObject({ status: 'error' });
    });

    it('closes a request that Codex resolves before the App responds', async () => {
        const mapper = new RecordingMapper();
        const broker = new CodexV4RequestBroker({ mapper, now: () => 300 });
        const providerResponse = broker.handle({
            requestId: 'rpc-12',
            method: 'item/tool/requestUserInput',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-6', questions: [] },
        });
        const settled = providerResponse.then(
            () => 'resolved',
            (error: unknown) => error,
        );
        await waitForRequest(mapper);

        await broker.markProviderResolved('thread-1', 'rpc-12');

        expect(await settled).toBeInstanceOf(Error);
        expect(mapper.requests.at(-1)).toMatchObject({
            status: 'resolved',
            response: null,
            resolvedAt: 300,
        });
        expect(broker.pendingCount()).toBe(0);
    });

    it('buffers a provider ACK that arrives before the stdin write callback', async () => {
        const mapper = new RecordingMapper();
        const broker = new CodexV4RequestBroker({ mapper, now: () => 350 });
        const providerResponse = broker.handle({
            requestId: 'rpc-13',
            method: 'item/fileChange/requestApproval',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-7' },
        });
        await waitForRequest(mapper);

        const resolution = broker.resolve({
            requestId: 'rpc-13',
            threadId: 'thread-1',
            response: { decision: 'accept' },
        });
        const managed = await providerResponse;
        await broker.markProviderResolved('thread-1', 'rpc-13');

        expect(broker.pendingCount()).toBe(1);
        expect(mapper.requests.at(-1)?.status).toBe('pending');

        await managed.markResponseSupplied();
        await expect(resolution).resolves.toEqual({ providerRequestId: 'rpc-13' });
        expect(mapper.requests.at(-1)).toMatchObject({
            status: 'accepted',
            response: { decision: 'accept' },
            resolvedAt: 350,
        });
        expect(broker.pendingCount()).toBe(0);
    });
});
