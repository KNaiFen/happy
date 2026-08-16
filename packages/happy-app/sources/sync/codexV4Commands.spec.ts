import type {
    CodexRequestEntityV4,
    CodexThreadEntityV4,
    CodexTurnEntityV4,
} from '@slopus/happy-wire';
import { describe, expect, it } from 'vitest';
import {
    bindCodexV4CommandDraftToCurrentGateway,
    codexV4RequestResponse,
    commandForCodexV4Input,
    createCodexV4Command,
    findActiveCodexV4Turn,
    parseCodexV4Input,
} from './codexV4Commands';
import { createCodexV4Projection } from './codexV4Projection';

function projection(active: boolean) {
    const result = createCodexV4Projection();
    result.thread = { threadId: 'thread-1' } as CodexThreadEntityV4;
    if (active) {
        const turn = {
            entityType: 'codex.turn',
            providerId: 'turn-1',
            threadId: 'thread-1',
            turnId: 'turn-1',
            status: 'inProgress',
            updatedAt: 20,
        } as CodexTurnEntityV4;
        result.entities['codex.turn'][turn.providerId] = turn;
    }
    return result;
}

function gatewayProjection(active: boolean, generation: number) {
    const result = projection(active);
    result.runtime = {
        gateway: {
            gatewayId: 'gateway-1',
            generation,
            origin: 'terminal',
            role: 'current',
            state: 'running',
        },
    } as unknown as typeof result.runtime;
    return result;
}

function request(
    requestType: CodexRequestEntityV4['requestType'],
    options: CodexRequestEntityV4['options'],
): CodexRequestEntityV4 {
    return {
        schemaVersion: 1,
        entityType: 'codex.request',
        providerId: 'request-1',
        createdAt: 10,
        updatedAt: 10,
        requestId: 'request-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: null,
        requestType,
        status: 'pending',
        title: null,
        prompt: null,
        options,
        response: null,
        resolvedAt: null,
    };
}

