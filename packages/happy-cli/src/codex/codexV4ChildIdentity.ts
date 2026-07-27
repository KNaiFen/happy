/** Deterministic opaque identity and independent key for a Codex child session. */

import { createHmac } from 'node:crypto';
import { deriveKey } from '@/utils/deriveKey';

export async function deriveCodexV4ChildSessionIdentity(options: {
    parentSessionId: string;
    parentSessionKey: Uint8Array;
    childThreadId: string;
}): Promise<{ tag: string; sessionKey: Uint8Array }> {
    const scope = `${options.parentSessionId}\0${options.childThreadId}`;
    const digest = createHmac('sha256', options.parentSessionKey)
        .update('happy-codex-child-session-v4\0')
        .update(scope)
        .digest('base64url');
    const sessionKey = await deriveKey(
        options.parentSessionKey,
        'Happy Codex Child Session',
        ['v4', options.parentSessionId, options.childThreadId],
    );
    return { tag: `codex-child-v4-${digest}`, sessionKey };
}
