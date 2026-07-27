/** Maps validated Sync v4 command entities to Codex stable-v2 RPC methods. */

import type { CodexCommandEntityV4 } from '@slopus/happy-wire';
import type {
    ApprovalPolicy,
    InputItem,
    ReviewStartParams,
    SandboxMode,
    Thread,
} from './protocol';
import { CodexAppServerClient } from './codexAppServerClient';
import type {
    CodexV4CommandOutcome,
    CodexV4CommandReconciliation,
} from './codexV4CommandProcessor';
import type { CodexV4RequestBroker } from './codexV4RequestBroker';

interface CommandExecutorOptions {
    client: CodexAppServerClient;
    requestBroker: Pick<CodexV4RequestBroker, 'resolve'>;
    defaultCwd: string;
    mcpServers?: Record<string, unknown>;
    preparePrompt?: (text: string, command: CodexCommandEntityV4) => string;
    onTurnStarted?: (command: CodexCommandEntityV4) => void;
    prepareAttachments?: (attachments: CodexV4AttachmentReference[]) => Promise<InputItem[]>;
    resolveExecutionPolicy?: (permissionMode: string) => {
        approvalPolicy: ApprovalPolicy;
        sandbox: SandboxMode;
    };
    resolveEffort?: (model: string | undefined, effort: string | undefined) => string | null | undefined;
}

export interface CodexV4AttachmentReference {
    ref: string;
    name: string;
    mimeType: string;
}

const READ_ONLY_COMMANDS = new Set([
    'thread.read',
    'skills.list',
    'mcp.status.list',
    'model.list',
]);

export class CodexV4CommandExecutor {
    constructor(private readonly options: CommandExecutorOptions) {}

