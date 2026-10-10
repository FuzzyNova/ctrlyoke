import * as path from "path";
import * as fs from "fs/promises";
import * as yaml from "js-yaml";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import {
  ExternalRootsTrustStore,
  externalRootsTrustStore,
} from "../config/ExternalRootsTrustStore";
import {
  EXTERNAL_FILE_TRUST_SCOPES,
  TRUST_DECISIONS,
} from "../types/DashboardConstants";
import type { ChoiceRequest, UserInteractionPort } from "./UserInteractionPort";
import { NullUserInteractionPort } from "./UserInteractionPort";
import { Log } from "../utils/Log";
import { loadYamlDocument, WORKFLOW_YAML_SCHEMA } from "../core/WorkflowYamlSchema";

export interface ExternalFileTrustContext {
  port: UserInteractionPort;
  workspaceRoot?: string;
  workflowSourcePath?: string;
  onWorkflowRootsUpdated?: (roots: string[]) => Promise<void>;
  trustStore?: Pick<ExternalRootsTrustStore, "setDecisions">;
}

/**
 * Show the host-neutral "Trust Parent Folder" scope choice for a path outside
 * every trusted root, persist the selected approval, and return whether the
 * path is now trusted. See
 * dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md ("File Link Opening Flow").
 *
 * `ui.offerTrustForUntrustedFileLinks: false` does not widen trust — it only
 * suppresses this offer, leaving the path blocked outright.
 */
export async function confirmExternalFileTrust(
  candidatePath: string,
  context: ExternalFileTrustContext = {
    port: new NullUserInteractionPort(),
  }
): Promise<boolean> {
  if (!ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks()) {
    return false;
  }

  const parentFolder = path.dirname(candidatePath);
  const workflowState = context.workflowSourcePath
    ? await readWorkflowTrustState(context.workflowSourcePath)
    : undefined;
  const choices: ChoiceRequest["choices"] = [
    {
      value: EXTERNAL_FILE_TRUST_SCOPES.USER,
      label: "Trust for me (all workspaces)",
    },
  ];
  if (context.workspaceRoot) {
    choices.push({
      value: EXTERNAL_FILE_TRUST_SCOPES.WORKSPACE,
      label: "Trust for this workspace",
    });
  }
  if (workflowState) {
    choices.push({
      value: EXTERNAL_FILE_TRUST_SCOPES.WORKFLOW,
      label: "Trust for this workflow",
    });
  }

  const choice = await context.port.requestChoice({
    id: crypto.randomUUID(),
    title: "Trust Parent Folder",
    detail:
      `ctrlyoke blocked access to a file outside your workspace and outside ` +
      `any currently trusted external root:\n${candidatePath}`,
    choices,
  });
  if (choice === undefined) {
    return false;
  }

  switch (choice) {
    case EXTERNAL_FILE_TRUST_SCOPES.USER:
      await ConfigurationUtils.addUserAllowedExternalFileRoot(parentFolder);
      return true;
    case EXTERNAL_FILE_TRUST_SCOPES.WORKSPACE: {
      if (!context.workspaceRoot) return false;
      await ConfigurationUtils.addWorkspaceAllowedExternalFileRoot(
        parentFolder
      );
      await (context.trustStore ?? externalRootsTrustStore).setDecisions(
        ExternalRootsTrustStore.canonicalizeRoot(context.workspaceRoot),
        [parentFolder],
        TRUST_DECISIONS.ALLOW
      );
      return true;
    }
    case EXTERNAL_FILE_TRUST_SCOPES.WORKFLOW: {
      if (
        !context.workspaceRoot ||
        !context.workflowSourcePath ||
        !workflowState
      ) {
        return false;
      }
      const workflowIdentity =
        ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
          context.workspaceRoot,
          context.workflowSourcePath
        );
      const roots =
        workflowState.declaredRoots === undefined
          ? [
              ...ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
                ExternalRootsTrustStore.canonicalizeRoot(context.workspaceRoot)
              ),
              parentFolder,
            ]
          : [...(workflowState.declaredRoots ?? []), parentFolder];
      const nextRoots = dedupeRoots(roots);
      await writeWorkflowTrustState(context.workflowSourcePath, nextRoots);
      await context.onWorkflowRootsUpdated?.(nextRoots);
      await (context.trustStore ?? externalRootsTrustStore).setDecisions(
        workflowIdentity,
        [parentFolder],
        TRUST_DECISIONS.ALLOW
      );
      return true;
    }
    default:
      return false;
  }
}

/**
 * One-time batch approval for a workspace's requested external file roots
 * (`permissions.trustedExternalRoots` at workspace scope). Shows a
 * single scrollable, reviewable dashboard modal — never one popup per root — listing
 * every root that has no recorded decision yet for this workspace identity.
 * Each item defaults checked ("Trust"); unchecking an item before confirming
 * records a "deny" for it instead. Dismissing the modal records no
 * decision at all, so the user is asked again next time. Requires VS Code
 * Workspace Trust first — untrusted workspaces are skipped entirely and
 * retried once trust is granted (see the `onDidGrantWorkspaceTrust` listener
 * in `extension.ts`). See
 * dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md ("Additional Decisions
 * (2026-07-13)").
 */
