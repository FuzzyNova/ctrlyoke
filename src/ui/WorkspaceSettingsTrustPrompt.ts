import { TRUST_DECISIONS } from "../types/DashboardConstants";
import {
  workspaceSettingsTrustAccess,
  type WorkspaceSettingsTrustAccess,
} from "../config/WorkspaceSettingsTrust";
import { workspaceSensitiveSettingRequestKey } from "../config/WorkspaceSensitiveSettings";
import type { UserInteractionPort } from "./UserInteractionPort";

export interface WorkspaceSettingsTrustPromptOptions {
  /**
   * Also list values the user already allowed or denied, pre-checked by
   * their current decision, so a past answer can be changed. Off for the
   * automatic prompt, which asks only about undecided values.
   */
  includeDecided?: boolean;
}

/** Outcome of one prompt attempt, for callers that report back to the user. */
export const WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS = {
  NOTHING_TO_REVIEW: "nothing-to-review",
  CANNOT_PROMPT: "cannot-prompt",
  DISMISSED: "dismissed",
  DECIDED: "decided",
} as const;

export type WorkspaceSettingsTrustPromptResult =
  (typeof WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS)[keyof typeof WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS];

/**
 * Ask the user which of this workspace's program-launching settings to
 * honor (see `WorkspaceSensitiveSettings.ts`). Items start unchecked: a
 * value from a repository should run only after the user deliberately
 * checks it. Confirming records allow for checked items and deny for the
 * rest; "Ask me later" records nothing.
 *
 * Has no `vscode` dependency — gating on VS Code workspace trust is the
 * caller's job, as with the other trust prompts.
 */
export async function promptForWorkspaceSettingsTrust(
  workspaceRoot: string,
  port: UserInteractionPort,
  options: WorkspaceSettingsTrustPromptOptions = {},
  access: WorkspaceSettingsTrustAccess = workspaceSettingsTrustAccess
): Promise<WorkspaceSettingsTrustPromptResult> {
  const states = (await access.loadStates(workspaceRoot)).filter(
    (state) => options.includeDecided || state.decision === undefined
  );
  if (states.length === 0) {
    return WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS.NOTHING_TO_REVIEW;
  }
  if (!port.canPrompt()) {
    return WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS.CANNOT_PROMPT;
  }

  const byKey = new Map(
    states.map((state) => [
      workspaceSensitiveSettingRequestKey(state.request),
      state.request,
    ])
  );
  const result = await port.requestBatchApproval({
    id: crypto.randomUUID(),
    title: `This workspace's settings choose ${states.length} program(s) for ctrlyoke to run`,
    description:
      "These values come from this workspace's .ctrlyoke/settings.json or MCP registry and pick a shell, hook, MCP server, harness flag or script. " +
      "Check only the ones you trust; unchecked values stay blocked and your own settings apply instead. " +
      "Ask me later decides nothing.",
    items: states.map((state) => ({
      value: workspaceSensitiveSettingRequestKey(state.request),
      label: state.request.summary,
      checked: state.decision === TRUST_DECISIONS.ALLOW,
    })),
  });
  if (!result) {
    return WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS.DISMISSED;
  }

  const toRequests = (keys: readonly string[]) =>
    keys.flatMap((key) => {
      const request = byKey.get(key);
      return request ? [request] : [];
    });
  await access.recordDecisions(
    workspaceRoot,
    toRequests(result.approvedValues),
    toRequests(result.deniedValues)
  );
  return WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS.DECIDED;
}

/**
 * Serializes prompts for one host: a request that arrives while a prompt is
 * open waits for it and then re-reads, so the user never sees two dialogs
 * for the same workspace and nothing discovered meanwhile is dropped.
 */
export class WorkspaceSettingsTrustPrompter {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly getWorkspaceRoot: () => string | undefined,
    private readonly getPort: () => Promise<UserInteractionPort>,
    private readonly canAsk: () => boolean = () => true,
    private readonly access: WorkspaceSettingsTrustAccess = workspaceSettingsTrustAccess
  ) {}

  prompt(
    options: WorkspaceSettingsTrustPromptOptions = {}
  ): Promise<WorkspaceSettingsTrustPromptResult> {
    const next = this.chain.then(async () => {
      const workspaceRoot = this.getWorkspaceRoot();
      if (!workspaceRoot || !this.canAsk()) {
        return WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS.CANNOT_PROMPT;
      }
      return promptForWorkspaceSettingsTrust(
        workspaceRoot,
        await this.getPort(),
        options,
        this.access
      );
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}
