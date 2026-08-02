import * as React from 'react';
import { useAgentDefaultOverrides, useAllMachines } from '@/sync/storage';
import { resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import { machineSpawnNewSession, sessionSetAgentModes, type SessionAgentModesPatch } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { createWorktree } from '@/utils/worktree';
import {
    getAvailableModelsForMachine,
    getEffortLevelsForModelOnMachine,
    getHardcodedPermissionModes,
} from '@/components/modelModeOptions';
import { Modal } from '@/modal';
import { t } from '@/text';
import { resolveNewSessionAgentConfig } from '@/sync/newSessionConfig';

function resolveOption<T extends { key: string }>(
    options: T[],
    preferredKeys: Array<string | null | undefined>,
): T | null {
    for (const key of preferredKeys) {
        if (!key) continue;
        const option = options.find((candidate) => candidate.key === key);
        if (option) return option;
    }
    return options[0] ?? null;
}

export function useStartSessionFromDraft() {
    const machines = useAllMachines({ includeOffline: true });
    const defaultOverrides = useAgentDefaultOverrides();
    const navigateToSession = useNavigateToSession();
    const [isStarting, setIsStarting] = React.useState(false);
    const isStartingRef = React.useRef(false);
    const pendingOperationRef = React.useRef<{ id: string; fingerprint: string } | null>(null);

    const startSession = React.useCallback(async (): Promise<boolean> => {
        if (isStartingRef.current) return false;

        const draft = useNewSessionDraft.getState();
        const machine = machines.find((candidate) => candidate.id === draft.selectedMachineId);
        if (!machine) {
            Modal.alert(t('common.error'), 'Please select a machine');
            return false;
        }
        if (!isMachineOnline(machine)) {
            Modal.alert(t('common.error'), 'Machine is offline');
            return false;
        }

        const defaults = resolveAgentDefaultConfig(defaultOverrides, draft.agentType);
        const permissionOptions = getHardcodedPermissionModes(draft.agentType, t);
        const modelOptions = getAvailableModelsForMachine(
            draft.agentType,
            machine.metadata,
            t,
            draft.modelMode ?? defaults.modelMode,
        );
        const capabilityState = draft.agentType === 'codex'
            && !machine.metadata?.agentCapabilities?.codex
            ? 'unknown'
            : 'authoritative';
        const config = resolveNewSessionAgentConfig({
            defaults,
            overrides: {
                ...(draft.permissionMode ? { permissionMode: draft.permissionMode } : {}),
                ...(draft.modelMode ? { modelMode: draft.modelMode } : {}),
                ...(draft.effortLevel ? { effortLevel: draft.effortLevel } : {}),
            },
            permissionOptions,
            modelOptions,
            effortOptionsForModel: (modelKey) => getEffortLevelsForModelOnMachine(
                draft.agentType,
                modelKey,
                machine.metadata,
                draft.effortLevel ?? defaults.effortLevel,
            ),
            capabilityState,
        });

        const prompt = draft.input.trim();
        const attachments = draft.attachments;
        const selectedPath = draft.selectedPath?.trim() || '~';
        const absolutePath = resolveAbsolutePath(selectedPath, machine.metadata?.homeDir);
        const worktreeSelection = draft.sessionType === 'worktree'
            ? draft.worktreeKey ?? '__new__'
            : '__none__';

        isStartingRef.current = true;
        setIsStarting(true);
        try {
            let spawnDirectory = absolutePath;
            if (worktreeSelection === '__new__') {
                const worktreeResult = await createWorktree(machine.id, absolutePath);
                if (!worktreeResult.success) {
                    Modal.alert(t('common.error'), worktreeResult.error || 'Failed to create worktree');
                    return false;
                }
                spawnDirectory = worktreeResult.worktreePath;
            } else if (worktreeSelection !== '__none__') {
                spawnDirectory = worktreeSelection;
            }
            const operationFingerprint = JSON.stringify({
                machineId: machine.id,
                directory: spawnDirectory,
                agent: draft.agentType,
                permissionMode: config.permissionMode,
                modelMode: config.modelMode,
                effortLevel: config.effortLevel ?? null,
            });
            if (pendingOperationRef.current?.fingerprint !== operationFingerprint) {
                pendingOperationRef.current = {
                    id: sync.generateOperationId(),
                    fingerprint: operationFingerprint,
                };
            }
            const operationId = pendingOperationRef.current.id;

            const spawn = async (approvedNewDirectoryCreation = false): Promise<string | null> => {
                const result = await machineSpawnNewSession({
                    operationId,
                    machineId: machine.id,
                    directory: spawnDirectory,
                    approvedNewDirectoryCreation,
                    agent: draft.agentType,
                    permissionMode: draft.agentType === 'codex' || config.permissionMode !== 'default'
                        ? config.permissionMode
                        : undefined,
                    modelMode: config.modelMode !== 'default' ? config.modelMode : undefined,
                    effortLevel: config.effortLevel ?? undefined,
                });

                if (result.type === 'success') return result.sessionId;
                if (result.type === 'error') {
                    Modal.alert(t('common.error'), result.errorMessage);
                    return null;
                }

                const approved = await Modal.confirm(
                    'Create Directory?',
                    `The directory '${result.directory}' does not exist. Would you like to create it?`,
                    { cancelText: t('common.cancel'), confirmText: t('common.create') },
                );
                return approved ? spawn(true) : null;
            };

            const sessionId = await spawn();
            if (!sessionId) return false;
            pendingOperationRef.current = null;

            await sync.refreshSessions();

            const modesPatch: SessionAgentModesPatch = {};
            if (config.permissionMode !== defaults.permissionMode) modesPatch.permissionMode = config.permissionMode;
            if (config.modelMode !== defaults.modelMode) modesPatch.modelMode = config.modelMode;
            if (config.effortLevel !== defaults.effortLevel) modesPatch.effortLevel = config.effortLevel;
            if (Object.keys(modesPatch).length > 0) {
                sessionSetAgentModes(sessionId, modesPatch);
            }

            draft.setInput('');
            draft.setAttachments([]);
            draft.resetModeOverrides();
            navigateToSession(sessionId);
            if (prompt || attachments.length > 0) {
                // The session is ready at this point. Open it immediately and
                // let the first message enqueue without keeping the user on Home
                // during image upload or a slower network round-trip.
                void sync.sendMessage(sessionId, prompt, { source: 'new_session', attachments }).catch((error) => {
                    Modal.alert(
                        t('common.error'),
                        error instanceof Error ? error.message : 'Failed to send the first message',
                    );
                });
            }
            return true;
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : 'Failed to start session',
            );
            return false;
        } finally {
            isStartingRef.current = false;
            setIsStarting(false);
        }
    }, [defaultOverrides, machines, navigateToSession]);

    return { isStarting, startSession };
}
