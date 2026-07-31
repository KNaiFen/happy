import axios from 'axios'
import { logger } from '@/ui/logger'
import type { AgentState, CreateSessionResponse, Metadata, Session, Machine, MachineMetadata, DaemonState } from '@/api/types'
import { ApiSessionClient } from './apiSession';
import { ApiMachineClient } from './apiMachine';
import {
  decodeBase64,
  encodeBase64,
  getRandomBytes,
  encrypt,
  decrypt,
  libsodiumEncryptForPublicKey,
  libsodiumPublicKeyFromSecretKey,
} from './encryption';
import { PushNotificationClient } from './pushNotifications';
import { configuration } from '@/configuration';
import chalk from 'chalk';
import { Credentials } from '@/persistence';
import { connectionState, isNetworkError } from '@/utils/serverConnectionErrors';
import { deriveKey } from '@/utils/deriveKey';
import {
  classifySyncV4DiagnosticError,
  isSyncV4VersionAtLeast,
  recordSyncV4DiagnosticSafely,
  requireSyncV4TraceEcho,
  requireSyncV4TraceId,
  SyncV4CapabilitiesSchema,
  type SyncV4DiagnosticInput,
  type SyncV4DiagnosticSink,
} from '@slopus/happy-wire';
import { syncV4DiagnosticHash } from './syncV4Diagnostics';

function safeAxiosStatus(error: unknown): number | undefined {
  try {
    if (!axios.isAxiosError(error)) return undefined;
    const status = error.response?.status;
    return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : undefined;
  } catch {
    return undefined;
  }
}

export class CodexSyncV4CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSyncV4CapabilityError';
  }
}

export class HappyRelayAuthenticationError extends Error {
  constructor(operation: string) {
    super(
      `${operation} was rejected by ${configuration.serverUrl}. `
      + 'Run `happy auth login --force` for the configured relay.',
    );
    this.name = 'HappyRelayAuthenticationError';
  }
}

export class ApiClient {

  static async create(credential: Credentials) {
    return new ApiClient(credential);
  }

  private readonly credential: Credentials;
  private readonly pushClient: PushNotificationClient;

  private constructor(credential: Credentials) {
    this.credential = credential
    this.pushClient = new PushNotificationClient(credential.token, configuration.serverUrl)
  }

