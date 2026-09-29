import type { SecretGrantsTrustStore } from "../config/SecretGrantsTrustStore";
import { secretGrantsTrustStore } from "../config/SecretGrantsTrustStore";
import { ExternalRootsTrustStore } from "../config/ExternalRootsTrustStore";
import type { PromptFile } from "../types/CtrlYokeTypes";
import { getWorkflowSecretGrants } from "../utils/SecretResolver";
import type { UserInteractionPort } from "./UserInteractionPort";

/**
 * A workflow declares one or more secret grants without an allow decision,
 * and no interactive client is connected to ask. The caller
 * (`preflightWorkflowSecrets`) is what actually blocks the run either way —
 * this error exists so a run that couldn't even attempt to ask reports *why*,
 * distinctly from a prompt the user dismissed (which silently asks again
 * next run, same as an unanswered VS Code QuickPick always did).
 */
export class PendingSecretGrantsError extends Error {
  readonly secretNames: readonly string[];

  constructor(secretNames: readonly string[]) {
    super(
      `${secretNames.length} secret grant(s) require approval and no interactive client is connected: ` +
        `${secretNames.join(", ")}. Approve them with "ctrlyoke trust-secret-grants <file>", ` +
        `or open this workspace in the ctrlyoke panel and approve them there.`
    );
    this.secretNames = [...secretNames];
    this.name = "PendingSecretGrantsError";
  }
}

/**
 * One-time batch approval for a workspace's requested workflow secret grants.
 * Asks the given interaction port for a single reviewable batch decision
 * covering every grant that is not already allowed for this workspace
 * identity. Each item defaults checked ("Allow"); unchecking an item before
 * confirming records a "deny" for it instead. Dismissing the request (Escape
 * in the VS Code implementation) records no decision at all, so the user is
 * asked again next time.
 *
 * Workspace-trust gating (VS Code's own "is this folder trusted" concept) is
 * the caller's concern, not this function's — it has no `vscode` dependency
 * so it works identically for any interaction port implementation.
 */
export async function promptBatchApprovalForPendingWorkspaceSecretGrants(
  workflow: PromptFile,
  workspaceRoot: string,
  port: UserInteractionPort,
  store: Pick<
    SecretGrantsTrustStore,
    "getUnallowedGrants" | "setDecisions"
  > = secretGrantsTrustStore
): Promise<void> {
  const workspaceIdentity =
    ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
  const pendingNames = store.getUnallowedGrants(
    workspaceIdentity,
    getWorkflowSecretGrants(workflow)
  );
  if (pendingNames.length === 0) {
    return;
  }

  if (!port.canPrompt()) {
    throw new PendingSecretGrantsError(pendingNames);
  }

  const result = await port.requestBatchApproval({
    id: crypto.randomUUID(),
    title: `This workflow requests ${pendingNames.length} secret grant(s)`,
    description:
      "Uncheck a grant to keep it blocked. Dismissing asks again next time.",
    items: pendingNames.map((name) => ({
      value: name,
      label: name,
      checked: true,
    })),
  });

  if (result === undefined) {
    return;
  }

  if (result.approvedValues.length > 0) {
    await store.setDecisions(workspaceIdentity, result.approvedValues, "allow");
  }
  if (result.deniedValues.length > 0) {
    await store.setDecisions(workspaceIdentity, result.deniedValues, "deny");
  }
}
