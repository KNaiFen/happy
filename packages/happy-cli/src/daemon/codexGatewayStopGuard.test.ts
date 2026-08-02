import { describe, expect, it } from 'vitest';
import {
    findCodexGatewayStopBinding,
    matchesCodexGatewayStopExpectation,
} from './codexGatewayStopGuard';

const descriptor = {
    gatewayId: 'gateway-1',
    current: {
        threadId: 'thread-current',
        sessionId: 'session-current',
        generation: 4,
        role: 'current',
        title: null,
        changedAt: 10,
    },
    draining: [{
        threadId: 'thread-old',
        sessionId: 'session-old',
        generation: 3,
        role: 'draining',
        title: null,
        changedAt: 9,
    }],
} as any;

describe('Codex Gateway stop guard', () => {
    it('finds current and draining bindings without accepting another session', () => {
        expect(findCodexGatewayStopBinding(descriptor, 'session-current')?.generation).toBe(4);
        expect(findCodexGatewayStopBinding(descriptor, 'session-old')?.generation).toBe(3);
        expect(findCodexGatewayStopBinding(descriptor, 'session-other')).toBeNull();
    });

    it('rejects a stale or foreign App stop expectation', () => {
        const current = findCodexGatewayStopBinding(descriptor, 'session-current')!;
        expect(matchesCodexGatewayStopExpectation(descriptor, current, {
            gatewayId: 'gateway-1',
            generation: 4,
        })).toBe(true);
        expect(matchesCodexGatewayStopExpectation(descriptor, current, {
            gatewayId: 'gateway-1',
            generation: 3,
        })).toBe(false);
        expect(matchesCodexGatewayStopExpectation(descriptor, current, {
            gatewayId: 'gateway-other',
            generation: 4,
        })).toBe(false);
        const draining = findCodexGatewayStopBinding(descriptor, 'session-old')!;
        expect(matchesCodexGatewayStopExpectation(descriptor, draining, {
            gatewayId: 'gateway-1',
            generation: 3,
        })).toBe(false);
    });

    it('preserves trusted local stop commands that do not carry an expectation', () => {
        const current = findCodexGatewayStopBinding(descriptor, 'session-current')!;
        expect(matchesCodexGatewayStopExpectation(descriptor, current, undefined)).toBe(true);
    });
});
