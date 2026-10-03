import { TRUST_DECISIONS } from "../types/DashboardConstants";
import { McpRegistryFileManager } from "../utils/McpRegistryFileManager";
import {
  configService,
  type WorkspaceSensitiveSettingState,
} from "./CtrlYokeConfigService";
import {
  workspaceSensitiveSettingRequestKey,
  type WorkspaceSensitiveSettingRequest,
} from "./WorkspaceSensitiveSettings";
import {
  WorkspaceSettingsTrustStore,
  workspaceSettingsTrustStore,
} from "./WorkspaceSettingsTrustStore";

/**
 * Every value this workspace requests that can choose a program to run —
 * from `.ctrlyoke/settings.json` and from the workspace MCP registry — with
 * the user's recorded decision. The single source for both the dashboard
 * prompt and the CLI's `run` gate / `trust-workspace-settings` command.
 * `configService` must already have this workspace's backend set.
 */
export async function getWorkspaceSettingsTrustStates(
  workspaceRoot: string,
  registry: Pick<
    McpRegistryFileManager,
    "getWorkspaceTrustStates"
  > = new McpRegistryFileManager(workspaceRoot)
): Promise<WorkspaceSensitiveSettingState[]> {
  const registryStates = await registry.getWorkspaceTrustStates();
  const seen = new Set<string>();
  return [
    ...configService.getWorkspaceSensitiveSettingStates(),
    ...registryStates,
  ].filter((state) => {
    const key = workspaceSensitiveSettingRequestKey(state.request);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Requests this workspace makes that the user has never decided on. */
export async function getPendingWorkspaceSettingsTrustRequests(
  workspaceRoot: string
): Promise<WorkspaceSensitiveSettingRequest[]> {
  return (await getWorkspaceSettingsTrustStates(workspaceRoot))
    .filter((state) => state.decision === undefined)
    .map((state) => state.request);
}

/**
 * Record decisions for this workspace, then notify settings subscribers so
 * the dashboard re-reads the now (un)withheld values.
 */
export async function recordWorkspaceSettingsTrustDecisions(
  workspaceRoot: string,
  approved: readonly WorkspaceSensitiveSettingRequest[],
  denied: readonly WorkspaceSensitiveSettingRequest[],
  store: Pick<
    WorkspaceSettingsTrustStore,
    "setDecisions"
  > = workspaceSettingsTrustStore
): Promise<void> {
  const identity =
    WorkspaceSettingsTrustStore.canonicalizeWorkspace(workspaceRoot);
  await store.setDecisions(identity, approved, TRUST_DECISIONS.ALLOW);
  await store.setDecisions(identity, denied, TRUST_DECISIONS.DENY);
  if (approved.length > 0 || denied.length > 0) {
    configService.notify();
  }
}

/** The read/record pair the prompt and CLI flows need; tests substitute it. */
export interface WorkspaceSettingsTrustAccess {
  loadStates(workspaceRoot: string): Promise<WorkspaceSensitiveSettingState[]>;
  recordDecisions(
    workspaceRoot: string,
    approved: readonly WorkspaceSensitiveSettingRequest[],
    denied: readonly WorkspaceSensitiveSettingRequest[]
  ): Promise<void>;
}

export const workspaceSettingsTrustAccess: WorkspaceSettingsTrustAccess = {
  loadStates: (workspaceRoot) => getWorkspaceSettingsTrustStates(workspaceRoot),
  recordDecisions: (workspaceRoot, approved, denied) =>
    recordWorkspaceSettingsTrustDecisions(workspaceRoot, approved, denied),
};
