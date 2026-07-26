import { execSync } from 'node:child_process';
import type {
    CodexAgentCapabilities,
    CodexModelCapability,
    MachineMetadata,
    Metadata,
} from '@/api/types';
import { logger } from '@/ui/logger';
import { CodexAppServerClient } from './codexAppServerClient';
import type { Model } from './codexAppServerTypes';

export function normalizeCodexModels(models: Model[]): CodexModelCapability[] {
    return models
        .filter((model) => !model.hidden && model.id.length > 0)
        .map((model) => ({
            code: model.id,
            value: model.displayName || model.model || model.id,
            description: model.description || null,
            thinkingLevels: model.supportedReasoningEfforts
                .map((option) => option.reasoningEffort)
                .filter((effort) => effort.length > 0),
            defaultThinkingLevel: model.defaultReasoningEffort,
        }))
        .filter((model) => (
            model.thinkingLevels.length > 0
            && model.thinkingLevels.includes(model.defaultThinkingLevel)
        ));
}

export async function loadCodexModelCapabilities(
    client: Pick<CodexAppServerClient, 'listModels'>,
    timeoutMs: number = 5_000,
): Promise<CodexModelCapability[] | null> {
    try {
        const models = normalizeCodexModels(await client.listModels({ timeoutMs }));
        return models.length > 0 ? models : null;
    } catch (error) {
        logger.debug('[Codex] Model capability discovery failed; continuing without catalog', error);
        return null;
    }
}

function readCodexCliVersion(): string | null {
    try {
        const version = execSync('codex --version', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2_000,
            windowsHide: true,
        }).trim();
        return version.length > 0 ? version : null;
    } catch {
        return null;
    }
}

export async function discoverCodexAgentCapabilities(
    timeoutMs: number = 5_000,
): Promise<CodexAgentCapabilities | null> {
    const codexCliVersion = readCodexCliVersion();
    if (!codexCliVersion) return null;

    const client = new CodexAppServerClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const operation = (async () => {
        await client.connect();
        return loadCodexModelCapabilities(client, timeoutMs);
    })();

    try {
        const models = await Promise.race([
            operation,
            new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), timeoutMs);
            }),
        ]);
        if (!models) return null;
        return {
            codexCliVersion,
            detectedAt: Date.now(),
            models,
        };
    } catch (error) {
        logger.debug('[Codex] App-server capability discovery failed; continuing without catalog', error);
        return null;
    } finally {
        if (timer) clearTimeout(timer);
        await client.disconnect().catch((error) => {
            logger.debug('[Codex] Failed to close capability discovery app-server', error);
        });
    }
}

export function mergeCodexAgentCapabilities(
    metadata: MachineMetadata,
    capabilities: CodexAgentCapabilities | null,
): MachineMetadata {
    if (!capabilities) return metadata;
    return {
        ...metadata,
        agentCapabilities: {
            ...metadata.agentCapabilities,
            codex: capabilities,
        },
    };
}

export function mergeCodexSessionModels(
    metadata: Metadata,
    models: CodexModelCapability[] | null,
): Metadata {
    if (!models) return metadata;
    return { ...metadata, models };
}
