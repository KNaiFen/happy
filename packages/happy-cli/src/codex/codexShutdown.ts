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
