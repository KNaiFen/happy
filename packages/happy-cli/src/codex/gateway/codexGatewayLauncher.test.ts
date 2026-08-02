import { describe, expect, it } from 'vitest';
import { buildCodexRemoteArgs } from './codexGatewayLauncher';
import type { CodexGatewayDescriptor } from './codexGatewayState';

describe('Codex Gateway launcher', () => {
    it('injects the controlled remote endpoint before untouched native arguments', () => {
        const descriptor = {
            tuiSocketPath: '/tmp/happy-codex/tui.sock',
        } as CodexGatewayDescriptor;
        expect(buildCodexRemoteArgs(descriptor, [
            'resume',
            '--all',
            '--model',
            'gpt-test',
        ])).toEqual([
            '--remote',
            'unix:///tmp/happy-codex/tui.sock',
            '--remote-auth-token-env',
            'HAPPY_CODEX_GATEWAY_REMOTE_TOKEN',
            'resume',
            '--all',
            '--model',
            'gpt-test',
        ]);
    });

    it('refuses to launch without a private TUI endpoint', () => {
        expect(() => buildCodexRemoteArgs({ tuiSocketPath: null, tuiPort: null } as CodexGatewayDescriptor, []))
            .toThrow('TUI endpoint is unavailable');
    });

    it('uses an authenticated loopback remote endpoint on Windows descriptors', () => {
        expect(buildCodexRemoteArgs({
            tuiSocketPath: null,
            tuiPort: 45123,
        } as CodexGatewayDescriptor, ['resume', 'thread-a'])).toEqual([
            '--remote',
            'ws://127.0.0.1:45123',
            '--remote-auth-token-env',
            'HAPPY_CODEX_GATEWAY_REMOTE_TOKEN',
            'resume',
            'thread-a',
        ]);
    });
});
