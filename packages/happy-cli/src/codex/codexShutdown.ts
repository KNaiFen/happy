export type CodexShutdownStage =
    | 'reconnection'
    | 'v4Runtime'
    | 'sessionDeath'
    | 'sessionFlush'
    | 'sessionClose'
    | 'providerDisconnect'
    | 'protocolTrace'
    | 'mcpServer'
    | 'terminal'
    | 'keepAlive'
    | 'ink'
    | 'messageBuffer'
    | 'diagnosticTerminal'
    | 'diagnosticClose';

export interface CodexShutdownStep {
    stage: CodexShutdownStage;
    run: () => void | Promise<void>;
}

export interface CodexV4BindingCloseResources {
    commandProcessor: { close(): void | Promise<void> };
    requestBroker: { failPending(reason: 'brokerClosed'): void | Promise<void> };
    mapper: { close(): void | Promise<void> };
    syncClient: {
        flushOutboundOnce(): void | Promise<void>;
        close(): void | Promise<void>;
    };
    session?: { close(): void | Promise<void> };
}

export async function closeCodexV4BindingResources(
    resources: CodexV4BindingCloseResources,
): Promise<void> {
    let firstError: unknown;
    let hasError = false;
    const attempt = async (run: () => void | Promise<void>): Promise<void> => {
        try {
            await run();
        } catch (error) {
            if (!hasError) {
                firstError = error;
                hasError = true;
            }
        }
    };

    await attempt(() => resources.commandProcessor.close());
    await attempt(() => resources.requestBroker.failPending('brokerClosed'));
    await attempt(() => resources.mapper.close());
    await attempt(() => resources.syncClient.flushOutboundOnce());
    await attempt(() => resources.syncClient.close());
    if (resources.session) await attempt(() => resources.session!.close());

    if (hasError) throw firstError;
}

export async function runCodexShutdownSteps(
    steps: readonly CodexShutdownStep[],
    onFailure: (stage: CodexShutdownStage, error: unknown) => void | Promise<void>,
): Promise<number> {
    let failureCount = 0;
    for (const step of steps) {
        try {
            await step.run();
        } catch (error) {
            failureCount += 1;
            try {
                await onFailure(step.stage, error);
            } catch {
                // Shutdown must continue even when its error reporter is unavailable.
            }
        }
    }
    return failureCount;
}
