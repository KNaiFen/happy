import fs from 'fs/promises';
import * as tmp from 'tmp';
import { classifySyncV4DiagnosticError } from '@slopus/happy-wire';

import { ApiClient } from '@/api/api';
import { TrackedSession, SessionEncryptionData } from './types';
import { DaemonState, Metadata, type MachineSessionSnapshot } from '@/api/types';
import {
  SpawnSessionOptions,
  SpawnSessionResult,
  type ResumeSessionResult,
} from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeDaemonState, DaemonLocallyPersistedState, readDaemonState, acquireDaemonLock, releaseDaemonLock, readPersistedSessions, persistSession } from '@/persistence';
import type { PersistedSession } from '@/persistence';
import type { StopSessionResult } from '@/api/apiMachine';

import { cleanupDaemonState, isDaemonRunningForCurrentProfile, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { statSync } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { parseTmuxSessionIdentifier, formatTmuxSessionIdentifier } from '@/utils/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { encodeBase64, decodeBase64 } from '@/api/encryption';
import {
  buildSessionChildEnvironment,
  sanitizeSessionEnvironment,
} from './sessionEnvironment';
import {
  discoverCodexAgentCapabilities,
  mergeCodexAgentCapabilities,
} from '@/codex/codexModelCapabilities';
import { delay } from '@/utils/time';
import { machineRegistrationRetryDelay } from './machineRegistration';
import { buildDaemonSpawnPlan } from './spawnPlan';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import {
  CodexThreadHistoryService,
} from '@/codex/codexThreadHistory';
import {
  CodexThreadOpenCoordinator,
  resolveCodexBoundThreadLaunchDecision,
  type CodexOpenThreadRequest,
  type CodexOpenThreadResult,
} from '@/codex/codexThreadOpenCoordinator';
import { initialMachineMetadata } from './initialMachineMetadata';
import {
  discoverLiveCodexGateways,
  inspectVerifiedGatewayForSession,
  launchCodexGatewayHeadless,
} from '@/codex/gateway/codexGatewayLauncher';
import {
  CodexGatewayResumeBlockedError,
  createCodexGatewayResumeBootstrap,
  resumeCodexGatewayHeadless,
} from '@/codex/gateway/codexGatewayResume';
import {
  CodexGatewayControlRequestError,
  callCodexGatewayControl,
  isCodexGatewayControlOutcomeUnknown,
} from '@/codex/gateway/codexGatewayControl';
import { deriveCodexGatewayResumeSessionTag } from '@/codex/gateway/codexGatewayIdentity';
import { retireVerifiedLegacyCodexAdapters } from './legacyCodexAdapterRetirement';
import {
  findCodexGatewayStopBinding,
  matchesCodexGatewayStopExpectation,
  type CodexGatewayStopExpectation,
} from './codexGatewayStopGuard';
import {
  decodeIndependentSessionKey,
  resolveResumeSessionMaterial,
} from './resumeSessionMaterial';
import { preflightResumeSessions } from './preflightResumeSessions';
import { validateSessionThreadBinding } from './validateSessionThreadBinding';

function resolveGatewayPermissionMode(
  value: string | undefined,
): 'default' | 'read-only' | 'safe-yolo' | 'yolo' {
  if (value === undefined || value === 'default') return 'default';
  if (value === 'read-only' || value === 'safe-yolo' || value === 'yolo') return value;
  throw new Error(`Unsupported Codex permission mode: '${value}'`);
}

export async function startDaemon(): Promise<void> {
  // The daemon may have been launched from a session process. Keep its normal
  // environment, but never let session lineage or reconnect state reach a
  // later, unrelated child session.
  const ambientEnvironment = sanitizeSessionEnvironment(process.env);

  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[DAEMON RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 1_000);

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  process.on('uncaughtException', (error) => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonProfileMatches = await isDaemonRunningForCurrentProfile();
  if (!runningDaemonProfileMatches) {
    // TODO: This hand-rolled self-restart path is awkward to reason about and awkward to test.
    // We should probably migrate this daemon to native system service management
    // (launchd/systemd), so startup/start-at-login and upgrades
    // are owned by the OS instead of by the daemon trying to replace itself in-process.
    logger.debug('[DAEMON RUN] Daemon profile mismatch detected, restarting for current CLI and relay');
    await stopDaemon();
  } else {
    logger.debug('[DAEMON RUN] Daemon profile matches, keeping existing daemon');
    console.log('Daemon already running for the current CLI and relay');
    process.exit(0);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.warn('[DAEMON RUN] Failed to acquire daemon lock; daemon startup did not complete');
    process.exit(1);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  try {
    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    // Ensure auth and machine registration BEFORE anything else
    const { credentials, machineId } = await authAndSetupMachineIfNeeded({
      skipRelayProbeForBoundCredentials: true,
    });
    logger.debug('[DAEMON RUN] Auth and machine setup complete');
    const codexCapabilitiesPromise = initialMachineMetadata.cliAvailability?.codex
      ? discoverCodexAgentCapabilities()
      : Promise.resolve(null);

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Retain session data after process exits so resume can still find it.
    // Pre-populate from disk so sessions survive daemon restarts.
    const sessionIdToFinishedSession = new Map<string, TrackedSession>();
    const persisted = readPersistedSessions();
    for (const [id, s] of Object.entries(persisted)) {
      sessionIdToFinishedSession.set(id, {
        startedBy: 'persisted',
        happySessionId: id,
        happySessionMetadataFromLocalWebhook: s.metadata,
        encryption: {
          encryptionKey: decodeBase64(s.encryptionKey),
          encryptionVariant: s.encryptionVariant,
          seq: s.seq,
          metadataVersion: s.metadataVersion,
          agentStateVersion: s.agentStateVersion,
        },
        pid: s.hostPid ?? s.metadata.hostPid ?? 0,
      });
    }
    if (Object.keys(persisted).length > 0) {
      logger.debug(`[DAEMON RUN] Loaded ${Object.keys(persisted).length} persisted sessions from disk`);
    }

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    const refreshLiveCodexGateways = async (): Promise<void> => {
      const live = await discoverLiveCodexGateways({
        recover: true,
        env: ambientEnvironment,
      });
      const liveGatewayIds = new Set(live.map(({ descriptor }) => descriptor.gatewayId));
      for (const [pid, tracked] of pidToTrackedSession) {
        if (tracked.codexGatewayId && !liveGatewayIds.has(tracked.codexGatewayId)) {
          pidToTrackedSession.delete(pid);
        }
      }
      for (const { descriptor } of live) {
        const sessionId = descriptor.current?.sessionId;
        if (!sessionId) continue;
        for (const [pid, tracked] of pidToTrackedSession) {
          if (tracked.codexGatewayId === descriptor.gatewayId && pid !== descriptor.pid) {
            pidToTrackedSession.delete(pid);
          }
        }
        const persistedSession = sessionIdToFinishedSession.get(sessionId);
        const tracked = pidToTrackedSession.get(descriptor.pid) ?? {
          startedBy: descriptor.origin === 'app' ? 'daemon' : 'terminal',
          pid: descriptor.pid,
          ...(persistedSession?.happySessionMetadataFromLocalWebhook
            ? { happySessionMetadataFromLocalWebhook: persistedSession.happySessionMetadataFromLocalWebhook }
            : {}),
          ...(persistedSession?.encryption ? { encryption: persistedSession.encryption } : {}),
        };
        tracked.startedBy = descriptor.origin === 'app' ? 'daemon' : 'terminal';
        tracked.pid = descriptor.pid;
        tracked.happySessionId = sessionId;
        tracked.codexGatewayId = descriptor.gatewayId;
        pidToTrackedSession.set(descriptor.pid, tracked);
      }
    };

    await refreshLiveCodexGateways();

    const retiredLegacyCodexAdapters = retireVerifiedLegacyCodexAdapters(
      sessionIdToFinishedSession.values(),
      {
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
      },
    );
    if (retiredLegacyCodexAdapters > 0) {
      logger.debug('[DAEMON RUN] Retired verified legacy Codex adapters', {
        count: retiredLegacyCodexAdapters,
      });
    }

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    // Handle webhook from happy session reporting itself
    const onHappySessionWebhook = (sessionId: string, sessionMetadata: Metadata, encryption?: SessionEncryptionData) => {
      logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
        return;
      }

      logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}, hasEncryption: ${!!encryption}`);
      logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

      // Persist encryption data to disk so it survives daemon restarts
      if (encryption) {
        persistSession(sessionId, {
          encryptionKey: encodeBase64(encryption.encryptionKey),
          encryptionVariant: encryption.encryptionVariant,
          seq: encryption.seq,
          metadataVersion: encryption.metadataVersion,
          agentStateVersion: encryption.agentStateVersion,
          metadata: sessionMetadata,
          hostPid: pid,
          savedAt: Date.now(),
        });
      }

      // Check if we already have this PID (daemon-spawned)
      const existingSession = pidToTrackedSession.get(pid);

      if (existingSession && existingSession.startedBy === 'daemon') {
        // Update daemon-spawned session with reported data
        existingSession.happySessionId = sessionId;
        existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
        existingSession.encryption = encryption;
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

        // Resolve any awaiter for this PID
        const awaiter = pidToAwaiter.get(pid);
        if (awaiter) {
          pidToAwaiter.delete(pid);
          awaiter(existingSession);
          logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
        }
      } else if (!existingSession) {
        // New session started externally
        const trackedSession: TrackedSession = {
          startedBy: 'happy directly - likely by user from terminal',
          happySessionId: sessionId,
          happySessionMetadataFromLocalWebhook: sessionMetadata,
          encryption,
          pid
        };
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
      }
    };

    // Spawn a new session. Existing Codex sessions resume through resumeSession below.
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debug('[DAEMON RUN] Spawning session', {
        agent: options.agent ?? 'codex',
        approvedNewDirectoryCreation: options.approvedNewDirectoryCreation === true,
        hasSessionId: typeof options.sessionId === 'string',
        hasEnvironmentVariables: Boolean(options.environmentVariables && Object.keys(options.environmentVariables).length > 0),
        hasToken: typeof options.token === 'string',
        hasResumeThread: typeof options.resumeCodexThreadId === 'string',
        isSideChat: options.isSideChat === true,
      });

      const { directory, sessionId, machineId, approvedNewDirectoryCreation = true } = options;
      let spawnPlan;
      try {
        spawnPlan = buildDaemonSpawnPlan(options);
      } catch (error) {
        return {
          type: 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
      let directoryCreated = false;

      try {
        await fs.access(directory);
        logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
      } catch (error) {
        logger.debug(`[DAEMON RUN] Directory doesn't exist, creating: ${directory}`);

        // Check if directory creation is approved
        if (!approvedNewDirectoryCreation) {
          logger.debug(`[DAEMON RUN] Directory creation not approved for: ${directory}`);
          return {
            type: 'requestToApproveDirectoryCreation',
            directory
          };
        }

        try {
          await fs.mkdir(directory, { recursive: true });
          logger.debug(`[DAEMON RUN] Successfully created directory: ${directory}`);
          directoryCreated = true;
        } catch (mkdirError: any) {
          let errorMessage = `Unable to create directory at '${directory}'. `;

          // Provide more helpful error messages based on the error code
          if (mkdirError.code === 'EACCES') {
            errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
          } else if (mkdirError.code === 'ENOTDIR') {
            errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
          } else if (mkdirError.code === 'ENOSPC') {
            errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
          } else if (mkdirError.code === 'EROFS') {
            errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
          } else {
            errorMessage += `System error: ${mkdirError.message || mkdirError}. Please verify the path is valid and you have the necessary permissions.`;
          }

          logger.debug(`[DAEMON RUN] Directory creation failed: ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }
      }

      try {

        // Build environment variables for session spawning
        // Authentication tokens are resolved here

        // Resolve authentication token if provided
        const authEnv: Record<string, string> = {};
        if (options.token) {
          const codexHomeDir = tmp.dirSync();
          await fs.writeFile(join(codexHomeDir.name, 'auth.json'), options.token);
          authEnv.CODEX_HOME = codexHomeDir.name;
        }

        let extraEnv: Record<string, string> = {
          ...authEnv,
          ...sanitizeSessionEnvironment(options.environmentVariables ?? {}),
        };
        if (options.parentSessionId) {
          extraEnv.HAPPY_FORKED_FROM_SESSION_ID = options.parentSessionId;
        }
        if (options.forkedFromMessageId) {
          extraEnv.HAPPY_FORKED_FROM_MESSAGE_ID = options.forkedFromMessageId;
        }
        if (options.isSideChat) {
          extraEnv.HAPPY_SIDE_CHAT = '1';
        }
        if (options.resumeCodexThreadId) {
          extraEnv.HAPPY_FORK_CODEX_THREAD_ID = options.resumeCodexThreadId;
        }
        logger.debug(`[DAEMON RUN] Environment variable keys (before expansion) (${Object.keys(extraEnv).length}): ${Object.keys(extraEnv).join(', ')}`);

        // Expand ${VAR} references from the sanitized daemon environment.
        // This ensures variable substitution works in both tmux and non-tmux modes.
        extraEnv = expandEnvironmentVariables(extraEnv, ambientEnvironment);
        logger.debug(`[DAEMON RUN] After variable expansion: ${Object.keys(extraEnv).join(', ')}`);

        // Fail fast if any passed-through environment variable still contains an
        // unresolved ${VAR} reference after expansion.
        const unresolvedEnvEntries = Object.entries(extraEnv).flatMap(([key, value]) => {
          if (typeof value !== 'string' || !value.includes('${')) {
            return [];
          }

          const unresolvedMatch = value.match(/\$\{([^}]+)\}/);
          if (!unresolvedMatch) {
            return [];
          }

          const expression = unresolvedMatch[1];
          const defaultSeparatorIndex = expression.indexOf(':-');
          const missingVar = defaultSeparatorIndex === -1
            ? expression
            : expression.slice(0, defaultSeparatorIndex);

          return [`${key} references \${${missingVar}} which is not defined`];
        });

        if (unresolvedEnvEntries.length > 0) {
          const errorMessage = `Session environment is invalid - environment variables not found in daemon: ${unresolvedEnvEntries.join('; ')}. ` +
            `Ensure these variables are set in the daemon's environment before starting sessions.`;
          logger.warn(`[DAEMON RUN] ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }

        const permissionMode = resolveGatewayPermissionMode(options.permissionMode);
        const launch = await launchCodexGatewayHeadless({
          operationId: options.operationId,
          cwd: directory,
          env: buildSessionChildEnvironment(ambientEnvironment, extraEnv),
          action: options.resumeCodexThreadId ? 'resume' : 'start',
          threadId: options.resumeCodexThreadId,
          model: options.modelMode && options.modelMode !== 'default'
            ? options.modelMode
            : undefined,
          permissionMode,
          effortLevel: options.effortLevel,
          parentSessionId: options.parentSessionId,
          forkedFromMessageId: options.forkedFromMessageId,
          isSideChat: options.isSideChat,
        });
        const existing = pidToTrackedSession.get(launch.pid);
        const trackedSession: TrackedSession = existing ?? {
          startedBy: 'daemon',
          pid: launch.pid,
        };
        trackedSession.startedBy = 'daemon';
        trackedSession.pid = launch.pid;
        trackedSession.happySessionId = launch.sessionId;
        trackedSession.codexGatewayId = launch.gatewayId;
        trackedSession.directoryCreated = directoryCreated;
        trackedSession.message = directoryCreated
          ? `The path '${directory}' did not exist. We created a new folder and started a Codex Gateway there.`
          : undefined;
        pidToTrackedSession.set(launch.pid, trackedSession);
        return { type: 'success', sessionId: launch.sessionId };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`
        };
      }
    };

    const findTrackedSessionById = (happySessionId: string): TrackedSession | undefined => {
      for (const session of pidToTrackedSession.values()) {
        if (session.happySessionId === happySessionId) return session;
      }
      return sessionIdToFinishedSession.get(happySessionId);
    };

    const installSessionSnapshot = (snapshot: MachineSessionSnapshot): TrackedSession => {
      const tracked = findTrackedSessionById(snapshot.id) ?? {
        startedBy: 'persisted',
        happySessionId: snapshot.id,
        pid: 0,
      };
      tracked.happySessionId = snapshot.id;
      tracked.happySessionMetadataFromLocalWebhook = snapshot.metadata;
      tracked.encryption = {
        encryptionKey: snapshot.encryptionKey,
        encryptionVariant: snapshot.encryptionVariant,
        seq: snapshot.seq,
        metadataVersion: snapshot.metadataVersion,
        agentStateVersion: snapshot.agentStateVersion,
      };
      sessionIdToFinishedSession.set(snapshot.id, tracked);
      persistSession(snapshot.id, {
        encryptionKey: encodeBase64(snapshot.encryptionKey),
        encryptionVariant: snapshot.encryptionVariant,
        seq: snapshot.seq,
        metadataVersion: snapshot.metadataVersion,
        agentStateVersion: snapshot.agentStateVersion,
        metadata: snapshot.metadata,
        hostPid: tracked.pid > 0 ? tracked.pid : undefined,
        savedAt: Date.now(),
      });
      return tracked;
    };

    const resumeVerifiedSession = async (happySessionId: string, options?: {
      operationId?: string;
      model?: string;
      permissionMode?: string;
      effort?: string;
      dataEncryptionKey?: string;
      skipSnapshotRefresh?: boolean;
    }): Promise<ResumeSessionResult> => {
      try {
        let tracked = findTrackedSessionById(happySessionId);
        let snapshotRefreshed = false;
        if (options?.dataEncryptionKey || !tracked?.encryption) {
          const material = await resolveResumeSessionMaterial({
            sessionId: happySessionId,
            machineId,
            dataEncryptionKey: options?.dataEncryptionKey,
            loadSnapshot: (input) => api.getMachineSessionSnapshot(input),
          });
          if (material.type === 'resumeMaterialRequired') return material;
          if (material.type === 'error') {
            return material.kind === 'unavailable'
              ? { type: 'error', error: 'operationFailed' }
              : { type: 'blocked', reason: 'invalidBinding' };
          }
          tracked = installSessionSnapshot(material.snapshot);
          snapshotRefreshed = true;
        }

        const storedEncryption = tracked.encryption;
        if (!storedEncryption) {
          return { type: 'blocked', reason: 'invalidBinding' };
        }
        if (!options?.skipSnapshotRefresh && !snapshotRefreshed) {
          let snapshot: MachineSessionSnapshot | null;
          try {
            snapshot = await api.getMachineSessionSnapshot({
              sessionId: happySessionId,
              machineId,
              encryptionKey: storedEncryption.encryptionKey,
              encryptionVariant: storedEncryption.encryptionVariant,
            });
          } catch {
            return { type: 'resumeMaterialRequired', sessionId: happySessionId };
          }
          if (!snapshot) {
            return { type: 'blocked', reason: 'invalidBinding' };
          }
          tracked = installSessionSnapshot(snapshot);
        }
        if (!tracked.happySessionMetadataFromLocalWebhook) {
          return { type: 'blocked', reason: 'invalidBinding' };
        }
        const metadata = tracked.happySessionMetadataFromLocalWebhook!;
        const encryption = tracked.encryption!;

        if (
          metadata.flavor === 'codex'
          && metadata.codexSyncVersion === 4
          && metadata.codexThreadId
        ) {
          if (encryption.encryptionVariant !== 'dataKey') {
            return { type: 'blocked', reason: 'invalidBinding' };
          }
          const permissionMode = resolveGatewayPermissionMode(
            options?.permissionMode ?? metadata.permissionMode ?? undefined,
          );
          const requestedModel = options?.model ?? metadata.modelMode ?? undefined;
          const bootstrap = createCodexGatewayResumeBootstrap({
            happySessionId,
            dataEncryptionKey: encodeBase64(encryption.encryptionKey),
            threadId: metadata.codexThreadId,
            cwd: metadata.path,
            model: requestedModel && requestedModel !== 'default'
              ? requestedModel
              : null,
            permissionMode,
            effortLevel: options?.effort ?? metadata.effortLevel ?? null,
          });
          const launched = await resumeCodexGatewayHeadless({
            api,
            operationId: options?.operationId,
            env: buildSessionChildEnvironment(ambientEnvironment, {}),
            bootstrap,
          });
          if (launched.sessionId !== happySessionId) {
            return { type: 'blocked', reason: 'invalidBinding' };
          }
          tracked.startedBy = 'daemon';
          tracked.pid = launched.pid;
          tracked.codexGatewayId = launched.gatewayId;
          pidToTrackedSession.set(launched.pid, tracked);
          sessionIdToFinishedSession.delete(happySessionId);
          return { type: 'success', sessionId: happySessionId };
        }

        return { type: 'blocked', reason: 'invalidBinding' };
      } catch (error) {
        if (error instanceof CodexGatewayResumeBlockedError) {
          return { type: 'blocked', reason: error.reason };
        }
        if (
          error instanceof CodexGatewayControlRequestError
          && error.code === 'threadUnavailable'
        ) {
          return { type: 'blocked', reason: 'threadUnavailable' };
        }
        const outcomeUnknown = isCodexGatewayControlOutcomeUnknown(error);
        logger.debug('[DAEMON RUN] Resume session failed', {
          errorKind: outcomeUnknown ? 'outcomeUnknown' : 'operationFailed',
        });
        return {
          type: 'error',
          error: outcomeUnknown ? 'outcomeUnknown' : 'operationFailed',
        };
      }
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = async (
      sessionId: string,
      expectation?: CodexGatewayStopExpectation,
    ): Promise<StopSessionResult> => {
      logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

      const gateways = await discoverLiveCodexGateways({
        recover: true,
        env: ambientEnvironment,
      });
      const gateway = gateways.find(({ descriptor }) => (
        findCodexGatewayStopBinding(descriptor, sessionId) !== null
      ));
      if (gateway) {
        const binding = findCodexGatewayStopBinding(gateway.descriptor, sessionId)!;
        if (!matchesCodexGatewayStopExpectation(gateway.descriptor, binding, expectation)) {
          logger.debug('[DAEMON RUN] Rejected stale Codex Gateway stop request');
          return {
            outcome: 'unverified',
            message: 'Codex Gateway identity could not be verified',
          };
        }
        try {
          await callCodexGatewayControl({
            descriptor: gateway.descriptor,
            token: gateway.secret.controlToken,
            path: '/stop',
            body: { force: false },
          });
          return { outcome: 'stopped', message: 'Session stopped' };
        } catch (error) {
          logger.debug('[DAEMON RUN] Gateway stop request failed', {
            errorKind: classifySyncV4DiagnosticError(error),
          });
          return { outcome: 'failed', message: 'Codex Gateway control request failed' };
        }
      }

      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return { outcome: 'missing', message: 'Codex Gateway worker is missing' };
    };

    // Handle child process exit — preserve session data for resume
    const onChildExited = (pid: number) => {
      const session = pidToTrackedSession.get(pid);
      if (session?.happySessionId && session.encryption) {
        sessionIdToFinishedSession.set(session.happySessionId, session);
        logger.debug(`[DAEMON RUN] Process PID ${pid} exited, preserved session ${session.happySessionId} for resume`);
      } else {
        logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      }
      pidToTrackedSession.delete(pid);
    };

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession: async (sessionId) => (await stopSession(sessionId)).outcome === 'stopped',
      spawnSession,
      requestShutdown: () => requestShutdown('happy-cli'),
      onHappySessionWebhook
    });

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      serverOrigin: configuration.serverUrl,
      machineRegistrationStatus: 'pending',
      daemonLogPath: logger.logFilePath
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

    // Capture the bundled CLI's mtime at startup so the heartbeat can detect
    // when npm replaces `dist/index.mjs` on disk (= the user ran `npm i -g happy`).
    // We previously compared disk `package.json.version` to our bundled version,
    // but that produced infinite restart loops (#1107) when the manifest version
    // diverged from the bundled version (e.g. `happy-coder@0.13.1` deprecation
    // stub bumped package.json without rebuilding dist). File mtime is a more
    // reliable signal: it only changes when the bundle is actually replaced.
    const bundlePath = join(projectPath(), 'dist', 'index.mjs');
    let initialBundleMtimeMs = 0;
    try {
      initialBundleMtimeMs = statSync(bundlePath).mtimeMs;
    } catch {
      // dist/index.mjs not present (e.g. dev mode via tsx) — skip upgrade detection.
      logger.debug(`[DAEMON RUN] Bundle at ${bundlePath} not found; self-restart on upgrade disabled`);
    }

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    const api = await ApiClient.create(credentials);

    // Get or create machine
    const codexCapabilities = await codexCapabilitiesPromise;
    const machineMetadata = mergeCodexAgentCapabilities(initialMachineMetadata, codexCapabilities);
    let machine = null;
    let shutdownRequestedDuringRegistration = false;
    const shutdownDuringRegistration = resolvesWhenShutdownRequested.then(() => {
      shutdownRequestedDuringRegistration = true;
    });
    let registrationFailureCount = 0;
    while (!machine && !shutdownRequestedDuringRegistration) {
      machine = await api.getOrCreateMachine({
        machineId,
        metadata: machineMetadata,
        daemonState: initialDaemonState
      });
      if (!machine) {
        const retryDelayMs = machineRegistrationRetryDelay(registrationFailureCount);
        registrationFailureCount += 1;
        logger.debug('[DAEMON RUN] Machine registration pending; retrying after relay recovery', {
          retryDelayMs,
        });
        await Promise.race([
          delay(retryDelayMs),
          shutdownDuringRegistration,
        ]);
      }
    }
    if (!machine) {
      await stopControlServer();
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);
      return;
    }
    logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);
    const registeredFileState: DaemonLocallyPersistedState = {
      ...fileState,
      machineRegistrationStatus: 'registered',
    };
    writeDaemonState(registeredFileState);

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);
    const codexThreadHistory = new CodexThreadHistoryService();

    const resumeFailureToOpenResult = (
      result: Exclude<ResumeSessionResult, { type: 'success' }>,
    ): CodexOpenThreadResult => {
      if (result.type === 'resumeMaterialRequired') return result;
      if (result.type === 'blocked') {
        const reason = result.reason;
        return {
          type: 'blocked',
          reason,
          errorMessage: reason === 'threadUnavailable'
            ? 'The selected Codex thread is no longer available on this machine.'
            : reason === 'externalThreadActive'
              ? 'The selected Codex thread is active outside Happy.'
              : reason === 'gatewayRecovering'
                ? 'The previous Happy Gateway is still recovering. Retry after it settles.'
                : 'The Happy session binding could not be verified.',
        };
      }
      return {
        type: 'error',
        errorCode: result.error,
        errorMessage: result.error === 'outcomeUnknown'
          ? 'The Codex operation outcome is not yet known. Retry after the Gateway state refreshes.'
          : 'The Codex thread could not be opened.',
      };
    };

    const codexThreadOpen = new CodexThreadOpenCoordinator({
      inspect: (directory, threadId) => codexThreadHistory.inspect(directory, threadId),
      openExisting: async (request, thread): Promise<CodexOpenThreadResult> => {
        const current = findTrackedSessionById(request.binding.sessionId);
        if (current?.encryption?.encryptionVariant === 'legacy') {
          return {
            type: 'blocked',
            reason: 'legacySession',
            errorMessage: 'This Happy session uses legacy account encryption and cannot transfer resume material to the daemon.',
          };
        }

        let dataKey: Uint8Array;
        if (current?.encryption) {
          dataKey = current.encryption.encryptionKey;
        } else if (request.binding.dataEncryptionKey) {
          dataKey = decodeIndependentSessionKey(request.binding.dataEncryptionKey);
        } else {
          return {
            type: 'resumeMaterialRequired',
            sessionId: request.binding.sessionId,
          };
        }

        let snapshot: MachineSessionSnapshot | null;
        try {
          snapshot = await api.getMachineSessionSnapshot({
            sessionId: request.binding.sessionId,
            machineId,
            encryptionKey: dataKey,
            encryptionVariant: 'dataKey',
          });
        } catch {
          return {
            type: 'error',
            errorCode: 'operationFailed',
            errorMessage: 'The Happy session snapshot is temporarily unavailable.',
          };
        }
        if (!snapshot) {
          return {
            type: 'blocked',
            reason: 'invalidBinding',
            errorMessage: 'The bound Happy session was not found on this machine.',
          };
        }
        if (!snapshot.hasIndependentDataKey) {
          return {
            type: 'blocked',
            reason: 'legacySession',
            errorMessage: 'This Happy session uses legacy account encryption and cannot be resumed from the App.',
          };
        }
        try {
          validateSessionThreadBinding({ machineId, snapshot, thread });
        } catch {
          return {
            type: 'blocked',
            reason: 'invalidBinding',
            errorMessage: 'The Happy session binding is invalid.',
          };
        }

        installSessionSnapshot(snapshot);
        const gatewayInspection = await inspectVerifiedGatewayForSession({
          sessionId: snapshot.id,
          threadId: thread.threadId,
        });
        const launchDecision = resolveCodexBoundThreadLaunchDecision({
          providerStatus: thread.status,
          gatewayState: gatewayInspection.state,
        });
        if (launchDecision === 'existing-active') {
          const reconciled = await resumeVerifiedSession(snapshot.id, {
            operationId: request.operationId,
            model: request.defaults?.modelMode,
            permissionMode: request.defaults?.permissionMode,
            effort: request.defaults?.effortLevel,
            skipSnapshotRefresh: true,
          });
          if (reconciled.type !== 'success') {
            return resumeFailureToOpenResult(reconciled);
          }
          return {
            type: 'success',
            disposition: 'existing-active',
            sessionId: reconciled.sessionId,
          };
        }
        if (launchDecision === 'process-transition') {
          return {
            type: 'blocked',
            reason: 'gatewayRecovering',
            errorMessage: 'The previous Happy process is still shutting down. Retry after it exits.',
          };
        }
        if (launchDecision === 'external-active') {
          return {
            type: 'blocked',
            reason: 'externalThreadActive',
            errorMessage: 'The selected Codex thread is active outside the bound Happy process. Stop it before resuming from the App.',
          };
        }
        const resumed = await resumeVerifiedSession(snapshot.id, {
          operationId: request.operationId,
          model: request.defaults?.modelMode,
          permissionMode: request.defaults?.permissionMode,
          effort: request.defaults?.effortLevel,
          skipSnapshotRefresh: true,
        });
        if (resumed.type !== 'success') {
          return resumeFailureToOpenResult(resumed);
        }
        return {
          type: 'success',
          disposition: 'existing-resumed',
          sessionId: resumed.sessionId,
        };
      },
      createExternal: async (request, thread): Promise<CodexOpenThreadResult> => {
        const dataKey = decodeIndependentSessionKey(request.externalDataEncryptionKey);
        const permissionMode = request.defaults!.permissionMode!;
        const modelMode = request.defaults!.modelMode!;
        const effortLevel = request.defaults!.effortLevel!;
        const { state, metadata } = createSessionMetadata({
          flavor: 'codex',
          machineId,
          cwd: thread.cwd,
          startedBy: 'daemon',
          dangerouslySkipPermissions: permissionMode === 'yolo',
        });
        delete metadata.hostPid;
        metadata.codexThreadId = thread.threadId;
        metadata.codexSyncVersion = 4;
        metadata.permissionMode = permissionMode;
        metadata.modelMode = modelMode;
        metadata.effortLevel = effortLevel;

        const created = await api.getOrCreateSession({
          tag: deriveCodexGatewayResumeSessionTag(dataKey),
          metadata,
          state,
          dataEncryptionKey: dataKey,
        });
        if (!created) {
          return {
            type: 'error',
            errorCode: 'operationFailed',
            errorMessage: 'The Happy session could not be created while the relay is unavailable.',
          };
        }
        const snapshot: MachineSessionSnapshot = {
          ...created,
          active: true,
          archivedAt: null,
          originMachineId: machineId,
          machineDeletedAt: null,
          hasIndependentDataKey: true,
        };
        try {
          validateSessionThreadBinding({ machineId, snapshot, thread });
        } catch {
          return {
            type: 'blocked',
            reason: 'invalidBinding',
            errorMessage: 'The deterministic Happy session binding is invalid.',
          };
        }
        installSessionSnapshot(snapshot);
        const gatewayInspection = await inspectVerifiedGatewayForSession({
          sessionId: snapshot.id,
          threadId: thread.threadId,
        });
        const launchDecision = resolveCodexBoundThreadLaunchDecision({
          providerStatus: thread.status,
          gatewayState: gatewayInspection.state,
        });
        if (launchDecision === 'existing-active') {
          const reconciled = await resumeVerifiedSession(snapshot.id, {
            operationId: request.operationId,
            model: request.defaults?.modelMode,
            permissionMode: request.defaults?.permissionMode,
            effort: request.defaults?.effortLevel,
            skipSnapshotRefresh: true,
          });
          if (reconciled.type !== 'success') {
            return resumeFailureToOpenResult(reconciled);
          }
          return {
            type: 'success',
            disposition: 'existing-active',
            sessionId: reconciled.sessionId,
          };
        }
        if (launchDecision === 'external-active') {
          return {
            type: 'blocked',
            reason: 'externalThreadActive',
            errorMessage: 'The selected Codex thread became active outside Happy before it could be attached.',
          };
        }
        if (launchDecision === 'process-transition') {
          return {
            type: 'blocked',
            reason: 'gatewayRecovering',
            errorMessage: 'The previous Happy process is still shutting down. Retry after it exits.',
          };
        }
        const resumed = await resumeVerifiedSession(snapshot.id, {
          operationId: request.operationId,
          model: request.defaults?.modelMode,
          permissionMode: request.defaults?.permissionMode,
          effort: request.defaults?.effortLevel,
          skipSnapshotRefresh: true,
        });
        if (resumed.type !== 'success') {
          return resumeFailureToOpenResult(resumed);
        }
        return {
          type: 'success',
          disposition: 'created',
          sessionId: resumed.sessionId,
        };
      },
    });

    const resumeSession = async (happySessionId: string, options?: {
      operationId?: string;
      directory?: string;
      threadId?: string;
      model?: string;
      permissionMode?: string;
      effort?: string;
      dataEncryptionKey?: string;
    }): Promise<ResumeSessionResult> => {
      try {
        let directory = options?.directory?.trim() || null;
        let threadId = options?.threadId?.trim() || null;
        if (!directory || !threadId) {
          let tracked = findTrackedSessionById(happySessionId);
          if (!tracked?.happySessionMetadataFromLocalWebhook) {
            const material = await resolveResumeSessionMaterial({
              sessionId: happySessionId,
              machineId,
              dataEncryptionKey: options?.dataEncryptionKey,
              loadSnapshot: (input) => api.getMachineSessionSnapshot(input),
            });
            if (material.type === 'resumeMaterialRequired') return material;
            if (material.type === 'error') {
              return material.kind === 'unavailable'
                ? { type: 'error', error: 'operationFailed' }
                : { type: 'blocked', reason: 'invalidBinding' };
            }
            tracked = installSessionSnapshot(material.snapshot);
          }
          const metadata = tracked.happySessionMetadataFromLocalWebhook;
          directory ??= metadata?.path?.trim() || null;
          threadId ??= metadata?.codexThreadId?.trim() || null;
        }
        if (!directory || !threadId) {
          return { type: 'blocked', reason: 'invalidBinding' };
        }
        const opened = await codexThreadOpen.open({
          directory,
          threadId,
          operationId: options?.operationId,
          binding: {
            sessionId: happySessionId,
            ...(options?.dataEncryptionKey
              ? { dataEncryptionKey: options.dataEncryptionKey }
              : {}),
          },
          defaults: {
            ...(options?.permissionMode ? { permissionMode: options.permissionMode } : {}),
            ...(options?.model ? { modelMode: options.model } : {}),
            ...(options?.effort ? { effortLevel: options.effort } : {}),
          },
        });
        if (opened.type === 'success') {
          return opened.sessionId === happySessionId
            ? { type: 'success', sessionId: opened.sessionId }
            : { type: 'blocked', reason: 'invalidBinding' };
        }
        if (opened.type === 'resumeMaterialRequired') return opened;
        if (opened.type === 'blocked') {
          return {
            type: 'blocked',
            reason: opened.reason === 'legacySession'
              ? 'invalidBinding'
              : opened.reason,
          };
        }
        return { type: 'error', error: opened.errorCode };
      } catch {
        return { type: 'error', error: 'operationFailed' };
      }
    };

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      resumeSession,
      preflightResumeSessions: (request) => preflightResumeSessions(request, {
        machineId,
        loadSnapshot: (input) => api.getMachineSessionSnapshot(input),
        inspectThread: (directory, threadId) => codexThreadHistory.inspect(directory, threadId),
        inspectGateway: (input) => inspectVerifiedGatewayForSession(input),
      }),
      listCodexThreads: (request) => codexThreadHistory.list(request),
      openCodexThread: (request: CodexOpenThreadRequest) => codexThreadOpen.open(request),
      stopSession,
      requestShutdown: () => requestShutdown('happy-app')
    });

    // Connect to server
    apiMachine.connect();
    if (codexCapabilities) {
      apiMachine.updateMachineMetadata((metadata) => mergeCodexAgentCapabilities(
        metadata ?? initialMachineMetadata,
        codexCapabilities,
      )).catch((error) => {
        logger.debug('[DAEMON RUN] Failed to publish Codex model capabilities', error);
      });
    }

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = parseInt(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      await refreshLiveCodexGateways().catch((error) => {
        logger.debug('[DAEMON RUN] Gateway discovery refresh failed', {
          errorKind: classifySyncV4DiagnosticError(error),
        });
      });
      for (const [pid, _] of pidToTrackedSession.entries()) {
        try {
          // Check if process is still alive (signal 0 doesn't kill, just checks)
          process.kill(pid, 0);
        } catch (error) {
          // Process is dead, remove from tracking
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          pidToTrackedSession.delete(pid);
        }
      }

      // Check if daemon needs update by detecting whether `dist/index.mjs` was
      // replaced on disk since the daemon started (npm install rewrites the file).
      // Skip if we never captured an initial mtime (dev mode).
      let bundleReplaced = false;
      if (initialBundleMtimeMs > 0) {
        try {
          const currentMtimeMs = statSync(bundlePath).mtimeMs;
          bundleReplaced = currentMtimeMs !== initialBundleMtimeMs;
        } catch {
          // File temporarily missing (e.g. mid-install) — retry on next heartbeat.
        }
      }
      if (bundleReplaced) {
        // TODO: We probably do not want to keep this in-process self-restart logic long-term.
        // A native service manager would make startup and upgrades much simpler: the CLI would
        // ask the OS to start the latest daemon instead of hand-rolling respawn/kill behavior here.
        logger.debug('[DAEMON RUN] Daemon bundle replaced on disk, handing off to new daemon');

        clearInterval(restartOnStaleVersionAndHeartbeat);

        // Release ownership BEFORE spawning the new daemon. Otherwise the spawned
        // `happy daemon start` reads our still-present daemon.state.json, sees
        // isDaemonRunningForCurrentProfile() === true, and exits —
        // leaving nothing running once we also exit.
        await codexThreadHistory.close();
        apiMachine.shutdown();
        await stopControlServer();
        await cleanupDaemonState();
        await releaseDaemonLock(daemonLockHandle);
        await stopCaffeinate();

        try {
          spawnHappyCLI(['daemon', 'start'], {
            detached: true,
            stdio: 'ignore',
            env: ambientEnvironment,
          });
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to spawn new daemon, this is quite likely to happen during integration tests as we are cleaning out dist/ directory', error);
        }

        process.exit(0);
      }

      // Before wrecklessly overriting the daemon state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const daemonState = await readDaemonState();
      if (daemonState && daemonState.pid !== process.pid) {
        logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.')
        requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.')
      }

      // Heartbeat
      try {
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          serverOrigin: configuration.serverUrl,
          machineRegistrationStatus: 'registered',
          lastHeartbeat: new Date().toLocaleString(),
          daemonLogPath: fileState.daemonLogPath
        };
        writeDaemonState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

      // Update daemon state before shutting down
      await apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      await codexThreadHistory.close();
      apiMachine.shutdown();
      await stopControlServer();
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}
