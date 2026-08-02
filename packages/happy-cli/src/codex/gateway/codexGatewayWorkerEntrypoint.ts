import { runCodexGatewayWorker } from './codexGatewayWorker';

export interface CodexGatewayWorkerEntrypointDependencies {
    run(gatewayId: string): Promise<void>;
    exit(code: number): never;
}

const defaultDependencies: CodexGatewayWorkerEntrypointDependencies = {
    run: (gatewayId) => runCodexGatewayWorker({ gatewayId }),
    exit: (code) => process.exit(code),
};

export async function runCodexGatewayWorkerEntrypoint(
    gatewayId: string,
    dependencies: CodexGatewayWorkerEntrypointDependencies = defaultDependencies,
): Promise<never> {
    await dependencies.run(gatewayId);
    return dependencies.exit(0);
}
