import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    CodexLegacyOutput,
    shouldSuppressCodexLegacyOutput,
} from './codexLegacyOutput';
import { mapCodexMcpMessageToSessionEnvelopes } from './utils/sessionProtocolMapper';

describe('CodexLegacyOutput', () => {
    it('suppresses v3 output for the entire v4 lifecycle, including online migration', () => {
        expect(shouldSuppressCodexLegacyOutput({
            syncV4Enabled: true,
        })).toBe(true);
        expect(shouldSuppressCodexLegacyOutput({
            syncV4Enabled: false,
        })).toBe(false);
    });

    it('blocks v3 writes as soon as v4 is enabled without suppressing presence or push', () => {
        let syncV4Enabled = false;
        const session = {
            sendSessionEvent: vi.fn(),
            sendSessionProtocolMessage: vi.fn(),
        };
        const keepAlive = vi.fn();
        const push = vi.fn();
        const output = new CodexLegacyOutput(
            () => session as never,
            () => shouldSuppressCodexLegacyOutput({ syncV4Enabled }),
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
        syncV4Enabled = true;
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
        let syncV4Enabled = false;
        const session = {
            sendSessionEvent: vi.fn(),
            sendSessionProtocolMessage: vi.fn(),
        };
        const output = new CodexLegacyOutput(
            () => session as never,
            () => shouldSuppressCodexLegacyOutput({ syncV4Enabled }),
        );
        const project = vi.fn(() => mapCodexMcpMessageToSessionEnvelopes(
            { type: 'agent_message', message: 'provider payload' },
            { currentTurnId: 'turn-1' },
        ));

        const beforeV4Enabled = output.projectEnvelopes(project);
        syncV4Enabled = true;
        const afterV4Enabled = output.projectEnvelopes(project);

        expect(beforeV4Enabled?.envelopes).toHaveLength(1);
        expect(afterV4Enabled).toBeNull();
        expect(project).toHaveBeenCalledOnce();
        expect(session.sendSessionProtocolMessage).toHaveBeenCalledOnce();
    });
});
