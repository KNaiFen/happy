/** Maps validated Sync v4 command entities to Codex stable-v2 RPC methods. */

import type { CodexCommandEntityV4 } from '@slopus/happy-wire';
import type {
    ApprovalPolicy,
    InputItem,
    SandboxMode,
    Thread,
} from './codexAppServerTypes';
import type { ReviewStartParams } from './protocol';
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
        const payload = asRecord(command.payload);
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
                const result = await this.options.client.readThread({ threadId, includeTurns: true });
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
                const numTurns = positiveInt(payload.numTurns, 'thread.rollback requires a positive numTurns');
                const result = await this.options.client.rollbackThread({ threadId, numTurns });
                return { threadId: result.thread.id, result: { rolledBackTurns: numTurns } };
            }
            case 'thread.compact': {
                const threadId = commandThreadId(command, payload);
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
                await this.options.client.steerTurnOnThread(
                    threadId,
                    expectedTurnId,
                    requiredString(payload.text, 'turn.steer requires text'),
                    { clientUserMessageId: command.commandId },
                );
                return { threadId, turnId: expectedTurnId };
            }
            case 'turn.interrupt': {
                const threadId = commandThreadId(command, payload);
                const expectedTurnId = command.expectedTurnId ?? requiredString(
                    payload.expectedTurnId,
                    'turn.interrupt requires expectedTurnId',
                );
                await this.options.client.interruptTurnOnThread(threadId, expectedTurnId);
                return { threadId, turnId: expectedTurnId };
            }
            case 'review.start': {
                const threadId = commandThreadId(command, payload);
                const target = reviewTarget(payload.target);
                const delivery = payload.delivery === 'detached' ? 'detached' : 'inline';
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
                const result = await this.options.client.setGoal({
                    threadId,
                    objective: requiredString(payload.objective, 'goal.set requires objective'),
                    status: optionalString(payload.status) as Parameters<CodexAppServerClient['setGoal']>[0]['status'],
                    tokenBudget: nullableNonnegativeInt(payload.tokenBudget),
                });
                return { threadId, result: { goal: result.goal } };
            }
            case 'goal.clear': {
                const threadId = commandThreadId(command, payload);
                const result = await this.options.client.clearGoal({ threadId });
                return { threadId, result };
            }
            case 'skills.list': {
                const result = await this.options.client.listSkills({
                    cwds: stringArray(payload.cwds) ?? [this.options.defaultCwd],
                    forceReload: payload.forceReload === true,
                });
                return { threadId: command.threadId, result: { skills: result.data } };
            }
            case 'mcp.status.list': {
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
            const payload = asRecord(command.payload);
            const threadId = commandThreadId(command, payload);
            const snapshot = await this.options.client.readThread({ threadId, includeTurns: true });
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
        const rawText = requiredString(payload.text, 'turn.start requires text');
        const prompt = this.options.preparePrompt?.(rawText, command) ?? rawText;
        const result = await this.options.client.startTurnOnThread(threadId, prompt, {
            model: optionalString(payload.model) ?? undefined,
            cwd: optionalString(payload.cwd) ?? undefined,
            approvalPolicy: approvalPolicy(payload.approvalPolicy),
            sandbox: sandboxMode(payload.sandbox),
            effort: optionalString(payload.effort) ?? undefined,
            clientUserMessageId: command.commandId,
            extraInputItems: [] as InputItem[],
        });
        return { threadId, turnId: result.turnId };
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
    return value === 'untrusted' || value === 'on-failure' || value === 'on-request' || value === 'never'
        ? value
        : undefined;
}

function sandboxMode(value: unknown): SandboxMode | undefined {
    return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
        ? value
        : undefined;
}

function commandThreadId(command: CodexCommandEntityV4, payload: Record<string, unknown>): string {
    return command.threadId
        ?? requiredString(payload.threadId, `${command.command} requires threadId`);
}

function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
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
    if (value === null) return null;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | null {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null;
}
