import * as React from 'react';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import {
    machineResumeSession,
    sessionKill,
    sessionSetAgentModes,
    forkAndSpawn,
    type ForkSource,
    type ResumeSessionBlockedReason,
} from '@/sync/ops';
import { archiveSession as archiveSessionAuthoritatively } from '@/sync/sessionArchiveCoordinator';
import { maybeCleanupWorktree } from '@/hooks/useWorktreeCleanup';
import {
    storage,
    useIsSessionMachineDeleted,
    useLocalSetting,
    useMachine,
    useMachinesLoaded,
    useResumeEligibility,
    useSetting,
    type ResumeEligibilityEntry,
} from '@/sync/storage';
import { Machine, Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { resolveMessageModeMeta } from '@/sync/messageMeta';
import { t } from '@/text';
import { HappyError } from '@/utils/errors';
import { copySessionMetadataToClipboard, copySessionMetadataAndLogsToClipboard } from '@/utils/copySessionMetadataToClipboard';
import { useSessionStatus } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { getSessionForkSource } from '@/utils/sessionFork';
import { useRouter } from 'expo-router';
import { useSession } from '@/sync/storage';
import { DuplicateSheet } from '@/components/DuplicateSheet';
import type { SessionActionShortcutId } from '@/keyboard/shortcuts';
import { canStopCodexGatewaySession } from '@/sync/codexV4Capabilities';
import {
    buildResumeEligibilityFingerprint,
    ensureResumeEligibilityForSession,
    isResumeEligibilityFresh,
    useResumeEligibilityPreflight,
} from '@/sync/resumeEligibility';

export interface SessionActionItem {
    id: SessionActionShortcutId;
    label: string;
    icon: string;
    onPress: () => void;
    destructive?: boolean;
}

interface UseSessionQuickActionsOptions {
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onAfterCopySessionMetadata?: () => void;
}

type ResumeAvailability = {
    canResume: boolean;
    canShowResume: boolean;
    subtitle: string;
    message: string;
};

function getResumeAvailability(
    session: Session,
    machine: Machine | null | undefined,
    isConnected: boolean,
    resumeEligibility: ResumeEligibilityEntry | null,
): ResumeAvailability {
    if (
        session.metadata?.codexReadOnly === true
        || session.metadata?.flavor !== 'codex'
        || session.metadata?.codexSyncVersion !== 4
    ) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }
    if (isConnected) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }
    if (session.active && session.archivedAt === null) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }

    const machineId = session.metadata?.machineId;
    if (!machineId) {
        const message = t('sessionInfo.resumeSessionMissingMachine');
        return {
            canResume: false,
            canShowResume: false,
            subtitle: message,
            message,
        };
    }

    const hasBackendResumeId = Boolean(session.metadata?.codexThreadId);
    if (!hasBackendResumeId) {
        const message = t('sessionInfo.resumeSessionMissingCodexThread');
        return {
            canResume: false,
            canShowResume: false,
            subtitle: message,
            message,
        };
    }

    if (!machine) {
        const message = t('sessionInfo.resumeSessionSameMachineOnly');
        return {
            canResume: false,
            canShowResume: false,
            subtitle: message,
            message,
        };
    }

    if (
        machine.metadata?.resumeSupport?.rpcAvailable !== true
        || machine.metadata.resumeSupport.preflightRpcAvailable !== true
    ) {
        const message = t('sessionInfo.resumeSessionRequiresUpgrade');
        return {
            canResume: false,
            canShowResume: false,
            subtitle: message,
            message,
        };
    }

    if (!isMachineOnline(machine)) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: t('sessionInfo.resumeSessionMachineOffline'),
            message: t('sessionInfo.resumeSessionMachineOffline'),
        };
    }

    if (resumeEligibility?.state !== 'eligible') {
        const message = resumeEligibility?.state === 'ineligible'
            ? resumeEligibility.reason === 'threadUnavailable'
                ? t('sessionInfo.resumeSessionThreadUnavailable')
                : t('sessionInfo.resumeSessionInvalidBinding')
            : t('sessionInfo.resumeSessionPendingVerification');
        return {
            canResume: false,
            canShowResume: false,
            subtitle: message,
            message,
        };
    }

    return {
        canResume: true,
        canShowResume: true,
        subtitle: t('sessionInfo.resumeSessionSubtitle'),
        message: t('sessionInfo.resumeSessionSubtitle'),
    };
}

