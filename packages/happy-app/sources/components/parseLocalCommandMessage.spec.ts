import { describe, it, expect } from 'vitest';
import { parseLocalCommandMessage } from './parseLocalCommandMessage';

describe('parseLocalCommandMessage', () => {
    it('collapses a no-arg command to a chip', () => {
        const text = '/compact';
        expect(parseLocalCommandMessage(text)).toEqual({
            kind: 'command-run',
            commandName: 'compact',
            args: undefined,
        });
    });

    it('collapses a raw /goal command to a goal display', () => {
        expect(parseLocalCommandMessage('  /goal проанализируй проект  ')).toEqual({
            kind: 'goal-run',
            goal: 'проанализируй проект',
        });
    });

    it('collapses a raw skill slash command to a command display with args', () => {
        expect(parseLocalCommandMessage('  /superpowers:brainstorming привет давай спланируем что-нибудь  ')).toEqual({
            kind: 'command-run',
            commandName: 'superpowers:brainstorming',
            args: 'привет давай спланируем что-нибудь',
        });
    });

    it('collapses a trailing raw skill slash command to a command display with preceding args', () => {
        expect(parseLocalCommandMessage('  привет давай /maintain  ')).toEqual({
            kind: 'command-run',
            commandName: 'maintain',
            args: 'привет давай',
        });
    });

    it('collapses a middle raw skill slash command and preserves surrounding args', () => {
        expect(parseLocalCommandMessage('  привет /maintain давай  ')).toEqual({
            kind: 'command-run',
            commandName: 'maintain',
            args: 'привет давай',
        });
    });

    it('does not interpret removed provider wrapper markup', () => {
        const text = '<command-message>x</command-message><command-name>/x</command-name>';
        expect(parseLocalCommandMessage(text)).toEqual({ kind: 'text', text });
    });

    it('passes ordinary user text through untouched', () => {
        const text = 'just a normal message';
        expect(parseLocalCommandMessage(text)).toEqual({ kind: 'text', text });
    });
});
