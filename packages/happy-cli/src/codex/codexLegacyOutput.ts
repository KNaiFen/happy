import type { ApiSessionClientContract } from '@/api/apiSession';
import type { SessionEnvelope } from '@slopus/happy-wire';

type LegacySessionOutput = Pick<
    ApiSessionClientContract,
    'sendSessionEvent' | 'sendSessionProtocolMessage'
>;

export class CodexLegacyOutput {
    constructor(
        private readonly getSession: () => LegacySessionOutput,
        private readonly shouldSuppressOutput: () => boolean,
    ) {}

    sendSessionEvent(
        event: Parameters<ApiSessionClientContract['sendSessionEvent']>[0],
    ): void {
        if (this.shouldSuppressOutput()) return;
        this.getSession().sendSessionEvent(event);
    }

    sendSessionProtocolMessage(
        envelope: Parameters<ApiSessionClientContract['sendSessionProtocolMessage']>[0],
    ): void {
        if (this.shouldSuppressOutput()) return;
        this.getSession().sendSessionProtocolMessage(envelope);
    }

    projectEnvelopes<T extends { envelopes: readonly SessionEnvelope[] }>(
        project: () => T,
    ): T | null {
        if (this.shouldSuppressOutput()) return null;
        const projected = project();
        for (const envelope of projected.envelopes) {
            this.sendSessionProtocolMessage(envelope);
        }
        return projected;
    }
}

export function shouldSuppressCodexLegacyOutput(input: {
    canonicalV4Active: boolean;
    syncV4Enabled: boolean;
    sessionOffline: boolean;
}): boolean {
    return input.canonicalV4Active || (input.syncV4Enabled && input.sessionOffline);
}
