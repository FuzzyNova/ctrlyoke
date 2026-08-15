import { isPathWithinDirectory } from "./PathSecurity";

/**
 * Why a path was allowed or blocked. UI call sites (dashboard "open file",
 * `PromptLinkProvider`, the prompt editor's "attach external file" flow)
 * branch on this to decide whether to act directly, offer a "Trust Parent
 * Folder" action, or block outright.
 */
type FileAccessReason =
  | "workspace"
  | "ownStateRoot"
  | "trustedExternalRoot"
  | "outsideTrustedRoots";

export interface FileAccessDecision {
  allowed: boolean;
  reason: FileAccessReason;
  /** The candidate path as passed in (already resolved by the caller). */
  normalizedPath: string;
  /** The specific trusted root that matched, when `reason` is not "outsideTrustedRoots". */
  matchedRoot?: string;
}

export interface FileAccessPolicyOptions {
  /** Every directory trusted as "inside the workspace" (see `getVsCodeTrustedWorkspaceRoots`/`getWorkspaceRoots`). */
  workspaceRoots: readonly string[];
  /** ctrlyoke-owned state roots that UI/open-file flows may inspect. */
  ownStateRoots?: readonly string[];
  /** External roots currently authorized for this workspace (see `ConfigurationUtils.getEffectiveApprovedExternalFileRoots`). */
  approvedExternalRoots: readonly string[];
}

/**
 * Decide whether `candidatePath` may be read/opened, and why.
 *
 * Deliberately a pure, synchronous comparator over already-resolved absolute
 * paths — callers are responsible for resolving folder-name-prefixed refs
 * (`resolveNamedRelativePath`) and for supplying the effective (already
 * trust-store-filtered) external roots list. Keeping this function free of
 * I/O and config/trust-store lookups keeps it trivially unit-testable and
 * matches how `ContextExpander`/`AttachmentBuilders` already use
 * `isPathWithinAnyDirectory` — this is the shared decision layer for the
 * call sites that additionally need to distinguish "trusted externally" from
 * "inside the workspace" in order to pick their UX (open directly vs. offer
 * Trust Parent Folder vs. block).
 */
export function evaluateFileAccess(
  candidatePath: string,
  options: FileAccessPolicyOptions
): FileAccessDecision {
  for (const root of options.workspaceRoots) {
    if (isPathWithinDirectory(candidatePath, root)) {
      return {
        allowed: true,
        reason: "workspace",
        normalizedPath: candidatePath,
        matchedRoot: root,
      };
    }
  }

  for (const root of options.ownStateRoots ?? []) {
    if (isPathWithinDirectory(candidatePath, root)) {
      return {
        allowed: true,
        reason: "ownStateRoot",
        normalizedPath: candidatePath,
        matchedRoot: root,
      };
    }
  }

  for (const root of options.approvedExternalRoots) {
    if (isPathWithinDirectory(candidatePath, root)) {
      return {
        allowed: true,
        reason: "trustedExternalRoot",
        normalizedPath: candidatePath,
        matchedRoot: root,
      };
    }
  }

  return {
    allowed: false,
    reason: "outsideTrustedRoots",
    normalizedPath: candidatePath,
  };
}