    async execute(command: CodexCommandEntityV4): Promise<CodexV4CommandOutcome> {
        const payload = commandPayload(command.payload);
        switch (command.command) {
            case 'thread.start': {
                const result = await this.options.client.startThread({
                    model: optionalString(payload.model) ?? undefined,
                    cwd: optionalString(payload.cwd) ?? this.options.defaultCwd,
                    approvalPolicy: approvalPolicy(payload.approvalPolicy),
                    sandbox: sandboxMode(payload.sandbox),
                    mcpServers: this.options.mcpServers,
                });
                return { threadId: result.threadId, result: { model: result.model } };
            }
            case 'thread.resume': {
                const threadId = commandThreadId(command, payload);
                const result = await this.options.client.resumeThread({
                    threadId,
                    model: optionalString(payload.model) ?? undefined,
                    cwd: optionalString(payload.cwd) ?? this.options.defaultCwd,
                    approvalPolicy: approvalPolicy(payload.approvalPolicy),
                    sandbox: sandboxMode(payload.sandbox),
                    mcpServers: this.options.mcpServers,
                });
                return { threadId: result.threadId, result: { model: result.model } };
            }
            case 'thread.read': {
                const threadId = commandThreadId(command, payload);
                const result = await this.options.client.readThreadComplete({ threadId });
                return { threadId: result.thread.id, result: { status: result.thread.status } };
            }
            case 'thread.fork': {
                const threadId = commandThreadId(command, payload);
                const result = await this.options.client.forkThread({
                    threadId,
                    model: optionalString(payload.model) ?? undefined,
                    cwd: optionalString(payload.cwd) ?? this.options.defaultCwd,
                    approvalPolicy: approvalPolicy(payload.approvalPolicy),
                    sandbox: sandboxMode(payload.sandbox),
                    mcpServers: this.options.mcpServers,
                });
                return { threadId: result.threadId, result: { model: result.model, forkedFromThreadId: threadId } };
            }
            case 'thread.rollback': {
                const threadId = commandThreadId(command, payload);
                assertNoUnsupportedInput(payload, 'thread.rollback');
                let numTurns: number;
                if (payload.allTurns === true) {
                    const snapshot = await this.options.client.readThreadComplete({ threadId });
                    numTurns = snapshot.thread.turns.length;
                    if (numTurns === 0) return { threadId, result: { rolledBackTurns: 0 } };
                } else {
                    numTurns = positiveInt(payload.numTurns, 'thread.rollback requires a positive numTurns');
                }
                const result = await this.options.client.rollbackThread({ threadId, numTurns });
                return { threadId: result.thread.id, result: { rolledBackTurns: numTurns } };
            }
            case 'thread.compact': {
                const threadId = commandThreadId(command, payload);
                assertNoUnsupportedInput(payload, 'thread.compact');
                if (optionalString(payload.unsupportedPrompt)) {
                    throw new Error('thread.compact does not support a per-request prompt');
                }
                await this.options.client.compactThread(threadId);
                return { threadId, result: { started: true } };
            }
            case 'turn.start':
                return await this.startTurn(command, payload);
            case 'turn.steer': {
                const threadId = commandThreadId(command, payload);
                const expectedTurnId = command.expectedTurnId ?? requiredString(
                    payload.expectedTurnId,
                    'turn.steer requires expectedTurnId',
                );
                const extraInputItems = await this.extraInputItems(payload);
                const text = optionalString(payload.text) ?? '';
                if (!text && extraInputItems.length === 0) throw new Error('turn.steer requires input');
                await this.options.client.steerTurnOnThread(
                    threadId,
                    expectedTurnId,
                    text,
                    { clientUserMessageId: command.commandId, extraInputItems },
                );
                return { threadId, turnId: expectedTurnId };
            }
            case 'turn.interrupt': {
                const threadId = commandThreadId(command, payload);
                const expectedTurnId = command.expectedTurnId ?? requiredString(
                    payload.expectedTurnId,
                    'turn.interrupt requires expectedTurnId',
                );
                await this.options.client.interruptTurnOnThread(threadId, expectedTurnId, {
                    propagateErrors: true,
                });
                return { threadId, turnId: expectedTurnId };
            }
            case 'review.start': {
                const threadId = commandThreadId(command, payload);
                assertNoUnsupportedInput(payload, 'review.start');
                const target = reviewTarget(payload.target);
                const delivery = reviewDelivery(payload.delivery);
                const result = await this.options.client.startReview({ threadId, target, delivery });
                return {
                    threadId: result.reviewThreadId,
                    turnId: result.turn.id,
                    result: { reviewThreadId: result.reviewThreadId },
                };
            }
            case 'request.resolve': {
                const threadId = commandThreadId(command, payload);
                const requestId = requiredString(payload.requestId, 'request.resolve requires requestId');
                const result = await this.options.requestBroker.resolve({
                    threadId,
                    requestId,
                    response: payload.response,
                });
                return { threadId, providerRequestId: result.providerRequestId };
            }
            case 'goal.set': {
                const threadId = commandThreadId(command, payload);
                assertNoUnsupportedInput(payload, 'goal.set');
                const result = await this.options.client.setGoal({
                    threadId,
                    objective: requiredString(payload.objective, 'goal.set requires objective'),
                    status: goalStatus(payload.status),
                    tokenBudget: nullableNonnegativeInt(payload.tokenBudget),
                });
                return { threadId, result: { goal: result.goal } };
            }
            case 'goal.clear': {
                const threadId = commandThreadId(command, payload);
                assertNoUnsupportedInput(payload, 'goal.clear');
                const result = await this.options.client.clearGoal({ threadId });
                return { threadId, result };
            }
            case 'skills.list': {
                assertNoUnsupportedInput(payload, 'skills.list');
                if (optionalString(payload.unsupportedArguments)) {
                    throw new Error('skills.list does not accept arguments');
                }
                const result = await this.options.client.listSkills({
                    cwds: stringArray(payload.cwds) ?? [this.options.defaultCwd],
                    forceReload: payload.forceReload === true,
                });
                return { threadId: command.threadId, result: { skills: result.data } };
            }
            case 'mcp.status.list': {
                assertNoUnsupportedInput(payload, 'mcp.status.list');
                if (optionalString(payload.unsupportedArguments)) {
                    throw new Error('mcp.status.list does not accept arguments');
                }
                const threadId = optionalString(payload.threadId) ?? command.threadId;
                const result = await this.options.client.listMcpServerStatus({ threadId });
                return { threadId, result: { servers: result } };
            }
            case 'model.list': {
                const result = await this.options.client.listModels();
                return { threadId: command.threadId, result: { models: result } };
            }
            default:
                throw new Error(`Unsupported Codex v4 command: ${command.command}`);
        }
    }

