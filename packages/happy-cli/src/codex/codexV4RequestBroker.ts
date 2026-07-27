/** Bridges Codex server requests to durable Sync v4 request entities. */

import {
    CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
    type CodexRequestEntityV4,
} from '@slopus/happy-wire';
import type { CodexServerRequest } from './codexAppServerClient';
import type { CodexSyncV4Mapper } from './codexSyncV4Mapper';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface PendingRequest {
    entity: CodexRequestEntityV4;
    method: CodexServerRequest['method'];
    promise: Promise<unknown>;
    resolve: (response: unknown) => void;
}

export interface CodexV4RequestResolution {
    requestId: string;
    threadId: string;
    response: unknown;
}

interface RequestBrokerOptions {
    mapper: Pick<CodexSyncV4Mapper, 'upsertRequest'>;
    now?: () => number;
}

export class CodexV4RequestBroker {
    private readonly pending = new Map<string, PendingRequest>();

    constructor(private readonly options: RequestBrokerOptions) {}

    async handle(request: CodexServerRequest): Promise<unknown> {
        const entity = requestEntity(request, this.now());
        const key = requestKey(entity.threadId, entity.requestId);
        const existing = this.pending.get(key);
        if (existing) return await existing.promise;

        let resolve!: (response: unknown) => void;
        const promise = new Promise<unknown>((complete) => { resolve = complete; });
        const pending: PendingRequest = { entity, method: request.method, promise, resolve };
        this.pending.set(key, pending);
        try {
            await this.options.mapper.upsertRequest(entity);
        } catch (error) {
            this.pending.delete(key);
            throw error;
        }
        return await promise;
    }

    async resolve(resolution: CodexV4RequestResolution): Promise<{ providerRequestId: string }> {
        const key = requestKey(resolution.threadId, resolution.requestId);
        const pending = this.pending.get(key);
        if (!pending) throw new Error('Codex request is no longer pending');
        const response = validateResponse(pending.method, resolution.response);
        const now = this.now();
        const entity: CodexRequestEntityV4 = {
            ...pending.entity,
            status: responseStatus(pending.method, response),
            response: asJsonValue(response),
            resolvedAt: now,
            updatedAt: now,
        };
        await this.options.mapper.upsertRequest(entity);
        this.pending.delete(key);
        pending.resolve(response);
        return { providerRequestId: resolution.requestId };
    }

    pendingCount(): number {
        return this.pending.size;
    }

    private now(): number {
        return Math.max(0, Math.trunc(this.options.now?.() ?? Date.now()));
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
                questions: params.questions,
                autoResolutionMs: params.autoResolutionMs,
            });
        case 'mcpServer/elicitation/request':
            return asJsonValue(params);
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

function validateResponse(method: CodexServerRequest['method'], response: unknown): unknown {
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