export async function promptBatchApprovalForPendingWorkspaceExternalRoots(
  workspaceRoot: string,
  port: UserInteractionPort = new NullUserInteractionPort(),
  store: Pick<
    ExternalRootsTrustStore,
    "getApprovedRoots" | "getPendingRoots" | "setDecisions"
  > = externalRootsTrustStore,
  isWorkspaceTrusted: () => boolean = () => true
): Promise<void> {
  if (!isWorkspaceTrusted()) {
    return;
  }

  const workspaceIdentity =
    ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
  const pendingRoots = ConfigurationUtils.getPendingWorkspaceExternalFileRoots(
    workspaceIdentity,
    store
  );
  if (pendingRoots.length === 0) {
    return;
  }

  await promptBatchApprovalForPendingRoots(
    workspaceIdentity,
    pendingRoots,
    `This workspace requests ${pendingRoots.length} external file root(s)`,
    port,
    store
  );
}

export async function promptBatchApprovalForPendingWorkflowExternalRoots(
  workspaceRoot: string,
  workflowSourcePath: string,
  requestedRoots: readonly string[],
  port: UserInteractionPort = new NullUserInteractionPort(),
  store: Pick<
    ExternalRootsTrustStore,
    "getApprovedRoots" | "getPendingRoots" | "setDecisions"
  > = externalRootsTrustStore,
  isWorkspaceTrusted: () => boolean = () => true
): Promise<void> {
  if (!isWorkspaceTrusted()) return;
  const workspaceIdentity =
    ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
  const workflowIdentity = ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
    workspaceRoot,
    workflowSourcePath
  );
  const pendingRoots = ConfigurationUtils.getPendingWorkflowExternalFileRoots(
    workspaceIdentity,
    workflowIdentity,
    requestedRoots,
    store
  );
  await promptBatchApprovalForPendingRoots(
    workflowIdentity,
    pendingRoots,
    `This workflow requests ${pendingRoots.length} external file root(s)`,
    port,
    store
  );
}

export async function promptBatchApprovalForPendingRoots(
  scopeIdentity: string,
  pendingRoots: readonly string[],
  title: string,
  port: UserInteractionPort,
  store: Pick<ExternalRootsTrustStore, "setDecisions"> = externalRootsTrustStore
): Promise<void> {
  if (pendingRoots.length === 0 || !port.canPrompt()) {
    return;
  }

  const result = await port.requestBatchApproval({
    id: crypto.randomUUID(),
    title,
    description:
      "Uncheck a folder to keep it blocked. Dismissing asks again next time.",
    items: pendingRoots.map((root) => ({
      value: root,
      label: root,
      checked: true,
    })),
  });
  if (!result) return;

  if (result.approvedValues.length > 0) {
    await store.setDecisions(
      scopeIdentity,
      result.approvedValues,
      TRUST_DECISIONS.ALLOW
    );
  }
  if (result.deniedValues.length > 0) {
    await store.setDecisions(
      scopeIdentity,
      result.deniedValues,
      TRUST_DECISIONS.DENY
    );
  }
}

function dedupeRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  return roots.filter((root) => {
    const canonical = ExternalRootsTrustStore.canonicalizeRoot(root);
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}

async function readWorkflowTrustState(
  sourcePath: string
): Promise<{ declaredRoots: string[] | null | undefined } | undefined> {
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension === ".md") return undefined;
  try {
    const raw = await fs.readFile(sourcePath, "utf8");
    const parsed =
      extension === ".json"
        ? JSON.parse(raw)
        : loadYamlDocument(raw, { schema: WORKFLOW_YAML_SCHEMA });
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const declaredRoots = (parsed as { trustedExternalRoots?: unknown })
      .trustedExternalRoots;
    if (
      declaredRoots !== undefined &&
      declaredRoots !== null &&
      (!Array.isArray(declaredRoots) ||
        !declaredRoots.every((root) => typeof root === "string"))
    ) {
      return undefined;
    }
    return {
      declaredRoots: declaredRoots as string[] | null | undefined,
    };
  } catch (error) {
    Log.warn(
      `[ExternalFileTrustPrompt] Unable to inspect workflow trust settings at "${sourcePath}": ${error}`
    );
    return undefined;
  }
}

async function writeWorkflowTrustState(
  sourcePath: string,
  roots: readonly string[]
): Promise<void> {
  const extension = path.extname(sourcePath).toLowerCase();
  const raw = await fs.readFile(sourcePath, "utf8");
  const parsed =
    extension === ".json"
      ? JSON.parse(raw)
      : loadYamlDocument(raw, { schema: WORKFLOW_YAML_SCHEMA });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The active workflow file has an invalid root object.");
  }
  (
    parsed as { trustedExternalRoots?: readonly string[] }
  ).trustedExternalRoots = roots;
  const serialized =
    extension === ".json"
      ? JSON.stringify(parsed, null, 2) + "\n"
      : yaml.dump(parsed);
  await fs.writeFile(sourcePath, serialized, "utf8");
}