    async reconcile(command: CodexCommandEntityV4): Promise<CodexV4CommandReconciliation> {
        if (command.command === 'turn.start' || command.command === 'turn.steer') {
            const payload = commandPayload(command.payload);
            const threadId = commandThreadId(command, payload);
            const snapshot = await this.options.client.readThreadComplete({ threadId });
            const submittedTurnId = findClientUserMessage(snapshot.thread, command.commandId);
            return submittedTurnId
                ? { action: 'succeeded', threadId, turnId: submittedTurnId }
                : { action: 'retry' };
        }
        if (READ_ONLY_COMMANDS.has(command.command)) return { action: 'retry' };
        return {
            action: 'notReplayed',
            error: `${command.command} outcome is unknown and the operation is not safe to replay`,
        };
    }

    private async startTurn(
        command: CodexCommandEntityV4,
        payload: Record<string, unknown>,
    ): Promise<CodexV4CommandOutcome> {
        let threadId = optionalString(payload.threadId) ?? command.threadId;
        if (!threadId) {
            const started = await this.options.client.startThread({
                model: optionalString(payload.model) ?? undefined,
                cwd: optionalString(payload.cwd) ?? this.options.defaultCwd,
                approvalPolicy: approvalPolicy(payload.approvalPolicy),
                sandbox: sandboxMode(payload.sandbox),
                mcpServers: this.options.mcpServers,
            });
            threadId = started.threadId;
        } else if (this.options.client.threadId !== threadId) {
            await this.options.client.resumeThread({
                threadId,
                cwd: optionalString(payload.cwd) ?? this.options.defaultCwd,
                mcpServers: this.options.mcpServers,
            });
        }
        const rawText = optionalString(payload.text) ?? '';
        const extraInputItems = await this.extraInputItems(payload);
        if (!rawText && extraInputItems.length === 0) throw new Error('turn.start requires input');
        const prompt = this.options.preparePrompt?.(rawText, command) ?? rawText;
        const model = optionalString(payload.model) ?? undefined;
        const requestedEffort = optionalString(payload.effort) ?? undefined;
        const permissionMode = optionalString(payload.permissionMode);
        const executionPolicy = permissionMode
            ? this.options.resolveExecutionPolicy?.(permissionMode)
            : undefined;
        const resolvedEffort = this.options.resolveEffort
            ? this.options.resolveEffort(model, requestedEffort)
            : requestedEffort;
        const result = await this.options.client.startTurnOnThread(threadId, prompt, {
            model,
            cwd: optionalString(payload.cwd) ?? undefined,
            approvalPolicy: executionPolicy?.approvalPolicy ?? approvalPolicy(payload.approvalPolicy),
            sandbox: executionPolicy?.sandbox ?? sandboxMode(payload.sandbox),
            effort: resolvedEffort ?? undefined,
            clientUserMessageId: command.commandId,
            extraInputItems,
        });
        this.options.onTurnStarted?.(command);
        return { threadId, turnId: result.turnId };
    }

    private async extraInputItems(payload: Record<string, unknown>): Promise<InputItem[]> {
        const input: InputItem[] = [];
        const attachments = attachmentReferences(payload.attachments);
        if (attachments.length > 0) {
            if (!this.options.prepareAttachments) throw new Error('Codex v4 attachments are unavailable');
            input.push(...await this.options.prepareAttachments(attachments));
        }

        const skillName = optionalString(payload.skillName);
        if (skillName) {
            const cwd = optionalString(payload.cwd) ?? this.options.defaultCwd;
            const response = await this.options.client.listSkills({ cwds: [cwd], forceReload: false });
            const skill = response.data
                .flatMap((entry) => entry.skills)
                .find((entry) => entry.enabled && entry.name === skillName && entry.path.length > 0);
            if (!skill) throw new Error('Requested Codex skill is unavailable');
            input.push({ type: 'skill', name: skill.name, path: skill.path });
        }
        return input;
    }
}

