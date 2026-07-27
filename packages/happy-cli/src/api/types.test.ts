import { describe, expect, it } from 'vitest';
import { UserMessageSchema } from './types';

describe('UserMessageSchema', () => {
    it('preserves forward-compatible Codex effort strings', () => {
        const message = UserMessageSchema.parse({
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: {
                model: 'gpt-5.6-sol',
                effort: 'ultra',
            },
        });

        expect(message.meta).toMatchObject({
            model: 'gpt-5.6-sol',
            effort: 'ultra',
        });
    });

    it('preserves queued follow-up identity and delivery mode', () => {
        const message = UserMessageSchema.parse({
            role: 'user',
            content: { type: 'text', text: 'check the failing test' },
            localKey: 'queued-message-1',
            meta: { followUpMode: 'queue' },
        });

        expect(message.localKey).toBe('queued-message-1');
        expect(message.meta?.followUpMode).toBe('queue');
    });
});
