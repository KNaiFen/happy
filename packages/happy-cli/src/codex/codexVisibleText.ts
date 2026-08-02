const LEGACY_HAPPY_SYSTEM_BLOCK_OPEN = '<happy-system>';
const LEGACY_HAPPY_SYSTEM_BLOCK_CLOSE = '</happy-system>';

/** Removes scaffolding written by pre-Gateway Codex adapters from provider history. */
export function stripLegacyHappySystemBlocks(text: string): string {
    const open = escapeRegExp(LEGACY_HAPPY_SYSTEM_BLOCK_OPEN);
    const close = escapeRegExp(LEGACY_HAPPY_SYSTEM_BLOCK_CLOSE);
    return text.replace(new RegExp(`\\s*${open}[\\s\\S]*?${close}\\s*`, 'g'), '\n\n').trim();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
