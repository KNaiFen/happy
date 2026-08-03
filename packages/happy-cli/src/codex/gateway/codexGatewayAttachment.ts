import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export type CodexGatewayTerminalState =
    | 'attached'
    | 'pendingDetach'
    | 'detached'
    | 'headless';

export interface CodexGatewayAttachmentRegistration {
    attachmentId: string;
    connectionToken: string;
    normalExitNonce: string;
}

export function createCodexGatewayAttachmentCredentials(): CodexGatewayAttachmentRegistration {
    return {
        attachmentId: randomUUID(),
        connectionToken: randomBytes(32).toString('base64url'),
        normalExitNonce: randomBytes(32).toString('base64url'),
    };
}

export type CodexGatewayNormalExitResult =
    | { accepted: true; action: 'stop' | 'headless' }
    | { accepted: false; reason: 'notPending' | 'staleAttachment' | 'invalidNonce' };

interface ActiveAttachment extends CodexGatewayAttachmentRegistration {
    connectionIds: Set<string>;
    exitAuthorityValid: boolean;
}

export class CodexGatewayAttachmentManager {
    private registration: CodexGatewayAttachmentRegistration | null = null;
    private active: ActiveAttachment | null = null;
    private detachTimer: ReturnType<typeof setTimeout> | null = null;
    private stateValue: CodexGatewayTerminalState;
    private detachedAtValue: number | null = null;

    constructor(private readonly options: {
        origin: 'terminal' | 'app';
        initialState?: CodexGatewayTerminalState;
        detachGraceMs?: number;
        now?: () => number;
        onStateChanged?(state: CodexGatewayTerminalState, detachedAt: number | null): void;
        onNormalExit?(action: 'stop' | 'headless'): void;
    }) {
        this.stateValue = options.initialState ?? (options.origin === 'app' ? 'headless' : 'detached');
    }

    get state(): CodexGatewayTerminalState {
        return this.stateValue;
    }

    get detachedAt(): number | null {
        return this.detachedAtValue;
    }

    register(registration: CodexGatewayAttachmentRegistration): { accepted: boolean } {
        if (this.stateValue === 'attached') return { accepted: false };
        if (this.active) this.active.exitAuthorityValid = false;
        this.registration = registration;
        return { accepted: true };
    }

    claim(connectionId: string, connectionToken: string | null): boolean {
        const active = this.active;
        if (
            active
            && active.exitAuthorityValid
            && connectionToken
            && secureEqual(connectionToken, active.connectionToken)
        ) {
            this.clearDetachTimer();
            active.connectionIds.add(connectionId);
            this.updateState('attached', null);
            return true;
        }
        const registration = this.registration;
        if (!registration || !connectionToken || !secureEqual(connectionToken, registration.connectionToken)) {
            return false;
        }
        this.clearDetachTimer();
        this.registration = null;
        this.active = {
            ...registration,
            connectionIds: new Set([connectionId]),
            exitAuthorityValid: true,
        };
        this.updateState('attached', null);
        return true;
    }

    disconnect(connectionId: string): void {
        const active = this.active;
        if (!active || !active.connectionIds.delete(connectionId)) return;
        if (active.connectionIds.size > 0) return;
        const detachedAt = this.now();
        this.updateState('pendingDetach', detachedAt);
        this.clearDetachTimer();
        this.detachTimer = setTimeout(() => {
            this.detachTimer = null;
            if (this.active !== active || active.connectionIds.size > 0) return;
            if (this.stateValue !== 'pendingDetach') return;
            active.exitAuthorityValid = false;
            this.updateState('detached', detachedAt);
        }, this.options.detachGraceMs ?? 10_000);
        this.detachTimer.unref?.();
    }

    normalExit(input: { attachmentId: string; nonce: string }): CodexGatewayNormalExitResult {
        const active = this.active;
        if (!active || active.attachmentId !== input.attachmentId || !active.exitAuthorityValid) {
            return { accepted: false, reason: 'staleAttachment' };
        }
        if (this.stateValue !== 'pendingDetach') {
            return { accepted: false, reason: 'notPending' };
        }
        if (!secureEqual(input.nonce, active.normalExitNonce)) {
            return { accepted: false, reason: 'invalidNonce' };
        }
        active.exitAuthorityValid = false;
        this.active = null;
        this.registration = null;
        this.clearDetachTimer();
        const action = this.options.origin === 'terminal' ? 'stop' : 'headless';
        if (action === 'headless') this.updateState('headless', null);
        this.options.onNormalExit?.(action);
        return { accepted: true, action };
    }

    dispose(): void {
        this.clearDetachTimer();
        this.registration = null;
        this.active = null;
    }

    private updateState(state: CodexGatewayTerminalState, detachedAt: number | null): void {
        this.stateValue = state;
        this.detachedAtValue = detachedAt;
        this.options.onStateChanged?.(state, detachedAt);
    }

    private clearDetachTimer(): void {
        if (this.detachTimer) clearTimeout(this.detachTimer);
        this.detachTimer = null;
    }

    private now(): number {
        return Math.max(0, Math.trunc(this.options.now?.() ?? Date.now()));
    }
}

function secureEqual(left: string, right: string): boolean {
    const leftHash = createHash('sha256').update(left).digest();
    const rightHash = createHash('sha256').update(right).digest();
    return timingSafeEqual(leftHash, rightHash);
}