function resumeBlockedMessage(reason: ResumeSessionBlockedReason): string {
    switch (reason) {
        case 'threadUnavailable': return t('sessionInfo.resumeSessionThreadUnavailable');
        case 'externalThreadActive': return t('sessionInfo.resumeSessionExternalThreadActive');
        case 'gatewayRecovering': return t('sessionInfo.resumeSessionGatewayRecovering');
        case 'invalidBinding': return t('sessionInfo.resumeSessionInvalidBinding');
    }
}

function resumeErrorMessage(error: 'operationFailed' | 'outcomeUnknown'): string {
    return error === 'outcomeUnknown'
        ? t('sessionInfo.resumeSessionOutcomeUnknown')
        : t('sessionInfo.resumeSessionOperationFailed');
}

export function useSessionQuickActions(
    session: Session,
    options: UseSessionQuickActionsOptions = {},
) {
    const {
        onAfterArchive,
        onAfterCopySessionMetadata,
    } = options;
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const sessionStatus = useSessionStatus(session);
    const isCodexReadOnly = session.metadata?.codexReadOnly === true;
    const machineDeleted = useIsSessionMachineDeleted(session.id);
    const machineId = session.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const machinesLoaded = useMachinesLoaded();
    const storedResumeEligibility = useResumeEligibility(session.id);
    const resumeEligibilityNow = useResumeEligibilityPreflight({
        sessions: [session],
        machines: machine ? [machine] : [],
        machinesLoaded,
    });
    const resumeEligibilityFingerprint = buildResumeEligibilityFingerprint(session, machine);
    const currentResumeEligibility = isResumeEligibilityFresh(
        storedResumeEligibility,
        resumeEligibilityFingerprint,
        resumeEligibilityNow,
    ) ? storedResumeEligibility : null;
    const canStopGateway = canStopCodexGatewaySession(session.metadata, { machineDeleted });
    const pendingResumeOperationRef = React.useRef<{
        id: string;
        fingerprint: string;
    } | null>(null);
    const [resumeError, setResumeError] = React.useState<string | null>(null);
    const [resumeBlockedReason, setResumeBlockedReason] = React.useState<ResumeSessionBlockedReason | null>(null);
    const devModeEnabled = useLocalSetting('devModeEnabled');
    const expThreadActions = useSetting('expResumeSession');
    const resumeAvailability = React.useMemo(
        () => !machineDeleted
            ? getResumeAvailability(
                session,
                machine,
                sessionStatus.isConnected,
                currentResumeEligibility,
            )
            : { canResume: false, canShowResume: false, subtitle: '', message: '' },
        [currentResumeEligibility, machine, machineDeleted, session, sessionStatus.isConnected],
    );

    // Fork eligibility — separate from resume because fork works on both
    // active AND inactive provider sessions. The legacy experimental setting
    // continues to gate fork and duplicate, but never Resume.
    const forkSource = React.useMemo(() => getSessionForkSource(session), [
        session.id,
        session.metadata?.flavor,
        session.metadata?.machineId,
        session.metadata?.path,
        session.metadata?.codexThreadId,
        session.metadata?.codexReadOnly,
    ]);
    const canFork = Boolean(
        expThreadActions
        && !machineDeleted
        && forkSource
        && machine
        && isMachineOnline(machine),
    );

    const openDetails = React.useCallback(() => {
        router.push(`/session/${session.id}/info`);
    }, [router, session.id]);

    const copySessionMetadata = React.useCallback(() => {
        void (async () => {
            const copied = await copySessionMetadataToClipboard(session);
            if (copied) {
                onAfterCopySessionMetadata?.();
            }
        })();
    }, [onAfterCopySessionMetadata, session]);

    const copySessionMetadataAndLogs = React.useCallback(() => {
        void (async () => {
            const copied = await copySessionMetadataAndLogsToClipboard(session);
            if (copied) {
                onAfterCopySessionMetadata?.();
            }
        })();
    }, [onAfterCopySessionMetadata, session]);

    const [resumingSession, performResume] = useHappyAction(async () => {
        setResumeError(null);
        setResumeBlockedReason(null);
        if (!resumeAvailability.canResume) {
            throw new HappyError(resumeAvailability.message, false);
        }
        const verifiedEligibility = await ensureResumeEligibilityForSession({
            session,
            machine,
            machinesLoaded,
            force: true,
        });
        if (verifiedEligibility?.state !== 'eligible') {
            throw new HappyError(t('sessionInfo.resumeSessionPendingVerification'), false);
        }

        if (!machineId) {
            throw new HappyError(t('sessionInfo.resumeSessionMissingMachine'), false);
        }
        const directory = session.metadata?.path;
        const threadId = session.metadata?.codexThreadId;
        if (!directory || !threadId) {
            const message = t('sessionInfo.resumeSessionInvalidBinding');
            setResumeError(message);
            setResumeBlockedReason('invalidBinding');
            throw new HappyError(message, false);
        }

        const modeMeta = resolveMessageModeMeta(session, {
            agentDefaultOverrides: storage.getState().localSettings.agentDefaultOverrides,
        });
        const operationFingerprint = JSON.stringify({
            machineId,
            sessionId: session.id,
            directory,
            threadId,
            model: modeMeta.model ?? null,
            permissionMode: modeMeta.permissionMode,
        });
        if (pendingResumeOperationRef.current?.fingerprint !== operationFingerprint) {
            pendingResumeOperationRef.current = {
                id: sync.generateOperationId(),
                fingerprint: operationFingerprint,
            };
        }
        const result = await machineResumeSession({
            operationId: pendingResumeOperationRef.current.id,
            machineId,
            sessionId: session.id,
            directory,
            threadId,
            model: modeMeta.model ?? undefined,
            permissionMode: modeMeta.permissionMode,
        });

        switch (result.type) {
            case 'success': {
                pendingResumeOperationRef.current = null;
                setResumeError(null);
                // Session reconnects to the same ID, so messages are preserved.
                // Refresh to pick up the updated session state.
                await sync.refreshSessions();

                if (session.permissionMode) {
                    sessionSetAgentModes(result.sessionId, { permissionMode: session.permissionMode });
                }
                // Model / effort picks survive resume on their own — they live
                // in the session's synced metadata (#1492).

                navigateToSession(result.sessionId);
                return;
            }
            case 'blocked': {
                const message = resumeBlockedMessage(result.reason);
                storage.getState().applyResumeEligibility({
                    [session.id]: {
                        fingerprint: buildResumeEligibilityFingerprint(session, machine),
                        state: result.reason === 'threadUnavailable' || result.reason === 'invalidBinding'
                            ? 'ineligible'
                            : 'checking',
                        checkedAt: Date.now(),
                        reason: result.reason,
                    },
                });
                setResumeBlockedReason(result.reason);
                setResumeError(message);
                throw new HappyError(message, false);
            }
            case 'error':
                {
                    const message = resumeErrorMessage(result.error);
                    storage.getState().applyResumeEligibility({
                        [session.id]: {
                            fingerprint: buildResumeEligibilityFingerprint(session, machine),
                            state: 'checking',
                            checkedAt: Date.now(),
                            reason: 'providerUnavailable',
                        },
                    });
                    setResumeError(message);
                    throw new HappyError(message, false);
                }
        }
    });

    const [archivingSession, performArchive] = useHappyAction(async () => {
        await archiveSessionAuthoritatively(session.id, {
            ...(!machineDeleted ? {
                beforeStop: () => maybeCleanupWorktree(
                    session.id,
                    session.metadata?.path,
                    session.metadata?.machineId,
                ),
            } : {}),
        });
        onAfterArchive?.();
    });

    const archiveSession = React.useCallback(() => {
        performArchive();
    }, [performArchive]);

    const [stoppingGateway, performStopGateway] = useHappyAction(async () => {
        if (!canStopGateway) {
            throw new HappyError(t('sessionInfo.stopGatewayFailed'), false);
        }
        const result = await sessionKill(session.id);
        if (!result.success) {
            throw new HappyError(result.message || t('sessionInfo.stopGatewayFailed'), false);
        }
        await sync.refreshSessions().catch(() => undefined);
    });

    const stopGateway = React.useCallback(() => {
        Modal.alert(
            t('sessionInfo.stopGateway'),
            t('sessionInfo.stopGatewayConfirm'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('sessionInfo.stopGateway'),
                    style: 'destructive',
                    onPress: performStopGateway,
                },
            ],
        );
    }, [performStopGateway]);

    const resumeSession = React.useCallback(() => {
        performResume();
    }, [performResume]);

    const openResumeAlternatives = React.useCallback(() => {
        const directory = session.metadata?.path;
        if (!machineId || !directory) return;
        router.push(`/machine/${encodeURIComponent(machineId)}?path=${encodeURIComponent(directory)}&resume=1`);
    }, [machineId, router, session.metadata?.path]);
    const canOpenResumeAlternatives = resumeBlockedReason === 'threadUnavailable'
        && Boolean(machineId && session.metadata?.path);

    // Fork the Codex thread without truncation. The source row stays untouched.
    const [forking, performFork] = useHappyAction(async () => {
        if (!canFork) {
            throw new HappyError(t('session.forkErrorMissingMetadata'), false);
        }
        if (!forkSource) {
            throw new HappyError(t('session.forkErrorMissingMetadata'), false);
        }
        const result = await forkAndSpawn(forkSource as ForkSource);
        if (result.type !== 'success') {
            throw new HappyError(result.type === 'error' ? result.errorMessage : t('session.forkErrorGeneric'), false);
        }
        navigateToSession(result.sessionId);
    });

    const forkSession = React.useCallback(() => {
        performFork();
    }, [performFork]);

    const openDuplicateSheet = React.useCallback(() => {
        if (!canFork) return;
        Modal.show({
            component: DuplicateSheet,
            props: { sessionId: session.id },
        } as any);
    }, [canFork, session.id]);

    const canCopySessionMetadata = __DEV__ || devModeEnabled;

    const actionItems = React.useMemo<SessionActionItem[]>(() => {
        const items: SessionActionItem[] = [
            { id: 'details', icon: 'information-circle-outline', label: t('profile.details'), onPress: openDetails },
        ];

        if (resumeAvailability.canResume) {
            items.push({ id: 'resume', icon: 'play-circle-outline', label: t('sessionInfo.resumeSession'), onPress: resumeSession });
        }

        if (canFork) {
            items.push({ id: 'fork', icon: 'git-branch-outline', label: t('session.forkAction'), onPress: forkSession });
            items.push({ id: 'duplicate', icon: 'time-outline', label: t('session.duplicateAction'), onPress: openDuplicateSheet });
        }

        if (canCopySessionMetadata) {
            items.push({ id: 'copy-metadata', icon: 'bug-outline', label: t('sessionInfo.copyMetadata'), onPress: copySessionMetadata });
            items.push({ id: 'copy-metadata-and-logs', icon: 'document-text-outline', label: t('sessionInfo.copyMetadata') + ' & Client Logs', onPress: copySessionMetadataAndLogs });
        }

        if (canStopGateway) {
            items.push({
                id: 'stop-gateway',
                icon: 'stop-circle-outline',
                label: t('sessionInfo.stopGateway'),
                onPress: stopGateway,
                destructive: true,
            });
        }

        if (!isCodexReadOnly) {
            items.push({ id: 'archive', icon: 'archive-outline', label: 'Archive', onPress: archiveSession, destructive: true });
        }

        return items;
    }, [
        archiveSession,
        canCopySessionMetadata,
        canFork,
        canStopGateway,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        forkSource,
        forkSession,
        isCodexReadOnly,
        openDetails,
        openDuplicateSheet,
        resumeAvailability.canResume,
        resumeSession,
        stopGateway,
    ]);

    const showActionAlert = React.useCallback(() => {
        const buttons: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' | 'default' }> = actionItems.map(item => ({
            text: item.label,
            onPress: item.onPress,
            style: item.destructive ? 'destructive' as const : undefined,
        }));
        buttons.push({ text: t('common.cancel'), style: 'cancel' });
        Modal.alert('Session', undefined, buttons);
    }, [actionItems]);

    return {
        actionItems,
        showActionAlert,
        archiveSession,
        archivingSession,
        canArchive: !isCodexReadOnly,
        canCopySessionMetadata,
        canResume: resumeAvailability.canResume,
        canShowResume: resumeAvailability.canShowResume,
        canStopGateway,
        canFork,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        forkSession,
        forking,
        openDetails,
        openDuplicateSheet,
        resumeSession,
        resumeError,
        resumeBlockedReason,
        canOpenResumeAlternatives,
        openResumeAlternatives,
        resumeSessionSubtitle: resumeAvailability.subtitle,
        resumingSession,
        stopGateway,
        stoppingGateway,
    };
}

/**
 * Lightweight hook for list items that only have a sessionId.
 * Returns a long-press handler that shows the action alert on mobile.
 */
export function useSessionActionAlert(sessionId: string) {
    const session = useSession(sessionId);
    const { showActionAlert } = useSessionQuickActions(session!, {});
    return session ? showActionAlert : undefined;
}