  async isCodexSyncV4Enabled(
    codexCliVersion: string,
    traceId?: string,
    diagnostics?: SyncV4DiagnosticSink,
  ): Promise<boolean> {
    if (traceId !== undefined) requireSyncV4TraceId(traceId);
    const startedAt = Date.now();
    const recordCapability = (
      input: Omit<
        SyncV4DiagnosticInput,
        'codexVersion' | 'component' | 'event' | 'protocolVersion'
        | 'softwareVersion' | 'traceId' | 'transportOperation' | 'level'
      > & { level?: SyncV4DiagnosticInput['level'] },
    ) => {
      const { level = 'debug', ...details } = input;
      recordSyncV4DiagnosticSafely(diagnostics, {
        level,
        component: 'cli.sync',
        event: 'transport',
        traceId,
        transportOperation: 'capabilities',
        softwareVersion: configuration.currentCliVersion,
        codexVersion: codexCliVersion,
        protocolVersion: 4,
        transportSecurity: syncV4TransportSecurity(),
        ...details,
      });
    };
    recordCapability({
      phase: 'started',
      direction: 'inbound',
    });
    let response;
    try {
      response = await axios.get(`${configuration.serverUrl}/v4/capabilities`, {
        headers: {
          'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
          ...(traceId ? { 'X-Happy-Sync-Trace': traceId } : {}),
        },
        timeout: 10_000,
      });
    } catch (error) {
      const httpStatus = safeAxiosStatus(error);
      if (httpStatus === 404) {
        recordCapability({
          phase: 'completed',
          direction: 'inbound',
          state: 'stopped',
          featureEnabled: false,
          httpStatus: 404,
          durationMs: Math.max(0, Math.trunc(Date.now() - startedAt)),
        });
        logger.debug('[API] Sync v4 capability endpoint absent; using retained Codex v3 rollback adapter');
        return false;
      }
      recordCapability({
        level: 'warn',
        phase: 'failed',
        direction: 'inbound',
        errorKind: classifySyncV4DiagnosticError(error),
        ...(httpStatus === undefined ? {} : { httpStatus }),
        durationMs: Math.max(0, Math.trunc(Date.now() - startedAt)),
      });
      throw new CodexSyncV4CapabilityError(
        'Cannot verify Codex Sync v4 compatibility because the Happy Server is unavailable. Codex was not started to avoid an unsafe v3 fallback.',
      );
    }

    try {
      requireSyncV4TraceEcho(traceId, safeAxiosTraceHeader(response));
    } catch {
      recordCapability({
        level: 'warn',
        phase: 'failed',
        direction: 'inbound',
        httpStatus: response.status ?? 200,
        errorKind: 'protocol',
        durationMs: Math.max(0, Math.trunc(Date.now() - startedAt)),
      });
      throw new CodexSyncV4CapabilityError(
        'Happy Server did not return the expected Sync v4 trace header. Codex was not started because the relay response could not be correlated.',
      );
    }

    const parsed = SyncV4CapabilitiesSchema.safeParse(response.data);
    if (!parsed.success) {
      recordCapability({
        level: 'warn',
        phase: 'failed',
        direction: 'inbound',
        httpStatus: response.status ?? 200,
        errorKind: 'validation',
        durationMs: Math.max(0, Math.trunc(Date.now() - startedAt)),
      });
      throw new CodexSyncV4CapabilityError(
        'Happy Server returned an invalid Codex Sync v4 capability response. Update the Server before starting Codex.',
      );
    }

    const capability = parsed.data.codex;
    if (!capability.enabled) {
      recordCapability({
        phase: 'completed',
        direction: 'inbound',
        state: 'stopped',
        featureEnabled: false,
        httpStatus: response.status ?? 200,
        durationMs: Math.max(0, Math.trunc(Date.now() - startedAt)),
      });
      return false;
    }
    if (!isSyncV4VersionAtLeast(configuration.currentCliVersion, capability.minimumHappyCliVersion)) {
      recordCapability({
        level: 'warn',
        phase: 'failed',
        direction: 'inbound',
        httpStatus: response.status ?? 200,
        errorKind: 'protocol',
        durationMs: Math.max(0, Math.trunc(Date.now() - startedAt)),
      });
      throw new CodexSyncV4CapabilityError(
        `Happy CLI ${capability.minimumHappyCliVersion} or newer is required for Codex Sync v4; found ${configuration.currentCliVersion}.`,
      );
    }
    if (!isSyncV4VersionAtLeast(codexCliVersion, capability.minimumCodexCliVersion)) {
      recordCapability({
        level: 'warn',
        phase: 'failed',
        direction: 'inbound',
        httpStatus: response.status ?? 200,
        errorKind: 'protocol',
        durationMs: Math.max(0, Math.trunc(Date.now() - startedAt)),
      });
      throw new CodexSyncV4CapabilityError(
        `Codex CLI ${capability.minimumCodexCliVersion} or newer is required by Happy Server; found ${codexCliVersion}.`,
      );
    }
    recordCapability({
      phase: 'completed',
      direction: 'inbound',
      state: 'ready',
      featureEnabled: true,
      httpStatus: response.status ?? 200,
      durationMs: Math.max(0, Math.trunc(Date.now() - startedAt)),
    });
    return true;
  }

