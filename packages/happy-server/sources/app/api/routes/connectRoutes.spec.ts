import { describe, expect, it } from 'vitest';
import { supportedInferenceVendorSchema } from './connectRoutes';

describe('supported inference vendors', () => {
    it('accepts only OpenAI access', () => {
        expect(supportedInferenceVendorSchema.parse('openai')).toBe('openai');
        expect(supportedInferenceVendorSchema.safeParse('gemini').success).toBe(false);
        expect(supportedInferenceVendorSchema.safeParse('anthropic').success).toBe(false);
    });
});
