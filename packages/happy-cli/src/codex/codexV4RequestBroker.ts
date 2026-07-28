/** Bridges Codex server requests to durable Sync v4 request entities. */

import {
    CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
    type CodexRequestEntityV4,
} from '@slopus/happy-wire';
import type {
    CodexManagedServerResponse,
    CodexServerRequest,
} from './codexAppServerClient';
import type { CodexSyncV4Mapper } from './codexSyncV4Mapper';
import type { SyncV4PendingProviderRequest } from '@/api/syncV4Journal';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface PendingRequest {
    entity: CodexRequestEntityV4;
    method: CodexServerRequest['method'];
    responsePromise: Promise<unknown>;
    provideResponse: (response: unknown) => void;
    rejectResponse: (error: Error) => void;
    state: 'pending' | 'responseReady' | 'responseSupplied' | 'settling';
    response: CodexRequestEntityV4['response'];
    deliveryPromise: Promise<void> | null;
    markDelivery: (() => void) | null;
    rejectDelivery: ((error: Error) => void) | null;
    providerResolved: boolean;
    transition: Promise<void>;
}

export interface CodexV4RequestResolution {
    requestId: string;
    threadId: string;
    response: unknown;
}

interface RequestBrokerOptions {
    mapper: Pick<CodexSyncV4Mapper, 'upsertRequest' | 'persistRequestState'>;
    now?: () => number;
}

class CodexRequestDeliveryUnknownError extends Error {
    constructor(reason: 'transportDisconnected' | 'brokerClosed') {
        super(`Codex provider request delivery is unknown: ${reason}`);
        this.name = 'CodexRpcOutcomeUnknownError';
    }
}

export class CodexV4RequestBroker {
    private readonly pending = new Map<string, PendingRequest>();

    constructor(private readonly options: RequestBrokerOptions) {}

    async handle(request: CodexServerRequest): Promise<CodexManagedServerResponse> {
        const entity = requestEntity(request, this.now());
        const key = requestKey(entity.threadId, entity.requestId);
        const existing = this.pending.get(key);
        if (existing) return await this.waitForResponse(key, existing);

        let provideResponse!: (response: unknown) => void;
        let rejectResponse!: (error: Error) => void;
        const responsePromise = new Promise<unknown>((resolve, reject) => {
            provideResponse = resolve;
            rejectResponse = reject;
        });
        const pending: PendingRequest = {
            entity,
            method: request.method,
            responsePromise,
            provideResponse,
            rejectResponse,
            state: 'pending',
            response: null,
            deliveryPromise: null,
            markDelivery: null,
            rejectDelivery: null,
            providerResolved: false,
            transition: Promise.resolve(),
        };
        this.pending.set(key, pending);
        try {
            await this.options.mapper.upsertRequest(entity, 'pending');
        } catch (error) {
            this.pending.delete(key);
            throw error;
        }
        return await this.waitForResponse(key, pending);
    }

    async resolve(resolution: CodexV4RequestResolution): Promise<{ providerRequestId: string }> {
        const key = requestKey(resolution.threadId, resolution.requestId);
        const pending = this.pending.get(key);
        if (!pending) throw new Error('Codex request is no longer pending');
        const response = validateResponse(pending.method, resolution.response);
        await this.transition(pending, async () => {
            if (this.pending.get(key) !== pending) {
                throw new Error('Codex request is no longer pending');
            }
            if (pending.state !== 'pending') {
                throw new Error('Codex request response is already awaiting delivery');
            }
            await this.options.mapper.persistRequestState(
                pending.entity,
                'responseReady',
                response,
            );
            pending.state = 'responseReady';
            pending.response = response;
            pending.deliveryPromise = new Promise<void>((resolve, reject) => {
                pending.markDelivery = resolve;
                pending.rejectDelivery = reject;
            });
            pending.provideResponse(response);
        });
        if (!pending.deliveryPromise) throw new Error('Codex request delivery was not initialized');
        await pending.deliveryPromise;
        return { providerRequestId: resolution.requestId };
    }

    async recoverPending(requests: readonly SyncV4PendingProviderRequest[]): Promise<number> {
        for (const pending of requests) {
            const now = this.now();
            const outcomeUnknown = pending.state !== 'pending';
            const request = pending.request;
            await this.options.mapper.upsertRequest({
                ...request,
                status: 'error',
                response: outcomeUnknown
                    ? { error: 'providerResponseOutcomeUnknown', previousState: pending.state }
                    : { error: 'providerProcessRestarted' },
                resolvedAt: now,
                updatedAt: now,
            }, outcomeUnknown ? 'outcomeUnknown' : 'resolved');
        }
        return requests.length;
    }

