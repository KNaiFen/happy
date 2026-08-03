import { createId } from '@paralleldrive/cuid2';
import { describe, expect, it } from 'vitest';
import { normalizeRawMessage, RawRecordSchema } from './typesRaw';

function parseRecord(value: unknown) {
    const result = RawRecordSchema.safeParse(value);
    expect(result.success).toBe(true);
    if (!result.success) {
        throw result.error;
    }
    return result.data;
}

describe('RawRecordSchema', () => {
    it('keeps removed provider output opaque and excludes it from projection', () => {
        const record = parseRecord({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    nested: { value: 'retained but never interpreted' },
                },
            },
        });

        expect(record.content).toEqual({
            type: 'output',
            data: {
                type: 'assistant',
                nested: { value: 'retained but never interpreted' },
            },
        });
        expect(normalizeRawMessage('opaque', null, 1, record)).toBeNull();
    });

    it('normalizes a direct Codex message', () => {
        const record = parseRecord({
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', message: 'done' },
            },
        });

        expect(normalizeRawMessage('codex-message', null, 2, record)).toMatchObject({
            role: 'agent',
            content: [{ type: 'text', text: 'done' }],
        });
    });

    it('rejects removed ACP envelopes', () => {
        expect(RawRecordSchema.safeParse({
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'gemini',
                data: { type: 'message', message: 'hello from ACP' },
            },
        }).success).toBe(false);
    });

    it('accepts the provider-neutral session envelope wrapper', () => {
        const record = parseRecord({
            role: 'session',
            content: {
                id: createId(),
                time: 4,
                role: 'agent',
                turn: 'turn-1',
                ev: { t: 'text', text: 'session text' },
            },
        });

        expect(normalizeRawMessage('ignored-for-envelope', null, 0, record)).toMatchObject({
            role: 'agent',
            content: [{ type: 'text', text: 'session text' }],
        });
    });

    it('rejects service events attributed to a user', () => {
        expect(RawRecordSchema.safeParse({
            role: 'session',
            content: {
                id: createId(),
                time: 5,
                role: 'user',
                ev: { t: 'service', text: 'invalid ownership' },
            },
        }).success).toBe(false);
    });
});
