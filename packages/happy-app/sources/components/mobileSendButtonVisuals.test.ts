import { describe, expect, it } from 'vitest';
import { resolveMobileSendButtonVisuals } from './mobileSendButtonVisuals';

describe('resolveMobileSendButtonVisuals', () => {
    it('uses a transparent fill with a black border and icon when active', () => {
        expect(resolveMobileSendButtonVisuals(true)).toEqual({
            buttonStyle: {
                backgroundColor: 'transparent',
                borderColor: '#000000',
            },
            iconColor: '#000000',
        });
    });

    it('uses a transparent fill with a light gray border and icon when inactive', () => {
        expect(resolveMobileSendButtonVisuals(false)).toEqual({
            buttonStyle: {
                backgroundColor: 'transparent',
                borderColor: '#C7C7CC',
            },
            iconColor: '#C7C7CC',
        });
    });
});
