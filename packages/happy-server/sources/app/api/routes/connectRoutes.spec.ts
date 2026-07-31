import { describe, expect, it } from 'vitest';
import { supportedInferenceVendorSchema } from './connectRoutes';

describe('supported inference vendors', () => {
    it('accepts retained vendors and rejects removed Anthropic access', () => {
        expect(supportedInferenceVendorSchema.parse('openai')).toBe('openai');
        expect(supportedInferenceVendorSchema.parse('gemini')).toBe('gemini');
        expect(supportedInferenceVendorSchema.safeParse('anthropic').success).toBe(false);
    });
});
