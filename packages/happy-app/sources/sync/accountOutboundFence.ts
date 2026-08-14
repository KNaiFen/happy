import { BackoffAbortError } from '@/utils/backoffAbort';

const permitMarker: unique symbol = Symbol('accountOutboundPermit');

export type AccountOutboundPermit = {
    readonly generation: number;
    readonly [permitMarker]: true;
};

export class AccountOutboundCancelledError extends BackoffAbortError {
    constructor() {
        super('The account lifecycle no longer permits outbound requests');
        this.name = 'AccountOutboundCancelledError';
    }
}

let generation = 0;
let active = false;
let activeToken: string | null = null;

export function beginAccountOutboundLifecycle(token: string): void {
    generation += 1;
    active = true;
    activeToken = token;
}

export function endAccountOutboundLifecycle(): void {
    generation += 1;
    active = false;
    activeToken = null;
}

export function captureAccountOutboundPermit(token?: string): AccountOutboundPermit {
    if (!active || (token !== undefined && token !== activeToken)) {
        throw new AccountOutboundCancelledError();
    }
    return { generation, [permitMarker]: true };
}

export function assertAccountOutboundPermit(permit: AccountOutboundPermit): void {
    if (!active || permit.generation !== generation) {
        throw new AccountOutboundCancelledError();
    }
}

export function fetchWithAccountOutboundPermit(
    permit: AccountOutboundPermit,
    input: RequestInfo | URL,
    init?: RequestInit,
    transport: typeof fetch = fetch,
): Promise<Response> {
    assertAccountOutboundPermit(permit);
    return transport(input, init);
}

export function createAccountFetch(
    token: string,
    transport: typeof fetch = fetch,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
    const permit = captureAccountOutboundPermit(token);
    return (input, init) => fetchWithAccountOutboundPermit(permit, input, init, transport);
}
