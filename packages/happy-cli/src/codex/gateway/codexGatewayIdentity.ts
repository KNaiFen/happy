import { createHmac } from 'node:crypto';
import { deriveKey } from '@/utils/deriveKey';

export function deriveCodexGatewayResumeSessionTag(dataKey: Uint8Array): string {
    if (dataKey.length !== 32) {
        throw new Error('Invalid Codex resume session data key');
    }
    const digest = createHmac('sha256', dataKey)
        .update('Happy Codex Resume Session Tag v1', 'utf8')
        .digest('base64url');
    return `codex-gateway-root-v1-${digest}`;
}

export async function deriveCodexGatewayRootSessionIdentity(options: {
    gatewayId: string;
    sessionKeySeed: string;
    threadId: string;
}): Promise<{ tag: string; sessionKey: Uint8Array }> {
    if (!options.gatewayId || options.gatewayId.length > 256) {
        throw new Error('Invalid Codex Gateway ID');
    }
    if (!options.threadId || options.threadId.length > 512) {
        throw new Error('Invalid Codex thread ID');
    }
    const seed = Buffer.from(options.sessionKeySeed, 'base64url');
    if (seed.length !== 32) throw new Error('Invalid Codex Gateway session key seed');
    const scope = `${options.gatewayId}\0${options.threadId}`;
    const digest = createHmac('sha256', seed)
        .update('happy-codex-gateway-root-session-v1\0')
        .update(scope)
        .digest('base64url');
    const sessionKey = await deriveKey(
        seed,
        'Happy Codex Gateway Root Session',
        ['v1', options.gatewayId, options.threadId],
    );
    return { tag: `codex-gateway-root-v1-${digest}`, sessionKey };
}
