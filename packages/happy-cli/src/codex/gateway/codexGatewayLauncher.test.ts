import { describe, expect, it } from 'vitest';
import { buildCodexRemoteArgs } from './codexGatewayLauncher';

describe('Codex Gateway launcher', () => {
    it('injects the authenticated loopback endpoint before untouched native arguments', () => {
        expect(buildCodexRemoteArgs('ws://127.0.0.1:45123/', [
            'resume',
            '--all',
            '--model',
            'gpt-test',
        ])).toEqual([
            '--remote',
            'ws://127.0.0.1:45123/',
            '--remote-auth-token-env',
            'HAPPY_CODEX_GATEWAY_REMOTE_TOKEN',
            'resume',
            '--all',
            '--model',
            'gpt-test',
        ]);
    });

    it('refuses Unix and non-loopback TUI remotes that cannot use bearer authentication', () => {
        expect(() => buildCodexRemoteArgs('unix:///tmp/happy-codex/tui.sock', []))
            .toThrow('authenticated loopback WebSocket');
        expect(() => buildCodexRemoteArgs('ws://192.0.2.1:45123/', []))
            .toThrow('authenticated loopback WebSocket');
    });

    it('rejects path, query, and embedded credentials on the attachment endpoint', () => {
        expect(() => buildCodexRemoteArgs('ws://127.0.0.1:45123/rpc', []))
            .toThrow('authenticated loopback WebSocket');
        expect(() => buildCodexRemoteArgs('ws://127.0.0.1:45123/?token=value', []))
            .toThrow('authenticated loopback WebSocket');
        expect(() => buildCodexRemoteArgs('ws://user@127.0.0.1:45123/', []))
            .toThrow('authenticated loopback WebSocket');
    });

    it('preserves native resume arguments after the controlled remote options', () => {
        expect(buildCodexRemoteArgs('ws://127.0.0.1:45123/', ['resume', 'thread-a'])).toEqual([
            '--remote',
            'ws://127.0.0.1:45123/',
            '--remote-auth-token-env',
            'HAPPY_CODEX_GATEWAY_REMOTE_TOKEN',
            'resume',
            'thread-a',
        ]);
    });
});
