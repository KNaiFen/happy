/** Bounded labels for stable-v2 methods used by traces and ordinary logs. */

import { createHmac, randomBytes } from 'node:crypto';
import stableMethods from './protocol/generated/STABLE_METHODS.json';

const UNKNOWN_METHOD_PREFIX = 'unknown:';
const METHOD_HASH_HEX_LENGTH = 24;
const processLogHashSecret = randomBytes(32);
const stableMethodSet = new Set<string>(stableMethods);

export function isCodexStableV2Method(method: string): boolean {
    return stableMethodSet.has(method);
}

export function redactCodexProtocolMethod(
    method: string,
    hash: (value: string) => string = processMethodHash,
): string {
    if (isCodexStableV2Method(method)) return method;
    return `${UNKNOWN_METHOD_PREFIX}${hash(method).slice(0, METHOD_HASH_HEX_LENGTH)}`;
}

export function isRedactedCodexProtocolMethod(method: string): boolean {
    return isCodexStableV2Method(method)
        || /^unknown:[0-9a-f]{24}$/.test(method);
}

function processMethodHash(value: string): string {
    return createHmac('sha256', processLogHashSecret)
        .update('codex-method')
        .update('\0')
        .update(value)
        .digest('hex');
}
