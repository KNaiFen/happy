import { z } from 'zod'
import type { SyncInvalidationV4, Update, UpdateMachineBody } from '@slopus/happy-wire';
import type { SandboxConfig } from '@/persistence'

export {
  UpdateMachineBodySchema,
  UpdateSchema,
  UpdateSessionBodySchema,
} from '@slopus/happy-wire';
export type {
  Update,
  UpdateMachineBody,
  UpdateSessionBody,
} from '@slopus/happy-wire';

/** Permission modes recognized by the Codex execution-policy mapper. */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo'

/**
 * Socket events from server to client
 */
export interface ServerToClientEvents {
  update: (data: Update) => void
  'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void
  'rpc-registered': (data: { method: string }) => void
  'rpc-unregistered': (data: { method: string }) => void
  'rpc-error': (data: { type: string, error: string }) => void
  ephemeral: (data:
    | { type: 'activity', id: string, active: boolean, activeAt: number, thinking: boolean, archivedAt?: number | null }
    | ({ type: 'sync-v4-invalidate' } & SyncInvalidationV4)
  ) => void
  auth: (data: { success: boolean, user: string }) => void
  error: (data: { message: string }) => void
}


/**
 * Socket events from client to server
 */
export interface ClientToServerEvents {
  'update-metadata': (data: { sid: string, expectedVersion: number, metadata: string }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    metadata: string
  } | {
    result: 'success',
    version: number,
    metadata: string
  }) => void) => void,
  'ping': (callback: () => void) => void
  'rpc-register': (data: { method: string }) => void
  'rpc-unregister': (data: { method: string }) => void
  'rpc-call': (data: { method: string, params: string }, callback: (response: {
    ok: boolean
    result?: string
    error?: string
  }) => void) => void
}

/**
 * Session information
 */
export type Session = {
  id: string,
  seq: number,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: Metadata,
  metadataVersion: number,
  agentState: AgentState | null,
  agentStateVersion: number,
}

export type MachineSessionSnapshot = Session & {
  active: boolean;
  archivedAt: number | null;
  originMachineId: string | null;
  machineDeletedAt: number | null;
  hasIndependentDataKey: boolean;
}

export const CodexModelCapabilitySchema = z.object({
  code: z.string(),
  value: z.string(),
  description: z.string().nullish(),
  thinkingLevels: z.array(z.string()),
  defaultThinkingLevel: z.string(),
  isDefault: z.boolean(),
})

export type CodexModelCapability = z.infer<typeof CodexModelCapabilitySchema>

export const CodexAgentCapabilitiesSchema = z.object({
  codexCliVersion: z.string(),
  detectedAt: z.number(),
  models: z.array(CodexModelCapabilitySchema),
})

export type CodexAgentCapabilities = z.infer<typeof CodexAgentCapabilitiesSchema>

/**
 * Machine metadata - static information (rarely changes)
 */
export const MachineMetadataSchema = z.object({
  host: z.string(),
  platform: z.string(),
  happyCliVersion: z.string(),
  homeDir: z.string(),
  happyHomeDir: z.string(),
  happyLibDir: z.string(),
  cliAvailability: z.object({
    codex: z.boolean(),
    detectedAt: z.number(),
  }).passthrough().optional(),
  resumeSupport: z.object({
    rpcAvailable: z.boolean(),
    codexThreadHistoryRpcAvailable: z.boolean().optional(),
    requiresSameMachine: z.boolean(),
    detectedAt: z.number(),
  }).optional(),
  agentCapabilities: z.object({
    codex: CodexAgentCapabilitiesSchema.optional(),
  }).optional(),
}).passthrough()

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

/**
 * Daemon state - dynamic runtime information (frequently updated)
 */
export const DaemonStateSchema = z.object({
  status: z.union([
    z.enum(['running', 'shutting-down']),
    z.string() // Forward compatibility
  ]),
  pid: z.number().optional(),
  httpPort: z.number().optional(),
  startedAt: z.number().optional(),
  shutdownRequestedAt: z.number().optional(),
  shutdownSource:
    z.union([
      z.enum(['mobile-app', 'cli', 'os-signal', 'unknown']),
      z.string() // Forward compatibility
    ]).optional()
})

export type DaemonState = z.infer<typeof DaemonStateSchema>

export type Machine = {
  id: string,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: MachineMetadata,
  metadataVersion: number,
  daemonState: DaemonState | null,
  daemonStateVersion: number,
}

/**
 * API response types
 */
