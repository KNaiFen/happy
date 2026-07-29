import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    CodexLegacyOutput,
    shouldSuppressCodexLegacyOutput,
} from './codexLegacyOutput';
import { mapCodexMcpMessageToSessionEnvelopes } from './utils/sessionProtocolMapper';

describe('CodexLegacyOutput', () => {
    it('suppresses v3 output while a confirmed v4 session is offline', () => {
        expect(shouldSuppressCodexLegacyOutput({
            canonicalV4Active: false,
            syncV4Enabled: true,
            sessionOffline: true,
        })).toBe(true);
        expect(shouldSuppressCodexLegacyOutput({
            canonicalV4Active: false,
            syncV4Enabled: false,
            sessionOffline: true,
        })).toBe(false);
        expect(shouldSuppressCodexLegacyOutput({
            canonicalV4Active: true,
            syncV4Enabled: true,
            sessionOffline: false,
        })).toBe(true);
    });

    it('blocks v3 writes after canonical activation without suppressing presence or push', () => {
        let canonicalV4Active = false;
        const session = {
            sendSessionEvent: vi.fn(),
            sendSessionProtocolMessage: vi.fn(),
        };
        const keepAlive = vi.fn();
        const push = vi.fn();
        const output = new CodexLegacyOutput(
            () => session as never,
            () => canonicalV4Active,
        );
        const emitProviderCycle = () => {
            output.sendSessionEvent({ type: 'ready' });
            output.sendSessionProtocolMessage({
                role: 'agent',
                content: { type: 'text', text: 'provider payload' },
            } as never);
            keepAlive();
            push();
        };

        emitProviderCycle();
        canonicalV4Active = true;
        emitProviderCycle();

        expect(session.sendSessionEvent).toHaveBeenCalledOnce();
        expect(session.sendSessionProtocolMessage).toHaveBeenCalledOnce();
        expect(keepAlive).toHaveBeenCalledTimes(2);
        expect(push).toHaveBeenCalledTimes(2);
    });

    it('has no direct v3 session writes left in the runCodex event chain', () => {
        const source = readFileSync(
            new URL('./runCodex.ts', import.meta.url),
            'utf8',
        );

        expect(source).not.toMatch(/\bsession\.sendSessionEvent\s*\(/);
        expect(source).not.toMatch(/\bsession\.sendSessionProtocolMessage\s*\(/);
    });

    it('stops the provider mapper and v3 writes in the event boundary used by runCodex', () => {
        let canonicalV4Active = false;
        const session = {
            sendSessionEvent: vi.fn(),
            sendSessionProtocolMessage: vi.fn(),
        };
        const output = new CodexLegacyOutput(
            () => session as never,
            () => canonicalV4Active,
        );
        const project = vi.fn(() => mapCodexMcpMessageToSessionEnvelopes(
            { type: 'agent_message', message: 'provider payload' },
            { currentTurnId: 'turn-1' },
        ));

        const beforeActivation = output.projectEnvelopes(project);
        canonicalV4Active = true;
        const afterActivation = output.projectEnvelopes(project);

        expect(beforeActivation?.envelopes).toHaveLength(1);
        expect(afterActivation).toBeNull();
        expect(project).toHaveBeenCalledOnce();
        expect(session.sendSessionProtocolMessage).toHaveBeenCalledOnce();
    });
});