  /**
   * Create a new session or load existing one with the given tag
   */
  async getOrCreateSession(opts: {
    tag: string,
    metadata: Metadata,
    state: AgentState | null,
    /** Stable per-session key used by recoverable child sessions. */
    dataEncryptionKey?: Uint8Array,
  }): Promise<Session | null> {

    // Resolve encryption key
    let dataEncryptionKey: Uint8Array | null = null;
    let encryptionKey: Uint8Array;
    let encryptionVariant: 'legacy' | 'dataKey';
    if (opts.dataEncryptionKey) {
      encryptionKey = new Uint8Array(opts.dataEncryptionKey);
      encryptionVariant = 'dataKey';
      const recipientPublicKey = this.credential.encryption.type === 'dataKey'
        ? this.credential.encryption.publicKey
        : libsodiumPublicKeyFromSecretKey(
          await deriveKey(this.credential.encryption.secret, 'Happy EnCoder', ['content'])
        );
      const encryptedDataKey = libsodiumEncryptForPublicKey(encryptionKey, recipientPublicKey);
      dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
      dataEncryptionKey.set([0], 0);
      dataEncryptionKey.set(encryptedDataKey, 1);
    } else if (this.credential.encryption.type === 'dataKey') {

      // Generate new encryption key
      encryptionKey = getRandomBytes(32);
      encryptionVariant = 'dataKey';

      // Derive and encrypt data encryption key
      // const contentDataKey = await deriveKey(this.secret, 'Happy EnCoder', ['content']);
      // const publicKey = libsodiumPublicKeyFromSecretKey(contentDataKey);
      let encryptedDataKey = libsodiumEncryptForPublicKey(encryptionKey, this.credential.encryption.publicKey);
      dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
      dataEncryptionKey.set([0], 0); // Version byte
      dataEncryptionKey.set(encryptedDataKey, 1); // Data key
    } else {
      encryptionKey = this.credential.encryption.secret;
      encryptionVariant = 'legacy';
    }

    // Create session
    try {
      const response = await axios.post<CreateSessionResponse>(
        `${configuration.serverUrl}/v1/sessions`,
        {
          tag: opts.tag,
          metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
          agentState: opts.state ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.state)) : null,
          dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : null,
          machineId: opts.metadata.machineId,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
          },
          timeout: 60000 // 1 minute timeout for very bad network connections
        }
      )

      logger.debug('[API] Session created/loaded', {
        sessionHash: syncV4DiagnosticHash(response.data.session.id),
        tagHash: syncV4DiagnosticHash(opts.tag),
      })
      let raw = response.data.session;
      let session: Session = {
        id: raw.id,
        seq: raw.seq,
        metadata: decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)),
        metadataVersion: raw.metadataVersion,
        agentState: raw.agentState ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.agentState)) : null,
        agentStateVersion: raw.agentStateVersion,
        encryptionKey: encryptionKey,
        encryptionVariant: encryptionVariant
      }
      return session;
    } catch (error) {
      logger.debug('[API] Failed to get or create session', {
        errorKind: classifySyncV4DiagnosticError(error),
        httpStatus: safeAxiosStatus(error),
      });
      if (safeAxiosStatus(error) === 401) {
        throw new HappyRelayAuthenticationError('Session creation');
      }

      // Check if it's a connection error
      if (error && typeof error === 'object' && 'code' in error) {
        const errorCode = (error as any).code;
        if (isNetworkError(errorCode)) {
          connectionState.fail({
            operation: 'Session creation',
            caller: 'api.getOrCreateSession',
            errorCode,
            url: `${configuration.serverUrl}/v1/sessions`
          });
          return null;
        }
      }

      // Handle 404 gracefully - server endpoint may not be available yet
      const is404Error = (
        (axios.isAxiosError(error) && error.response?.status === 404) ||
        (error && typeof error === 'object' && 'response' in error && (error as any).response?.status === 404)
      );
      if (is404Error) {
        connectionState.fail({
          operation: 'Session creation',
          errorCode: '404',
          url: `${configuration.serverUrl}/v1/sessions`
        });
        return null;
      }

      // Handle 5xx server errors - use offline mode with auto-reconnect
      if (axios.isAxiosError(error) && error.response?.status) {
        const status = error.response.status;
        if (status >= 500) {
          connectionState.fail({
            operation: 'Session creation',
            errorCode: String(status),
            url: `${configuration.serverUrl}/v1/sessions`,
            details: ['Server encountered an error, will retry automatically']
          });
          return null;
        }
      }

      throw new Error(`Failed to get or create session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async unarchiveSession(sessionId: string): Promise<boolean> {
    const url = `${configuration.serverUrl}/v4/sessions/${encodeURIComponent(sessionId)}/unarchive`;
    try {
      await axios.post(
        url,
        {},
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
          },
          timeout: 60_000,
        },
      );
      logger.debug('[API] Session unarchived', {
        sessionHash: syncV4DiagnosticHash(sessionId),
      });
      return true;
    } catch (error) {
      const status = safeAxiosStatus(error);
      logger.debug('[API] Failed to unarchive session', {
        sessionHash: syncV4DiagnosticHash(sessionId),
        errorKind: classifySyncV4DiagnosticError(error),
        httpStatus: status,
      });
      if (status === 401) throw new HappyRelayAuthenticationError('Session unarchive');
      if (
        (error && typeof error === 'object' && 'code' in error
          && isNetworkError(typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : undefined))
        || (status !== undefined && status >= 500)
      ) {
        connectionState.fail({
          operation: 'Session unarchive',
          caller: 'api.unarchiveSession',
          errorCode: status === undefined
            ? String((error as { code?: unknown }).code ?? 'NETWORK_ERROR')
            : String(status),
          url,
        });
        return false;
      }
      throw new Error(
        `Failed to unarchive session (${status ?? 'unknown'}): `
        + `${error instanceof Error ? error.message : 'relay rejected the request'}`,
      );
    }
  }

  /**
   * Register or update machine with the server
   * Returns the current machine state from the server with decrypted metadata and daemonState
   */
  async getOrCreateMachine(opts: {
    machineId: string,
    metadata: MachineMetadata,
    daemonState?: DaemonState,
  }): Promise<Machine | null> {

    // Resolve encryption key
    let dataEncryptionKey: Uint8Array | null = null;
    let encryptionKey: Uint8Array;
    let encryptionVariant: 'legacy' | 'dataKey';
    if (this.credential.encryption.type === 'dataKey') {
      // Encrypt data encryption key
      encryptionVariant = 'dataKey';
      encryptionKey = this.credential.encryption.machineKey;
      let encryptedDataKey = libsodiumEncryptForPublicKey(this.credential.encryption.machineKey, this.credential.encryption.publicKey);
      dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
      dataEncryptionKey.set([0], 0); // Version byte
      dataEncryptionKey.set(encryptedDataKey, 1); // Data key
    } else {
      // Legacy encryption
      encryptionKey = this.credential.encryption.secret;
      encryptionVariant = 'legacy';
    }

    // Create machine
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/machines`,
        {
          id: opts.machineId,
          metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
          daemonState: opts.daemonState ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.daemonState)) : undefined,
          dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : undefined
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
          },
          timeout: 60000 // 1 minute timeout for very bad network connections
        }
      );


      const raw = response.data.machine;
      logger.debug('[API] Machine registered/updated with server', {
        machineHash: syncV4DiagnosticHash(opts.machineId),
      });

      // Return decrypted machine like we do for sessions
      const machine: Machine = {
        id: raw.id,
        encryptionKey: encryptionKey,
        encryptionVariant: encryptionVariant,
        metadata: raw.metadata ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)) : null,
        metadataVersion: raw.metadataVersion || 0,
        daemonState: raw.daemonState ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.daemonState)) : null,
        daemonStateVersion: raw.daemonStateVersion || 0,
      };
      return machine;
    } catch (error) {
      // Handle connection errors gracefully
      if (axios.isAxiosError(error) && error.code && isNetworkError(error.code)) {
        connectionState.fail({
          operation: 'Machine registration',
          caller: 'api.getOrCreateMachine',
          errorCode: error.code,
          url: `${configuration.serverUrl}/v1/machines`
        });
        return null;
      }

      // Handle 403/409 - server rejected request due to authorization conflict
      // This is NOT "server unreachable" - server responded, so don't use connectionState
      if (axios.isAxiosError(error) && error.response?.status) {
        const status = error.response.status;

        if (status === 401) {
          throw new HappyRelayAuthenticationError('Machine registration');
        }

        if (status === 403 || status === 409) {
          // Re-auth conflict: machine registered to old account, re-association not allowed
          console.log(chalk.yellow(
            `⚠️  Machine registration rejected by the server with status ${status}`
          ));
          console.log(chalk.yellow(
            `   → This machine ID is already registered to another account on the server`
          ));
          console.log(chalk.yellow(
            `   → This usually happens after re-authenticating with a different account`
          ));
          console.log(chalk.yellow(
            `   → Run 'happy doctor clean' to reset local state and generate a new machine ID`
          ));
          console.log(chalk.yellow(
            `   → Open a GitHub issue if this problem persists`
          ));
          throw new Error(`Machine registration was rejected with status ${status}`);
        }

        // Handle 5xx - server error, use offline mode with auto-reconnect
        if (status >= 500) {
          connectionState.fail({
            operation: 'Machine registration',
            errorCode: String(status),
            url: `${configuration.serverUrl}/v1/machines`,
            details: ['Server encountered an error, will retry automatically']
          });
          return null;
        }

        // Handle 404 - endpoint may not be available yet
        if (status === 404) {
          connectionState.fail({
            operation: 'Machine registration',
            errorCode: '404',
            url: `${configuration.serverUrl}/v1/machines`
          });
          return null;
        }
      }

      // For other errors, rethrow
      throw error;
    }
  }

  sessionSyncClient(session: Session): ApiSessionClient {
    return new ApiSessionClient(this.credential.token, session);
  }

  machineSyncClient(machine: Machine): ApiMachineClient {
    return new ApiMachineClient(this.credential.token, machine);
  }

  push(): PushNotificationClient {
    return this.pushClient;
  }

  /**
   * Register a vendor API token with the server
   * The token is sent as a JSON string - server handles encryption
   */
  async registerVendorToken(vendor: 'openai' | 'anthropic' | 'gemini', apiKey: any): Promise<void> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/connect/${vendor}/register`,
        {
          token: JSON.stringify(apiKey)
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
          },
          timeout: 5000
        }
      );

      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Server returned status ${response.status}`);
      }

      logger.debug(`[API] Vendor token for ${vendor} registered successfully`);
    } catch (error) {
      logger.debug('[API] Failed to register vendor token', {
        vendor,
        errorKind: classifySyncV4DiagnosticError(error),
        httpStatus: safeAxiosStatus(error),
      });
      throw new Error(`Failed to register vendor token: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get vendor API token from the server
   * Returns the token if it exists, null otherwise
   */
  async getVendorToken(vendor: 'openai' | 'anthropic' | 'gemini'): Promise<any | null> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/connect/${vendor}/token`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
          },
          timeout: 5000
        }
      );

      if (response.status === 404) {
        logger.debug(`[API] No vendor token found for ${vendor}`);
        return null;
      }

      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }

      logger.debug('[API] Vendor token response received', {
        vendor,
        status: response.status,
        hasToken: 'token' in (response.data || {}),
        tokenType: typeof response.data?.token,
      });

      // Token is returned as JSON string, parse it
      let tokenData: any = null;
      if (response.data?.token) {
        if (typeof response.data.token === 'string') {
          try {
            tokenData = JSON.parse(response.data.token);
          } catch (parseError) {
            logger.debug('[API] Failed to parse vendor token as JSON; using string value', {
              vendor,
              errorKind: classifySyncV4DiagnosticError(parseError),
            });
            tokenData = response.data.token;
          }
        } else if (response.data.token !== null) {
          // Token exists and is not null
          tokenData = response.data.token;
        } else {
          // Token is explicitly null - treat as not found
          logger.debug(`[API] Token is null for ${vendor}, treating as not found`);
          return null;
        }
      } else if (response.data && typeof response.data === 'object') {
        // Maybe the token is directly in response.data
        // But check if it's { token: null } - treat as not found
        if (response.data.token === null && Object.keys(response.data).length === 1) {
          logger.debug(`[API] Response contains only null token for ${vendor}, treating as not found`);
          return null;
        }
        tokenData = response.data;
      }
      
      // Final check: if tokenData is null or { token: null }, return null
      if (tokenData === null || (tokenData && typeof tokenData === 'object' && tokenData.token === null && Object.keys(tokenData).length === 1)) {
        logger.debug(`[API] Token data is null for ${vendor}`);
        return null;
      }
      
      logger.debug('[API] Vendor token retrieved successfully', {
        vendor,
        tokenDataType: typeof tokenData,
        tokenDataIsArray: Array.isArray(tokenData),
      });
      return tokenData;
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.debug(`[API] No vendor token found for ${vendor}`);
        return null;
      }
      logger.debug('[API] Failed to get vendor token', {
        vendor,
        errorKind: classifySyncV4DiagnosticError(error),
        httpStatus: safeAxiosStatus(error),
      });
      return null;
    }
  }

  /**
   * Mark a legacy v3 session inactive during graceful shutdown. This endpoint
   * intentionally does not create the Codex v4 archive tombstone.
   */
  async deactivateSession(sessionId: string): Promise<boolean> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}/archive`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
          },
          timeout: 3000,
        },
      );
      return response.status >= 200 && response.status < 300;
    } catch (error) {
      logger.debug('[API] deactivateSession failed', {
        errorKind: classifySyncV4DiagnosticError(error),
        httpStatus: safeAxiosStatus(error),
      });
      return false;
    }
  }
}

function safeAxiosTraceHeader(response: unknown): string | undefined {
  try {
    if (!response || typeof response !== 'object') return undefined;
    const headers = (response as { headers?: unknown }).headers;
    if (!headers || typeof headers !== 'object') return undefined;
    const get = (headers as { get?: unknown }).get;
    if (typeof get === 'function') {
      const value = get.call(headers, 'X-Happy-Sync-Trace');
      return typeof value === 'string' ? value : undefined;
    }
    const record = headers as Record<string, unknown>;
    const value = record['x-happy-sync-trace'] ?? record['X-Happy-Sync-Trace'];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function syncV4TransportSecurity(): 'https' | 'insecureHttp' {
  try {
    return new URL(configuration.serverUrl).protocol === 'http:' ? 'insecureHttp' : 'https';
  } catch {
    return 'https';
  }
}
