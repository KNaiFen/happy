import { describe, expect, it } from 'vitest';
import { machineRegistrationRetryDelay } from './machineRegistration';

describe('machineRegistrationRetryDelay', () => {
    it('backs off quickly and caps long relay outages at fifteen seconds', () => {
        expect([0, 1, 2, 3, 4, 20].map(machineRegistrationRetryDelay)).toEqual([
            1_000,
            2_000,
            4_000,
            8_000,
            15_000,
            15_000,
        ]);
    });

    it('defends against invalid negative and fractional attempt counters', () => {
        expect(machineRegistrationRetryDelay(-1)).toBe(1_000);
        expect(machineRegistrationRetryDelay(2.9)).toBe(4_000);
    });
});
