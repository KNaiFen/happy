import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VOICE_CONFIG } from './voiceConfig';
import { voiceLog } from './voiceLog';

const VOICE_RUNTIME_MODULES = [
    'RealtimeSession.ts',
    'RealtimeVoiceSession.tsx',
    'RealtimeVoiceSession.web.tsx',
    'realtimeClientTools.ts',
    'hooks/voiceHooks.ts',
] as const;

const VOICE_UI_MODULES = [
    path.join(__dirname, '..', 'utils', 'microphonePermissions.ts'),
    path.join(__dirname, '..', 'components', 'VoiceAssistantStatusBar.tsx'),
] as const;

describe('voiceLog', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('emits only allowlisted events and fields', () => {
        const secret = 'voice-token-context-session-provider-secret';
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        voiceLog('session.start.failed', {
            outcome: 'failed',
            source: secret,
            token: secret,
            error: new Error(secret),
        } as never, 'error');
        voiceLog(secret as never, { hasPayload: true, payload: secret } as never, 'error');

        const renderedLogs = JSON.stringify(errorSpy.mock.calls);
        expect(renderedLogs).not.toContain(secret);
        expect(renderedLogs).toContain('session.start.failed');
        expect(renderedLogs).toContain('event.rejected');
        expect(renderedLogs).toContain('hasPayload');
    });

    it('keeps SDK debug logging disabled and routes runtime logs through the sanitizer', () => {
        expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(false);

        for (const relativePath of VOICE_RUNTIME_MODULES) {
            const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
            expect(source, relativePath).not.toMatch(/\bconsole\s*(?:\.|\[)/);
        }

        for (const filePath of VOICE_UI_MODULES) {
            const source = fs.readFileSync(filePath, 'utf8');
            expect(source, filePath).not.toMatch(/\bconsole\s*(?:\.|\[)/);
        }

        const sessionView = fs.readFileSync(path.join(__dirname, '..', '-session', 'SessionView.tsx'), 'utf8');
        const microphoneHandler = sessionView.slice(
            sessionView.indexOf('const handleMicrophonePress'),
            sessionView.indexOf('// Memoize mic button state'),
        );
        expect(microphoneHandler).not.toMatch(/\bconsole\s*(?:\.|\[)/);
        expect(microphoneHandler).not.toContain('session_id');
        expect(microphoneHandler).not.toContain('conversation_id');
        expect(microphoneHandler).not.toContain('elevenlabs_');
        expect(microphoneHandler).not.toContain('error.message');
    });
});
