import { TRUST_DECISIONS } from "../types/DashboardConstants";
import type { WorkspaceSensitiveSettingState } from "../config/CtrlYokeConfigService";
import type { WorkspaceSensitiveSettingRequest } from "../config/WorkspaceSensitiveSettings";
import {
  workspaceSettingsTrustAccess,
  type WorkspaceSettingsTrustAccess,
} from "../config/WorkspaceSettingsTrust";
import { ensureCliTrustDecided, type CliTrustIo } from "./CliTrustGate";

export const TRUST_WORKSPACE_SETTINGS_COMMAND = "trust-workspace-settings";

export interface TrustWorkspaceSettingsOptions {
  cwd?: string;
  /** Allow every listed value without asking. */
  yes?: boolean;
  /** Also list values already allowed or denied, to change a past answer. */
  all?: boolean;
}

const TRUST_EXPLANATION =
  "Only allow values you trust: they come from files in this workspace. " +
  "A denied value is ignored and your own settings apply instead.";

function decisionTag(state: WorkspaceSensitiveSettingState): string {
  if (state.decision === TRUST_DECISIONS.ALLOW) return " [allowed]";
  if (state.decision === TRUST_DECISIONS.DENY) return " [denied]";
  return "";
}

/**
 * Ask about each value in turn and record the answers. Returns how many
 * were allowed.
 */
async function askAndRecord(
  workspaceRoot: string,
  states: readonly WorkspaceSensitiveSettingState[],
  io: CliTrustIo,
  dependencies: WorkspaceSettingsTrustAccess
): Promise<number> {
  const approved: WorkspaceSensitiveSettingRequest[] = [];
  const denied: WorkspaceSensitiveSettingRequest[] = [];
  for (const state of states) {
    const allow = await io.confirm(
      `Allow ${state.request.summary}${decisionTag(state)}? [y/N] `
    );
    (allow ? approved : denied).push(state.request);
  }
  await dependencies.recordDecisions(workspaceRoot, approved, denied);
  return approved.length;
}

/**
 * The `run` family's gate. Workspace values awaiting a decision are already
 * withheld by the settings layer; this makes the user decide before a
 * workflow loads (loading copies settings defaults into the run). Unlike
 * the other trust gates it asks about each value separately.
 *
 * Returns `undefined` to proceed, or the exit code to stop with.
 */
export async function ensureWorkspaceSettingsDecided(
  workspaceRoot: string,
  io: CliTrustIo,
  dependencies: WorkspaceSettingsTrustAccess = workspaceSettingsTrustAccess
): Promise<number | undefined> {
  const pending = (await dependencies.loadStates(workspaceRoot)).filter(
    (state) => state.decision === undefined
  );
  return ensureCliTrustDecided(
    {
      heading: "This workspace's settings choose programs for ctrlyoke to run:",
      items: pending.map((state) => state.request.summary),
      reviewCommand: `ctrlyoke ${TRUST_WORKSPACE_SETTINGS_COMMAND}`,
      ask: async (askIo) => {
        askIo.writeErr(TRUST_EXPLANATION);
        await askAndRecord(workspaceRoot, pending, askIo, dependencies);
      },
    },
    io
  );
}

/**
 * `ctrlyoke trust-workspace-settings`: review this workspace's values that
 * choose a program to run, from `.ctrlyoke/settings.json` and the workspace
 * MCP registry. `--all` includes values already decided so an answer can
 * be changed; `--yes` allows everything listed.
 */
export async function trustWorkspaceSettingsCommand(
  workspaceRoot: string,
  options: TrustWorkspaceSettingsOptions,
  io: CliTrustIo,
  dependencies: WorkspaceSettingsTrustAccess = workspaceSettingsTrustAccess
): Promise<number> {
  const states = (await dependencies.loadStates(workspaceRoot)).filter(
    (state) => options.all || state.decision === undefined
  );
  if (states.length === 0) {
    io.writeOut(
      options.all
        ? "This workspace's settings don't choose any programs to run."
        : `Nothing to review. Use --all to change an earlier answer.`
    );
    return 0;
  }

  if (options.yes) {
    await dependencies.recordDecisions(
      workspaceRoot,
      states.map((state) => state.request),
      []
    );
    states.forEach((state) => io.writeOut(`Allowed ${state.request.summary}`));
    return 0;
  }

  if (!io.isInteractive) {
    io.writeErr(
      "Error: no terminal to ask in. Rerun in a terminal, or pass --yes to allow every listed value:"
    );
    states.forEach((state) =>
      io.writeErr(`  - ${state.request.summary}${decisionTag(state)}`)
    );
    return 2;
  }

  io.writeErr(TRUST_EXPLANATION);
  const allowed = await askAndRecord(workspaceRoot, states, io, dependencies);
  io.writeOut(
    `Allowed ${allowed} of ${states.length} value(s) for this workspace.`
  );
  return 0;
}
