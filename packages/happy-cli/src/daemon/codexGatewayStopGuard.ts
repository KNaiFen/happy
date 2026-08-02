import type {
    CodexGatewayBinding,
    CodexGatewayDescriptor,
} from '@/codex/gateway/codexGatewayState';

export interface CodexGatewayStopExpectation {
    gatewayId: string;
    generation: number;
}

export function findCodexGatewayStopBinding(
    descriptor: CodexGatewayDescriptor,
    sessionId: string,
): CodexGatewayBinding | null {
    if (descriptor.current?.sessionId === sessionId) return descriptor.current;
    return descriptor.draining.find((binding) => binding.sessionId === sessionId) ?? null;
}

export function matchesCodexGatewayStopExpectation(
    descriptor: CodexGatewayDescriptor,
    binding: CodexGatewayBinding,
    expectation: CodexGatewayStopExpectation | undefined,
): boolean {
    return expectation === undefined
        || (
            descriptor.gatewayId === expectation.gatewayId
            && descriptor.current === binding
            && binding.generation === expectation.generation
        );
}
