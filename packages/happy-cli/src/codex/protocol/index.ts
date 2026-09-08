export type { ClientNotification } from './generated/ClientNotification';
import type { ClientRequest as BaselineClientRequest } from './generated/ClientRequest';

// Stable since Codex 0.151.0; keep the generated minimum-version schema intact.
// https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/app-server-protocol/schema/typescript/v2/ThreadRevertParams.ts
export type ThreadRevertParams = { threadId: string; beforeTurnId: string };
export type ClientRequest = BaselineClientRequest | {
    method: 'thread/revert';
    id: BaselineClientRequest['id'];
    params: ThreadRevertParams;
};
export type { InitializeParams } from './generated/InitializeParams';
export type { InitializeResponse } from './generated/InitializeResponse';
export type { JsonValue } from './generated/serde_json/JsonValue';
export type { ServerNotification } from './generated/ServerNotification';
export type { ServerRequest } from './generated/ServerRequest';

export type {
    AgentMessageDeltaNotification,
    AskForApproval,
    AskForApproval as ApprovalPolicy,
    CommandExecutionOutputDeltaNotification,
    CommandExecutionRequestApprovalParams,
    ContextCompactedNotification,
    ErrorNotification,
    FileChangeOutputDeltaNotification,
    FileChangePatchUpdatedNotification,
    FileChangeRequestApprovalParams,
    ItemCompletedNotification,
    ItemStartedNotification,
    McpToolCallProgressNotification,
    ListMcpServerStatusParams,
    ListMcpServerStatusResponse,
    McpServerElicitationRequestResponse,
    Model,
    ModelListParams,
    ModelListResponse,
    PlanDeltaNotification,
    PermissionsRequestApprovalParams,
    PermissionsRequestApprovalResponse,
    ReasoningSummaryPartAddedNotification,
    ReasoningSummaryTextDeltaNotification,
    ReasoningTextDeltaNotification,
    ReviewStartParams,
    ReviewStartResponse,
    SandboxMode,
    SandboxPolicy,
    SkillsListParams,
    SkillsListResponse,
    Thread,
    ThreadCompactStartParams,
    ThreadCompactStartResponse,
    ThreadForkParams,
    ThreadForkResponse,
    ThreadGoal,
    ThreadGoalClearParams,
    ThreadGoalClearResponse,
    ThreadGoalGetParams,
    ThreadGoalGetResponse,
    ThreadGoalSetParams,
    ThreadGoalSetResponse,
    ThreadInjectItemsParams,
    ThreadInjectItemsResponse,
    ThreadItem,
    ThreadListParams,
    ThreadListResponse,
    ThreadReadParams,
    ThreadReadResponse,
    ThreadResumeParams,
    ThreadResumeResponse,
    ThreadRollbackParams,
    ThreadRollbackResponse,
    ThreadStartParams,
    ThreadStartResponse,
    ThreadStatus,
    ThreadSourceKind,
    ThreadStatusChangedNotification,
    ThreadTokenUsageUpdatedNotification,
    ToolRequestUserInputParams,
    ToolRequestUserInputResponse,
    Turn,
    TurnCompletedNotification,
    TurnDiffUpdatedNotification,
    TurnInterruptParams,
    TurnInterruptResponse,
    TurnPlanUpdatedNotification,
    TurnStartParams,
    TurnStartResponse,
    TurnStartedNotification,
    TurnStatus,
    TurnSteerParams,
    TurnSteerResponse,
    UserInput,
    UserInput as InputItem,
    WarningNotification,
} from './generated/v2';

export type { CollaborationMode } from './generated/CollaborationMode';
export type { ReasoningEffort } from './generated/ReasoningEffort';
export type { ReasoningSummary } from './generated/ReasoningSummary';
