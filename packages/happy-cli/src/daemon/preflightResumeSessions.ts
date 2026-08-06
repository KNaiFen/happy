import type { MachineSessionSnapshot } from '@/api/types';
import {
  CodexThreadBindingError,
  CodexThreadUnavailableError,
  type CodexThreadHistorySummary,
} from '@/codex/codexThreadHistory';
import { resolveCodexBoundThreadLaunchDecision } from '@/codex/codexThreadOpenCoordinator';
import type { CodexGatewaySessionInspection } from '@/codex/gateway/codexGatewayLauncher';
import type {
  PreflightResumeSessionInput,
  PreflightResumeSessionResult,
  PreflightResumeSessionsRequest,
  PreflightResumeSessionsResponse,
} from '@/modules/common/registerCommonHandlers';
import { resolveResumeSessionMaterial } from './resumeSessionMaterial';
import { validateSessionThreadBinding } from './validateSessionThreadBinding';

export type PreflightResumeSessionsDependencies = {
  machineId: string;
  loadSnapshot: (input: {
    sessionId: string;
    machineId: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'dataKey';
  }) => Promise<MachineSessionSnapshot | null>;
  inspectThread: (
    directory: string,
    threadId: string,
  ) => Promise<CodexThreadHistorySummary>;
  inspectGateway: (input: {
    sessionId: string;
    threadId: string;
  }) => Promise<CodexGatewaySessionInspection>;
};

export async function preflightResumeSessions(
  request: PreflightResumeSessionsRequest,
  dependencies: PreflightResumeSessionsDependencies,
): Promise<PreflightResumeSessionsResponse> {
  const results = await Promise.all(request.sessions.map((session) => (
    preflightResumeSession(session, dependencies)
  )));
  return { type: 'success', results };
}

async function preflightResumeSession(
  session: PreflightResumeSessionInput,
  dependencies: PreflightResumeSessionsDependencies,
): Promise<PreflightResumeSessionResult> {
  const material = await resolveResumeSessionMaterial({
    sessionId: session.sessionId,
    machineId: dependencies.machineId,
    dataEncryptionKey: session.dataEncryptionKey,
    loadSnapshot: dependencies.loadSnapshot,
  });
  if (material.type !== 'snapshot') {
    if (material.type === 'error' && material.kind === 'unavailable') {
      return {
        type: 'pending',
        sessionId: session.sessionId,
        reason: 'relayUnavailable',
      };
    }
    return {
      type: 'ineligible',
      sessionId: session.sessionId,
      reason: 'invalidBinding',
    };
  }

  let thread: CodexThreadHistorySummary;
  try {
    thread = await dependencies.inspectThread(session.directory, session.threadId);
  } catch (error) {
    if (error instanceof CodexThreadUnavailableError) {
      return {
        type: 'ineligible',
        sessionId: session.sessionId,
        reason: 'threadUnavailable',
      };
    }
    if (error instanceof CodexThreadBindingError) {
      return {
        type: 'ineligible',
        sessionId: session.sessionId,
        reason: 'invalidBinding',
      };
    }
    return {
      type: 'pending',
      sessionId: session.sessionId,
      reason: 'providerUnavailable',
    };
  }

  try {
    validateSessionThreadBinding({
      machineId: dependencies.machineId,
      snapshot: material.snapshot,
      thread,
    });
  } catch {
    return {
      type: 'ineligible',
      sessionId: session.sessionId,
      reason: 'invalidBinding',
    };
  }

  let gatewayInspection: CodexGatewaySessionInspection;
  try {
    gatewayInspection = await dependencies.inspectGateway({
      sessionId: material.snapshot.id,
      threadId: thread.threadId,
    });
  } catch {
    return {
      type: 'pending',
      sessionId: session.sessionId,
      reason: 'gatewayRecovering',
    };
  }

  const launchDecision = resolveCodexBoundThreadLaunchDecision({
    providerStatus: thread.status,
    gatewayState: gatewayInspection.state,
  });
  if (launchDecision === 'existing-active') {
    return { type: 'alreadyActive', sessionId: session.sessionId };
  }
  if (launchDecision === 'process-transition') {
    return {
      type: 'pending',
      sessionId: session.sessionId,
      reason: 'gatewayRecovering',
    };
  }
  if (launchDecision === 'external-active') {
    return {
      type: 'pending',
      sessionId: session.sessionId,
      reason: 'externalThreadActive',
    };
  }
  return { type: 'eligible', sessionId: session.sessionId };
}
