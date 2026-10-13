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
  CtrlYokeMcpMode,
  PermissionMode,
} from "./DashboardConstants";
import type { PriorContextDetail } from "./DashboardConstants";

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
  /** Internal marker for skill-mode ctrlyoke-MCP replacement behavior. */
  ctrlyokeMcpMode?: CtrlYokeMcpMode;
  agent?: string;
  skills?: string[];
  secrets?: string[];
  resumeSession: boolean;
  mcpServers: (string | McpServerConfig)[] | null;
  hooks: UserHookConfig[] | null;
  sessionId?: string | number;
  endCondition?: EndCondition;
  preCondition?: PreCondition;
  priorContext?: PriorContext;
  priorContextDetail?: PriorContextDetail;
  additionalArgs?: string;
  toolPermissions: ToolPermissionConfig | null;
  errorBehavior?: ErrorBehavior;
}
