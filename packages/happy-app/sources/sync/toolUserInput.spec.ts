import { describe, expect, it } from 'vitest';
import { parseToolUserInputAnswers } from './toolUserInput';

describe('Codex tool user input response', () => {
    it('restores completed answers by official question id', () => {
        expect(parseToolUserInputAnswers({
            answers: {
                mode: { answers: ['safe', 'fast'] },
                region: { answers: ['eu'] },
            },
        })).toEqual({ mode: ['safe', 'fast'], region: ['eu'] });
    });

    it('ignores malformed answer entries', () => {
        expect(parseToolUserInputAnswers({
            answers: {
                valid: { answers: ['yes'] },
                invalid: { answers: 'no' },
            },
        })).toEqual({ valid: ['yes'] });
    });
});
