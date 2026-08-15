import { describe, expect, it } from 'vitest';
import { orderSettingsMenuGroups, shouldCloseSettingsMenu } from './settingsMenuPolicy';

describe('settings menu policy', () => {
    const groups = [
        { key: 'model', keepOpenOnSelect: true },
        { key: 'effort' },
    ];

    it('puts the pressed group first without mutating the shared groups', () => {
        expect(orderSettingsMenuGroups(groups, 'effort').map((group) => group.key)).toEqual(['effort', 'model']);
        expect(groups.map((group) => group.key)).toEqual(['model', 'effort']);
    });

    it('keeps model selection open but closes permission and effort menus', () => {
        expect(shouldCloseSettingsMenu(groups[0])).toBe(false);
        expect(shouldCloseSettingsMenu(groups[1])).toBe(true);
        expect(shouldCloseSettingsMenu({ key: 'permission' })).toBe(true);
    });
});
