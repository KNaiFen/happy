export type SettingsMenuGroupLike = {
    key: string;
    keepOpenOnSelect?: boolean;
};

/** Put the group that owns the trigger first without mutating caller state. */
export function orderSettingsMenuGroups<T extends SettingsMenuGroupLike>(
    groups: readonly T[],
    preferredGroupKey?: string,
): T[] {
    if (!preferredGroupKey) return [...groups];
    const preferredIndex = groups.findIndex((group) => group.key === preferredGroupKey);
    if (preferredIndex <= 0) return [...groups];
    return [groups[preferredIndex], ...groups.slice(0, preferredIndex), ...groups.slice(preferredIndex + 1)];
}

export function shouldCloseSettingsMenu(group: SettingsMenuGroupLike): boolean {
    return group.keepOpenOnSelect !== true;
}
