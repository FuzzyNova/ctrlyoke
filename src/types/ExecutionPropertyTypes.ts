import type {
  EndCondition,
  ErrorBehavior,
  McpServerConfig,
  PreCondition,
  PriorContext,
  UserHookConfig,
} from "./CtrlYokeTypes";
import type {
  ExecutionMode,
  HarnessId,
  PermissionMode,
} from "./DashboardConstants";

/** Unified permission mode used by harness adapters and authored workflows. */
export type ToolPermissionMode = PermissionMode;

/** Resolved permission configuration passed to a harness adapter. */
export interface ToolPermissionConfig {
  mode: ToolPermissionMode;
  allowedTools: string[];
  deniedTools: string[];
}

/** Execution properties after prompt/workflow/default resolution. */
export interface ResolvedProperties {
  harness: HarnessId;
  model: string;
  executionMode: ExecutionMode;
  agent?: string;
  skills?: string[];
  resumeSession: boolean;
  mcpServers: (string | McpServerConfig)[] | null;
  hooks: UserHookConfig[] | null;
  sessionId?: string | number;
  endCondition?: EndCondition;
  preCondition?: PreCondition;
  priorContext?: PriorContext;
  additionalArgs?: string;
  toolPermissions: ToolPermissionConfig | null;
  errorBehavior?: ErrorBehavior;
}