describe('Codex v4 App commands', () => {
    it('parses native controls and known skills without downgrading invalid controls to prompts', () => {
        expect(parseCodexV4Input('/compact custom', [])).toMatchObject({
            kind: 'control',
            command: 'thread.compact',
            payload: { unsupportedPrompt: 'custom' },
        });
        expect(parseCodexV4Input('/review compare API', [])).toMatchObject({
            kind: 'control',
            command: 'review.start',
            payload: { target: { type: 'custom', instructions: 'compare API' } },
        });
        expect(parseCodexV4Input('/release dry run', ['/release'])).toEqual({
            kind: 'skill',
            skillName: 'release',
            text: 'dry run',
            displayText: '/release dry run',
        });
        expect(parseCodexV4Input('/unknown value', [])).toMatchObject({ kind: 'prompt' });
    });

    it('uses one command id for the entity, provider id, and client user message id', () => {
        const entity = createCodexV4Command({
            command: 'turn.start',
            threadId: 'thread-1',
            payload: { text: 'hello' },
        }, { commandId: 'command-1', now: 100 });
        expect(entity).toMatchObject({
            providerId: 'command-1',
            commandId: 'command-1',
            clientUserMessageId: 'command-1',
            createdAt: 100,
            updatedAt: 100,
        });
    });

    it('starts while idle, queues by default, and steers only when requested', () => {
        const parsed = parseCodexV4Input('hello', []);
        expect(commandForCodexV4Input({
            parsed,
            projection: projection(false),
            mode: { model: 'gpt-test', effort: 'high', permissionMode: 'acceptEdits' },
        })).toMatchObject({
            command: 'turn.start',
            threadId: 'thread-1',
            payload: { text: 'hello', model: 'gpt-test', effort: 'high', permissionMode: 'acceptEdits' },
        });
        expect(commandForCodexV4Input({
            parsed,
            projection: projection(true),
            mode: {},
        })).toMatchObject({
            command: 'turn.queue',
            threadId: 'thread-1',
            expectedTurnId: 'turn-1',
        });
        expect(commandForCodexV4Input({
            parsed,
            projection: projection(true),
            mode: {},
            followUpMode: 'steer',
        })).toMatchObject({
            command: 'turn.steer',
            threadId: 'thread-1',
            expectedTurnId: 'turn-1',
        });
        expect(commandForCodexV4Input({
            parsed,
            projection: projection(true),
            threadId: 'thread-2',
            mode: {},
        })).toMatchObject({
            command: 'turn.start',
            threadId: 'thread-2',
        });
    });

    it('starts a new turn after rollback interrupts the former active turn', () => {
        const cleared = projection(true);
        const formerActive = Object.values(cleared.entities['codex.turn'])[0];
        cleared.entities['codex.turn'][formerActive.providerId] = {
            ...formerActive,
            status: 'interrupted',
        };
        cleared.runtime = {
            threadId: 'thread-1',
            execution: { type: 'idle' },
        } as unknown as typeof cleared.runtime;

        expect(findActiveCodexV4Turn(cleared)).toBeNull();
        expect(commandForCodexV4Input({
            parsed: parseCodexV4Input('after clear', []),
            projection: cleared,
            mode: {},
        })).toMatchObject({
            command: 'turn.start',
            threadId: 'thread-1',
        });
    });

    it('assigns stable queue metadata when the command is materialized', () => {
        const entity = createCodexV4Command(commandForCodexV4Input({
            parsed: parseCodexV4Input('follow up', []),
            projection: projection(true),
            mode: {},
        }), { commandId: 'queue-command-1', now: 200 });

        expect(entity).toMatchObject({
            command: 'turn.queue',
            queueEntryId: 'queue-command-1',
            queuedAt: 200,
        });
    });

    it('queues during the runtime-active window before the turn entity arrives', () => {
        const activeRuntime = projection(false);
        activeRuntime.runtime = {
            threadId: 'thread-1',
            execution: { type: 'active', activeFlags: [] },
        } as unknown as typeof activeRuntime.runtime;

        expect(commandForCodexV4Input({
            parsed: parseCodexV4Input('arrived early', []),
            projection: activeRuntime,
            mode: {},
            followUpMode: 'steer',
        })).toMatchObject({
            command: 'turn.queue',
            threadId: 'thread-1',
            expectedTurnId: null,
        });
    });

    it('binds new Gateway commands to the projected generation', () => {
        const draft = commandForCodexV4Input({
            parsed: parseCodexV4Input('hello', []),
            projection: gatewayProjection(false, 7),
            mode: {},
        });
        expect(draft.bindingGeneration).toBe(7);
        expect(createCodexV4Command(draft, { commandId: 'command-7', now: 100 }))
            .toMatchObject({ bindingGeneration: 7 });
    });

    it('binds a first command to current Gateway metadata before runtime hydration', () => {
        const draft = commandForCodexV4Input({
            parsed: parseCodexV4Input('first prompt', []),
            projection: createCodexV4Projection(),
            mode: {},
        });
        const binding = {
            gatewayId: 'gateway-1',
            generation: 1,
            origin: 'app',
            role: 'current',
            terminal: 'unattached',
            changedAt: 100,
        } as const;

        expect(bindCodexV4CommandDraftToCurrentGateway(draft, {
            path: '/workspace',
            host: 'host',
            flavor: 'codex',
            codexSyncVersion: 4,
            codexGatewayBinding: binding,
        })).toMatchObject({
            command: 'turn.start',
            bindingGeneration: 1,
        });
        expect(bindCodexV4CommandDraftToCurrentGateway({
            ...draft,
            bindingGeneration: 0,
        }, {
            path: '/workspace',
            host: 'host',
            flavor: 'codex',
            codexSyncVersion: 4,
            codexGatewayBinding: binding,
        })).toMatchObject({ bindingGeneration: 0 });
    });

    it('creates the first turn command before the v4 projection is activated', () => {
        const empty = createCodexV4Projection();

        expect(commandForCodexV4Input({
            parsed: parseCodexV4Input('first prompt', []),
            projection: empty,
            mode: { permissionMode: 'default' },
        })).toMatchObject({
            command: 'turn.start',
            threadId: null,
            payload: {
                text: 'first prompt',
                displayText: 'first prompt',
                permissionMode: 'default',
            },
        });
        expect(empty.activated).toBe(false);
    });

    it('maps approval, tool input, and MCP elicitation responses to official shapes', () => {
        expect(codexV4RequestResponse({
            request: request('commandApproval', {}),
            approved: true,
            decision: 'approved_for_session',
        })).toEqual({ decision: 'acceptForSession' });
        expect(codexV4RequestResponse({
            request: request('permissions', { permissions: { network: { enabled: true } } }),
            approved: false,
            decision: 'denied',
        })).toEqual({ permissions: {}, scope: 'turn' });
        expect(codexV4RequestResponse({
            request: request('toolUserInput', {
                requestMethod: 'item/tool/requestUserInput',
                questions: [{ id: 'q1', question: 'Mode?' }],
            }),
            approved: true,
            updatedInput: { answers: { 'Mode?': 'Fast' } },
        })).toEqual({ answers: { q1: { answers: ['Fast'] } } });
        expect(codexV4RequestResponse({
            request: request('toolUserInput', {
                requestMethod: 'mcpServer/elicitation/request',
                _meta: { source: 'mcp' },
            }),
            approved: true,
            updatedInput: { mode: 'fast' },
        })).toEqual({ action: 'accept', content: { mode: 'fast' }, _meta: { source: 'mcp' } });
    });
});
