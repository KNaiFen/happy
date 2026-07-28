import type {
    CodexRequestEntityV4,
    CodexThreadEntityV4,
    CodexTurnEntityV4,
} from '@slopus/happy-wire';
import { describe, expect, it } from 'vitest';
import {
    codexV4RequestResponse,
    commandForCodexV4Input,
    createCodexV4Command,
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

    it('starts while idle and steers only the currently identified active turn', () => {
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
