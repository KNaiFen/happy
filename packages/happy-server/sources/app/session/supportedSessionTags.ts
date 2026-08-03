export const PRESERVED_SESSION_TAG_PREFIXES = [
    'codex-gateway-root-v1-',
    'codex-child-v4-',
] as const;

export function isSupportedSessionTag(tag: string): boolean {
    return PRESERVED_SESSION_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix));
}
