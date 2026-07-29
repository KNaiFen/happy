import type { ApiSessionClient } from '@/api/apiSession';
import type { SessionEnvelope } from '@slopus/happy-wire';

type LegacySessionOutput = Pick<
    ApiSessionClient,
    'sendSessionEvent' | 'sendSessionProtocolMessage'
>;

export class CodexLegacyOutput {
    constructor(
        private readonly getSession: () => LegacySessionOutput,
        private readonly isCanonicalV4Active: () => boolean,
    ) {}

    sendSessionEvent(
        event: Parameters<ApiSessionClient['sendSessionEvent']>[0],
    ): void {
        if (this.isCanonicalV4Active()) return;
        this.getSession().sendSessionEvent(event);
    }

    sendSessionProtocolMessage(
        envelope: Parameters<ApiSessionClient['sendSessionProtocolMessage']>[0],
    ): void {
        if (this.isCanonicalV4Active()) return;
        this.getSession().sendSessionProtocolMessage(envelope);
    }

    projectEnvelopes<T extends { envelopes: readonly SessionEnvelope[] }>(
        project: () => T,
    ): T | null {
        if (this.isCanonicalV4Active()) return null;
        const projected = project();
        for (const envelope of projected.envelopes) {
            this.sendSessionProtocolMessage(envelope);
        }
        return projected;
    }
}