function findClientUserMessage(thread: Thread, commandId: string): string | null {
    for (const turn of thread.turns ?? []) {
        for (const item of turn.items ?? []) {
            if (item.type !== 'userMessage') continue;
            const clientId = (item as unknown as Record<string, unknown>).clientId;
            if (clientId === commandId) return turn.id;
        }
    }
    return null;
}

function reviewTarget(value: unknown): ReviewStartParams['target'] {
    const target = asRecord(value);
    switch (target.type) {
        case 'uncommittedChanges': return { type: 'uncommittedChanges' };
        case 'baseBranch': return { type: 'baseBranch', branch: requiredString(target.branch, 'baseBranch review requires branch') };
        case 'commit': return {
            type: 'commit',
            sha: requiredString(target.sha, 'commit review requires sha'),
            title: optionalString(target.title),
        };
        case 'custom': return {
            type: 'custom',
            instructions: requiredString(target.instructions, 'custom review requires instructions'),
        };
        default: throw new Error('review.start requires a valid target');
    }
}

function approvalPolicy(value: unknown): ApprovalPolicy | undefined {
    if (value === undefined || value === null) return undefined;
    if (value === 'untrusted' || value === 'on-request' || value === 'never') return value;
    throw new Error('Invalid Codex approval policy');
}

function sandboxMode(value: unknown): SandboxMode | undefined {
    if (value === undefined || value === null) return undefined;
    if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') return value;
    throw new Error('Invalid Codex sandbox mode');
}

function reviewDelivery(value: unknown): NonNullable<ReviewStartParams['delivery']> {
    if (value === undefined || value === null || value === 'inline') return 'inline';
    if (value === 'detached') return 'detached';
    throw new Error('Invalid Codex review delivery');
}

function goalStatus(
    value: unknown,
): Parameters<CodexAppServerClient['setGoal']>[0]['status'] {
    if (value === undefined || value === null) return value;
    if (
        value === 'active'
        || value === 'paused'
        || value === 'blocked'
        || value === 'usageLimited'
        || value === 'budgetLimited'
        || value === 'complete'
    ) {
        return value;
    }
    throw new Error('Invalid Codex goal status');
}

function commandThreadId(command: CodexCommandEntityV4, payload: Record<string, unknown>): string {
    return command.threadId
        ?? requiredString(payload.threadId, `${command.command} requires threadId`);
}

function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
}

function commandPayload(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Codex command payload must be an object');
    }
    return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function requiredString(value: unknown, message: string): string {
    const normalized = optionalString(value);
    if (!normalized) throw new Error(message);
    return normalized;
}

function positiveInt(value: unknown, message: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error(message);
    return value;
}

function nullableNonnegativeInt(value: unknown): number | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    throw new Error('Codex goal tokenBudget must be a nonnegative integer or null');
}

function stringArray(value: unknown): string[] | null {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value;
    throw new Error('Codex command field must be an array of strings');
}

function attachmentReferences(value: unknown): CodexV4AttachmentReference[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error('Codex v4 attachments must be an array');
    return value.map((entry) => {
        const attachment = asRecord(entry);
        return {
            ref: requiredString(attachment.ref, 'Codex v4 attachment ref is missing'),
            name: requiredString(attachment.name, 'Codex v4 attachment name is missing'),
            mimeType: requiredString(attachment.mimeType, 'Codex v4 attachment MIME type is missing'),
        };
    });
}

function assertNoUnsupportedInput(payload: Record<string, unknown>, command: string): void {
    if (typeof payload.unsupportedAttachments === 'number' && payload.unsupportedAttachments > 0) {
        throw new Error(`${command} does not accept attachments`);
    }
    if (optionalString(payload.unsupportedArguments)) {
        throw new Error(`${command} does not accept arguments`);
    }
}
