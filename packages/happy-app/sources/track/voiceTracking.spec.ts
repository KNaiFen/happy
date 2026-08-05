import { afterEach, describe, expect, it, vi } from 'vitest';

const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));

vi.mock('./tracking', () => ({
    tracking: { capture: captureMock },
}));
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('expo-updates', () => ({ default: {} }));

import {
    trackVoiceSessionError,
    trackVoiceSessionStarted,
    trackVoiceSessionStopped,
} from './index';

describe('voice analytics', () => {
    afterEach(() => {
        captureMock.mockReset();
    });

    it('emits only boolean and fixed-band properties even when called with hostile values', () => {
        const secret = 'voice-session-conversation-token-provider-error';

        trackVoiceSessionStarted(secret as never, secret as never, { secret } as never);
        trackVoiceSessionError();
        trackVoiceSessionStopped(secret as never);

        const payload = JSON.stringify(captureMock.mock.calls);
        expect(payload).not.toContain(secret);
        expect(captureMock.mock.calls).toEqual([
            ['voice_session_started', {
                has_pro: false,
                onboarding_prompt_band: 'none',
                voice_message_band: 'none',
            }],
            ['voice_session_error'],
            ['voice_session_stopped', { duration_band: 'under-1m' }],
        ]);
    });
});
