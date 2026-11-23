import * as path from "path";
import {
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  getHarnessDisplayName,
  type HarnessId,
} from "../../../types/DashboardConstants";
import {
  COMPATIBILITY_DIAGNOSTIC_CODES,
  type CompatibilityDiagnostic,
} from "../../../types/CompatibilityTypes";
import { isUserHomeWorkspace } from "../../../utils/ProjectStatePaths";
import type { PreparedMutation } from "./interfaces/PreparedMutation";

/**
 * Warn when a launch writes harness config found by its place in the
 * workspace while the workspace is the home directory. Those files then sit in
 * the user's own config folders (`~/.agents/mcp_config.json`,
 * `~/.github/hooks/`), where harness sessions started elsewhere under the home
 * directory can see them. The writes still happen: without them MCP servers
 * and hooks would not attach.
 */
export function createHomeWorkspaceConfigDiagnostics(
  harnessId: HarnessId,
  workspaceRoot: string | undefined,
  mutations: readonly PreparedMutation[]
): CompatibilityDiagnostic[] {
  if (!workspaceRoot || !isUserHomeWorkspace(workspaceRoot)) return [];
  const files = [
    ...new Set(
      mutations
        .filter((mutation) => mutation.workspaceHarnessConfig && mutation.path)
        .map((mutation) => formatHomePath(workspaceRoot, mutation.path!))
    ),
  ];
  if (files.length === 0) return [];
  const harness = getHarnessDisplayName(harnessId);
  return [
    {
      code: COMPATIBILITY_DIAGNOSTIC_CODES.HOME_WORKSPACE_USER_CONFIG,
      severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
      harnessId,
      capability: "workspaceConfig",
      state: {
        fidelity: CAPABILITY_FIDELITIES.EXACT,
        mechanism: CAPABILITY_MECHANISMS.WORKSPACE_CONFIG,
        verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
      },
      message: `ctrlyoke is running in your home directory, so ${harness}'s workspace config is in your user folders. This step writes ${files.join(", ")} and removes ctrlyoke's entries when it ends; until then, other ${harness} sessions under your home directory can see them.`,
      remediation:
        "Open a project folder instead of your home directory to keep these edits inside the project.",
    },
  ];
}

/** `~/…` with forward slashes, for a path inside the home workspace. */
function formatHomePath(workspaceRoot: string, filePath: string): string {
  const relative = path.relative(workspaceRoot, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? `~/${relative.split(path.sep).join("/")}`
    : filePath;
}