    async failPending(reason: 'transportDisconnected' | 'brokerClosed'): Promise<void> {
        const failures = [...this.pending.entries()].map(([key, pending]) => (
            this.markAbandoned(key, pending, reason)
        ));
        const results = await Promise.allSettled(failures);
        const failedWrite = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failedWrite) throw failedWrite.reason;
    }

    async markProviderResolved(threadId: string, requestId: string): Promise<void> {
        const key = requestKey(threadId, requestId);
        const pending = this.pending.get(key);
        if (!pending) return;
        await this.transition(pending, async () => {
            if (this.pending.get(key) !== pending || pending.state === 'settling') return;
            await this.markProviderResolvedLocked(key, pending);
        });
    }

    pendingCount(): number {
        return this.pending.size;
    }

    private now(): number {
        return Math.max(0, Math.trunc(this.options.now?.() ?? Date.now()));
    }

    private async waitForResponse(
        key: string,
        pending: PendingRequest,
    ): Promise<CodexManagedServerResponse> {
        const response = await pending.responsePromise;
        return {
            response,
            markResponseSupplied: () => this.markResponseSupplied(key, pending),
            markDelivered: () => this.markDelivered(key, pending),
            markAbandoned: () => this.markAbandoned(key, pending, 'transportDisconnected'),
        };
    }

    private async markProviderResolvedLocked(
        key: string,
        pending: PendingRequest,
    ): Promise<void> {
        if (pending.state === 'responseSupplied') {
            await this.markDeliveredLocked(key, pending);
            return;
        }
        if (pending.state === 'responseReady') {
            pending.providerResolved = true;
            return;
        }

        pending.state = 'settling';
        const error = new Error('Codex provider resolved the request before Happy supplied a response');
        const now = this.now();
        const entity: CodexRequestEntityV4 = {
            ...pending.entity,
            status: 'resolved',
            response: null,
            resolvedAt: now,
            updatedAt: now,
        };
        try {
            await this.options.mapper.upsertRequest(entity, 'resolved');
        } finally {
            this.pending.delete(key);
            pending.rejectResponse(error);
            pending.rejectDelivery?.(error);
        }
    }

    private async markResponseSupplied(key: string, pending: PendingRequest): Promise<void> {
        await this.transition(pending, async () => {
            if (this.pending.get(key) !== pending || pending.state !== 'responseReady') return;
            await this.options.mapper.persistRequestState(
                pending.entity,
                'responseSupplied',
                pending.response,
            );
            pending.state = 'responseSupplied';
            if (pending.providerResolved) await this.markDeliveredLocked(key, pending);
        });
    }

    private async markDelivered(key: string, pending: PendingRequest): Promise<void> {
        await this.transition(pending, async () => {
            await this.markDeliveredLocked(key, pending);
        });
    }

    private async markDeliveredLocked(key: string, pending: PendingRequest): Promise<void> {
        if (this.pending.get(key) !== pending || pending.state !== 'responseSupplied') return;
        pending.state = 'settling';
        const now = this.now();
        const entity: CodexRequestEntityV4 = {
            ...pending.entity,
            status: responseStatus(pending.method, pending.response),
            response: asJsonValue(pending.response),
            resolvedAt: now,
            updatedAt: now,
        };
        try {
            await this.options.mapper.upsertRequest(entity, 'resolved');
            this.pending.delete(key);
            pending.markDelivery?.();
        } catch (error) {
            this.pending.delete(key);
            pending.rejectDelivery?.(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    private async markAbandoned(
        key: string,
        pending: PendingRequest,
        reason: 'transportDisconnected' | 'brokerClosed',
    ): Promise<void> {
        await this.transition(pending, async () => {
            await this.markAbandonedLocked(key, pending, reason);
        });
    }

    private async markAbandonedLocked(
        key: string,
        pending: PendingRequest,
        reason: 'transportDisconnected' | 'brokerClosed',
    ): Promise<void> {
        if (this.pending.get(key) !== pending || pending.state === 'settling') return;
        const responseOutcomeUnknown = pending.state === 'responseReady'
            || pending.state === 'responseSupplied'
            || pending.providerResolved;
        pending.state = 'settling';
        const error = responseOutcomeUnknown
            ? new CodexRequestDeliveryUnknownError(reason)
            : new Error(`Codex provider request is unavailable: ${reason}`);
        const now = this.now();
        const entity: CodexRequestEntityV4 = {
            ...pending.entity,
            status: 'error',
            response: responseOutcomeUnknown
                ? { error: 'providerResponseOutcomeUnknown', reason }
                : { error: reason },
            resolvedAt: now,
            updatedAt: now,
        };
        try {
            await this.options.mapper.upsertRequest(
                entity,
                responseOutcomeUnknown ? 'outcomeUnknown' : 'resolved',
            );
        } finally {
            this.pending.delete(key);
            pending.rejectResponse(error);
            pending.rejectDelivery?.(error);
        }
    }

    private async transition<T>(
        pending: PendingRequest,
        operation: () => Promise<T>,
    ): Promise<T> {
        const result = pending.transition.then(operation);
        pending.transition = result.then(
            () => undefined,
            () => undefined,
        );
        return await result;
    }
}

function requestEntity(request: CodexServerRequest, now: number): CodexRequestEntityV4 {
    const params = asRecord(request.params);
    const threadId = requiredString(params.threadId, 'Codex request threadId is missing');
    const turnId = optionalString(params.turnId);
    const itemId = optionalString(params.itemId);
    const requestType = mapRequestType(request.method);
    const startedAt = typeof params.startedAtMs === 'number' && params.startedAtMs >= 0
        ? Math.trunc(params.startedAtMs)
        : now;
    const options = requestOptions(request.method, params);
    return {
        schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
        entityType: 'codex.request',
        providerId: `${threadId}\0request\0${request.requestId}`,
        createdAt: startedAt,
        updatedAt: now,
        requestId: request.requestId,
        threadId,
        turnId,
        itemId,
        requestType,
        status: 'pending',
        title: requestTitle(request.method, params),
        prompt: optionalString(params.reason) ?? optionalString(params.message),
        options,
        response: null,
        resolvedAt: null,
    };
}

function mapRequestType(method: CodexServerRequest['method']): CodexRequestEntityV4['requestType'] {
    switch (method) {
        case 'item/commandExecution/requestApproval': return 'commandApproval';
        case 'item/fileChange/requestApproval': return 'fileChangeApproval';
        case 'item/permissions/requestApproval': return 'permissions';
        case 'item/tool/requestUserInput':
        case 'mcpServer/elicitation/request':
            return 'toolUserInput';
    }
}

function requestOptions(
    method: CodexServerRequest['method'],
    params: Record<string, unknown>,
): JsonValue {
    switch (method) {
        case 'item/commandExecution/requestApproval':
            return asJsonValue({
                command: params.command,
                cwd: params.cwd,
                commandActions: params.commandActions,
                proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
                proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments,
            });
        case 'item/fileChange/requestApproval':
            return asJsonValue({ grantRoot: params.grantRoot });
        case 'item/permissions/requestApproval':
            return asJsonValue({
                cwd: params.cwd,
                permissions: params.permissions,
                environmentId: params.environmentId,
            });
        case 'item/tool/requestUserInput':
            return asJsonValue({
                requestMethod: method,
                questions: params.questions,
                autoResolutionMs: params.autoResolutionMs,
            });
        case 'mcpServer/elicitation/request':
            return asJsonValue({ requestMethod: method, ...params });
    }
}

function requestTitle(
    method: CodexServerRequest['method'],
    params: Record<string, unknown>,
): string | null {
    if (method === 'item/tool/requestUserInput' && Array.isArray(params.questions)) {
        const first = params.questions[0];
        if (first && typeof first === 'object' && !Array.isArray(first)) {
            return optionalString((first as Record<string, unknown>).header);
        }
    }
    return method === 'mcpServer/elicitation/request' ? optionalString(params.serverName) : null;
}

function validateResponse(method: CodexServerRequest['method'], response: unknown): JsonValue {
    const value = asRecord(response);
    switch (method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval': {
            const decision = optionalString(value.decision);
            if (decision !== 'accept' && decision !== 'acceptForSession' && decision !== 'decline' && decision !== 'cancel') {
                throw new Error('Invalid Codex approval decision');
            }
            return { decision };
        }
        case 'item/permissions/requestApproval': {
            const scope = optionalString(value.scope);
            if (scope !== 'turn' && scope !== 'session') throw new Error('Invalid Codex permission scope');
            const permissions = asRecord(value.permissions);
            return {
                permissions: asJsonValue(permissions),
                scope,
                ...(typeof value.strictAutoReview === 'boolean' ? { strictAutoReview: value.strictAutoReview } : {}),
            };
        }
        case 'item/tool/requestUserInput': {
            const answers = asRecord(value.answers);
            const normalized: Record<string, { answers: string[] }> = {};
            for (const [questionId, answer] of Object.entries(answers)) {
                const answerRecord = asRecord(answer);
                if (!Array.isArray(answerRecord.answers) || !answerRecord.answers.every((entry) => typeof entry === 'string')) {
                    throw new Error('Invalid Codex user-input answer');
                }
                normalized[questionId] = { answers: answerRecord.answers };
            }
            return { answers: normalized };
        }
        case 'mcpServer/elicitation/request': {
            const action = optionalString(value.action);
            if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
                throw new Error('Invalid MCP elicitation action');
            }
            return {
                action,
                content: asJsonValue(value.content),
                _meta: asJsonValue(value._meta),
            };
        }
    }
}

function responseStatus(
    method: CodexServerRequest['method'],
    response: unknown,
): CodexRequestEntityV4['status'] {
    const value = asRecord(response);
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        if (value.decision === 'accept' || value.decision === 'acceptForSession') return 'accepted';
        if (value.decision === 'decline') return 'declined';
        return 'cancelled';
    }
    if (method === 'mcpServer/elicitation/request') {
        if (value.action === 'accept') return 'accepted';
        if (value.action === 'decline') return 'declined';
        return 'cancelled';
    }
    return 'resolved';
}

function requestKey(threadId: string, requestId: string): string {
    return `${threadId}\0${requestId}`;
}

function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
}

function asJsonValue(value: unknown): JsonValue {
    if (value === undefined) return null;
    try {
        const encoded = JSON.stringify(value);
        return encoded === undefined ? null : JSON.parse(encoded) as JsonValue;
    } catch {
        return null;
    }
}

function optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function requiredString(value: unknown, message: string): string {
    const normalized = optionalString(value);
    if (!normalized) throw new Error(message);
    return normalized;
}
