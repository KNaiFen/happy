import { describe, expect, it, vi } from 'vitest';
import {
    inspectCodexGatewayProviderProcess,
    inspectCodexGatewayWorkerProcess,
    isExpectedCodexGatewayProviderProcess,
    isExpectedCodexGatewayWorkerProcess,
    isExpectedLegacyHappyCodexAdapterProcess,
} from './codexGatewayProcessIdentity';

describe('Codex Gateway worker process identity', () => {
    it('accepts only the exact Happy entrypoint, worker marker and gateway ID', () => {
        const readCommandLine = vi.fn(() => (
            'node /opt/happy/dist/index.mjs __codex-gateway-worker gateway-a'
        ));
        expect(isExpectedCodexGatewayWorkerProcess({
            pid: 42,
            gatewayId: 'gateway-a',
            entrypoint: '/opt/happy/dist/index.mjs',
            isAlive: () => true,
            readCommandLine,
        })).toBe(true);
        expect(isExpectedCodexGatewayWorkerProcess({
            pid: 42,
            gatewayId: 'gateway-b',
            entrypoint: '/opt/happy/dist/index.mjs',
            isAlive: () => true,
            readCommandLine,
        })).toBe(false);
    });

    it('treats a live but temporarily uninspectable PID conservatively as owned', () => {
        expect(isExpectedCodexGatewayWorkerProcess({
            pid: 42,
            gatewayId: 'gateway-a',
            entrypoint: '/opt/happy/dist/index.mjs',
            isAlive: () => true,
            readCommandLine: () => null,
        })).toBe(true);
        expect(inspectCodexGatewayWorkerProcess({
            pid: 42,
            gatewayId: 'gateway-a',
            entrypoint: '/opt/happy/dist/index.mjs',
            isAlive: () => true,
            readCommandLine: () => null,
        })).toBe('unverified');
    });

    it('rejects a reused PID owned by an unrelated process', () => {
        expect(isExpectedCodexGatewayWorkerProcess({
            pid: 42,
            gatewayId: 'gateway-a',
            entrypoint: '/opt/happy/dist/index.mjs',
            isAlive: () => true,
            readCommandLine: () => 'node /srv/other/index.mjs worker gateway-a',
        })).toBe(false);
    });

    it('recognizes only a Codex app-server bound to the exact Happy endpoint', () => {
        const commandLine = (
            'codex app-server --listen unix:///tmp/happy/provider.sock'
        );
        const common = {
            pid: 44,
            isAlive: () => true,
            readCommandLine: () => commandLine,
        };
        expect(isExpectedCodexGatewayProviderProcess({
            ...common,
            listenEndpoint: 'unix:///tmp/happy/provider.sock',
        })).toBe(true);
        expect(isExpectedCodexGatewayProviderProcess({
            ...common,
            listenEndpoint: 'unix:///tmp/other/provider.sock',
        })).toBe(false);
    });

    it('distinguishes a missing process from a live process with unknown ownership', () => {
        const common = {
            pid: 44,
            listenEndpoint: 'unix:///tmp/happy/provider.sock',
        };
        expect(inspectCodexGatewayProviderProcess({
            ...common,
            isAlive: () => false,
            readCommandLine: () => null,
        })).toBe('absent');
        expect(inspectCodexGatewayProviderProcess({
            ...common,
            isAlive: () => true,
            readCommandLine: () => null,
        })).toBe('unverified');
        expect(inspectCodexGatewayProviderProcess({
            ...common,
            isAlive: () => true,
            readCommandLine: () => 'node /srv/unrelated.mjs',
        })).toBe('unexpected');
    });

    it('recognizes only the daemon-started legacy Codex adapter command', () => {
        const common = {
            pid: 45,
            entrypoint: '/opt/happy/dist/index.mjs',
            isAlive: () => true,
        };
        expect(isExpectedLegacyHappyCodexAdapterProcess({
            ...common,
            readCommandLine: () => (
                'node --no-warnings --no-deprecation /opt/happy/dist/index.mjs codex --happy-starting-mode remote --started-by daemon'
            ),
        })).toBe(true);
        expect(isExpectedLegacyHappyCodexAdapterProcess({
            ...common,
            readCommandLine: () => (
                'node /opt/happy/dist/index.mjs __codex-gateway-worker gateway-a'
            ),
        })).toBe(false);
        expect(isExpectedLegacyHappyCodexAdapterProcess({
            ...common,
            readCommandLine: () => 'codex app-server --listen unix:///tmp/provider.sock',
        })).toBe(false);
        expect(isExpectedLegacyHappyCodexAdapterProcess({
            ...common,
            readCommandLine: () => (
                'python --no-warnings --no-deprecation /opt/happy/dist/index.mjs codex --happy-starting-mode remote --started-by daemon'
            ),
        })).toBe(false);
    });
});