export const CreateSessionResponseSchema = z.object({
  session: z.object({
    id: z.string(),
    tag: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    metadata: z.string(),
    metadataVersion: z.number(),
    agentState: z.string().nullable(),
    agentStateVersion: z.number()
  })
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export type CodexGatewayBindingMetadata = {
  gatewayId: string
  generation: number
  origin: 'terminal' | 'app'
  role: 'current' | 'draining' | 'inactive' | 'recovering'
  terminal: 'attached' | 'unattached'
  previousSessionId?: string
  nextSessionId?: string
  changedAt: number
}

export type Metadata = {
  models?: Array<{
    code: string;
    value: string;
    description?: string | null;
    thinkingLevels?: string[];
    defaultThinkingLevel?: string;
    isDefault?: boolean;
  }>,
  currentModelCode?: string,
  path: string,
  host: string,
  version?: string,
  name?: string,
  os?: string,
  summary?: {
    text: string,
    updatedAt: number
  },
  machineId?: string,
  gitBranch?: string,
  codexThreadId?: string, // Codex app-server thread ID
  /** Session-level Codex launch choices preserved across daemon resume. */
  permissionMode?: string | null,
  modelMode?: string | null,
  effortLevel?: string | null,
  /** Canonical encrypted transport selected for this Codex session. */
  codexSyncVersion?: 4,
  /** Encrypted root-session ownership for a persistent native Codex Gateway. */
  codexGatewayBinding?: CodexGatewayBindingMetadata,
  tools?: string[],
  slashCommands?: string[],
  mcpServers?: Array<{ name: string; status: string }>,
  skills?: string[],
  homeDir: string,
  happyHomeDir: string,
  happyLibDir: string,
  happyToolsDir: string,
  startedFromDaemon?: boolean,
  hostPid?: number,
  startedBy?: 'daemon' | 'terminal',
  flavor?: string
  codexCapabilities?: {
    queueSteering?: boolean
  }
  sandbox?: SandboxConfig | null
  dangerouslySkipPermissions?: boolean | null
  /** Lineage for sessions created via the fork / duplicate flow. */
  parentSessionId?: string
  forkedFromMessageId?: string
  /**
   * Marks a session as a hidden "side chat" forked from `parentSessionId`.
   * Side chats never appear in the top-level session list; they render only
   * inside the parent session's sidebar panel.
   */
  isSideChat?: boolean
  /** Provider-created Codex child session; direct prompts and control commands are disabled. */
  codexReadOnly?: boolean
};

export type UsageLimitWindowStatus = 'allowed' | 'allowed_warning' | 'rejected'

export type UsageLimitWindow = {
  /** Stable machine key, e.g. 'five_hour' / 'seven_day'. */
  id: string,
  label?: string,
  status?: UsageLimitWindowStatus,
  /** Percent of the window used, 0-100. */
  utilization?: number | null,
  /** Epoch milliseconds when the window resets. */
  resetsAt?: number | null,
}

export type UsageLimits = {
  capturedAt: number,
  windows: UsageLimitWindow[],
}

export type AgentGoalStatus = {
  source: 'codex',
  observedAt: number,
  sourceSessionId?: string,
  sourceRevision?: string | number,
} & (
  | {
      status: 'unavailable',
      reason?: 'unsupported' | 'not_loaded' | 'stale' | 'malformed' | 'error' | 'unknown',
    }
  | {
      status: 'inactive',
      reason?: 'none' | 'cleared' | 'completed' | 'unknown',
    }
  | {
      status: 'active',
      sourceSessionId: string,
      text: string,
      capabilities?: {
        clear?: boolean,
        stop?: boolean,
        edit?: boolean,
      },
      progress?: {
        currentStep?: number,
        totalSteps?: number,
        steps?: Array<{
          text: string,
          status: 'pending' | 'in_progress' | 'completed',
        }>,
      },
    }
);

export type AgentState = {
  controlledByUser?: boolean | null | undefined
  /**
   * Ephemeral plan rate-limit windows reported by the agent backend.
   * Apps must tolerate window ids they don't recognize.
   */
  usageLimits?: UsageLimits
  requests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number,
      // Raw provider tool-use id when the request id is scoped; the app joins
      // the permission card to its tool call through this.
      toolUseId?: string
    }
  }
  completedRequests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number,
      completedAt: number,
      status: 'canceled' | 'denied' | 'approved',
      reason?: string,
      mode?: PermissionMode,
      decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
      allowTools?: string[],
      toolUseId?: string
    }
  }
  agentGoalStatus?: AgentGoalStatus
}
