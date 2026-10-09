import { MESSAGE_TYPES } from "@/types/messages";
import { isStandalone } from "@hooks/useVsCodeApi";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useUiStore } from "@store/uiStore";
import {
  ATOMIC_REFERENCE_KINDS,
  SETTING_SCOPES,
  USER_SETTINGS_VIEWER_SENTINEL_PATH,
  WORKSPACE_SETTINGS_RELATIVE_PATH,
  type AtomicReferenceKind,
  type SettingWriteScope,
} from "@root/types/DashboardConstants";
import type { AtomicReferenceChip as AtomicReferenceDescriptor } from "./atomicReferences";

/**
 * Shape of a context reference to act on, independent of where it came from
 * (a CodeMirror decoration's `data-*` attributes or a parsed
 * {@link ContextReferenceMatch} rendered in the output prompt row).
 */
export interface ContextReferenceTarget {
  type: AtomicReferenceKind | null | undefined;
  path?: string | null;
  gitRef?: string | null;
  lineStart?: string | number | null;
  lineEnd?: string | number | null;
  /** priorContext ref token (e.g. "previous", "step:1,3"). */
  ref?: string | null;
  /** /skill:<name> reference name. */
  skillName?: string | null;
  /** /mcp:<name> reference name. */
  mcpServerName?: string | null;
  /** Managed secret reference name. */
  secretName?: string | null;
}

interface VsCodeLike {
  postMessage: (message: unknown) => void;
}

export interface OpenContextReferenceOptions {
  /**
   * Open files, directories and commits in the workspace viewer even inside
   * VS Code: a reference clicked in the viewer's own file editor should
   * navigate there, not to a native editor behind the panel.
   */
  inWorkspaceViewer?: boolean;
}

/**
 * Read the open target back off an atomic-reference descriptor's `data-*`
 * attributes, so every output renderer that starts from a parsed descriptor
 * (echoed prompts, Markdown replies) opens it the same way.
 */
export function contextReferenceTargetFromDescriptor(
  descriptor: AtomicReferenceDescriptor
): ContextReferenceTarget {
  const { attrs } = descriptor;
  return {
    type: asAtomicReferenceKind(attrs["data-type"]),
    path: attrs["data-path"],
    gitRef: attrs["data-git-ref"],
    lineStart: attrs["data-line-start"],
    lineEnd: attrs["data-line-end"],
    ref: attrs["data-ref"],
    skillName: attrs["data-skill-name"],
    mcpServerName: attrs["data-mcp-server-name"],
    secretName: attrs["data-secret-name"],
  };
}

/** Narrow a DOM data-type attribute at the boundary to the shared contract. */
export function asAtomicReferenceKind(
  value: string | null | undefined
): AtomicReferenceKind | undefined {
  if (!value) return undefined;
  return (Object.values(ATOMIC_REFERENCE_KINDS) as readonly string[]).includes(
    value
  )
    ? (value as AtomicReferenceKind)
    : undefined;
}

function toLineNumber(
  value: string | number | null | undefined
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Single source of truth for "open this context reference". Used by the prompt
 * and workspace file editors' CodeMirror click handlers and by the output
 * prompt row's inline link rendering so all of them open symbols, selections,
 * directories, files, and git commits identically. Transport-aware: in the
 * hosted browser (`isStandalone`) or with `inWorkspaceViewer`, navigation
 * routes through the workspace-viewer store; otherwise it posts messages the
 * extension host turns into native editor/diff actions.
 *
 * Returns true when the reference was handled.
 */
export function openContextReference(
  target: ContextReferenceTarget,
  vscode: VsCodeLike,
  stepCount?: number,
  options: OpenContextReferenceOptions = {}
): boolean {
  const { type } = target;
  const navigateInViewer = isStandalone || options.inWorkspaceViewer === true;

  if (type === ATOMIC_REFERENCE_KINDS.GIT) {
    const gitRef = target.gitRef ?? "";
    if (navigateInViewer) {
      void useWorkspaceViewerStore.getState().openToGitRef(gitRef);
    } else {
      vscode.postMessage({ type: MESSAGE_TYPES.OPEN_GIT_CHANGE, ref: gitRef });
    }
    return true;
  }

  if (type === ATOMIC_REFERENCE_KINDS.PRIOR_CONTEXT) {
    vscode.postMessage({
      type: MESSAGE_TYPES.REQUEST_PRIOR_CONTEXT_PREVIEW,
      ref: target.ref,
      stepCount,
    });
    return true;
  }

  if (type === ATOMIC_REFERENCE_KINDS.SKILL) {
    vscode.postMessage({
      type: MESSAGE_TYPES.OPEN_SKILL,
      skillName: target.skillName ?? "",
    });
    return true;
  }

  if (type === ATOMIC_REFERENCE_KINDS.MCP) {
    vscode.postMessage({
      type: MESSAGE_TYPES.REQUEST_MCP_CONFIG_PREVIEW,
      mcpServerName: target.mcpServerName ?? "",
    });
    return true;
  }

  if (type === ATOMIC_REFERENCE_KINDS.SECRET) {
    const ui = useUiStore.getState();
    ui.setGlobalSettingsTab("secrets");
    if (!ui.globalSettingsOpen) ui.toggleGlobalSettings();
    return true;
  }

  const path = target.path ?? "";
  const lineStart = toLineNumber(target.lineStart);
  const lineEnd = toLineNumber(target.lineEnd);

  if (navigateInViewer) {
    const store = useWorkspaceViewerStore.getState();
    if (type === ATOMIC_REFERENCE_KINDS.DIRECTORY) {
      store.openToDirectory(path);
      return true;
    }
    if (
      type === ATOMIC_REFERENCE_KINDS.FILE ||
      type === ATOMIC_REFERENCE_KINDS.LINE_RANGE ||
      type === ATOMIC_REFERENCE_KINDS.SYMBOL
    ) {
      store.openToFile(path, lineStart, lineEnd);
      return true;
    }
    return false;
  }

  if (
    type === ATOMIC_REFERENCE_KINDS.FILE ||
    type === ATOMIC_REFERENCE_KINDS.DIRECTORY
  ) {
    vscode.postMessage({ type: MESSAGE_TYPES.OPEN_FILE, path });
    return true;
  }

  if (
    type === ATOMIC_REFERENCE_KINDS.LINE_RANGE ||
    type === ATOMIC_REFERENCE_KINDS.SYMBOL
  ) {
    vscode.postMessage({
      type: MESSAGE_TYPES.OPEN_FILE,
      path,
      lineStart,
      lineEnd,
    });
    return true;
  }

  return false;
}

/**
 * Open the ctrlyoke settings.json for the given scope, the same
 * transport-aware way as {@link openContextReference}: in the hosted browser
 * this routes through the workspace-viewer store (the user-scope file lives
 * outside the workspace, so it opens via the fixed
 * `USER_SETTINGS_VIEWER_SENTINEL_PATH` sentinel rather than a real path); in
 * the VS Code panel it posts OPEN_SETTINGS_FILE for the extension host to
 * open natively.
 */
export function openSettingsFile(
  scope: SettingWriteScope,
  vscode: VsCodeLike
): void {
  if (isStandalone) {
    const store = useWorkspaceViewerStore.getState();
    if (scope === SETTING_SCOPES.WORKSPACE) {
      store.openToFile(WORKSPACE_SETTINGS_RELATIVE_PATH);
    } else {
      store.openToExternalFile(USER_SETTINGS_VIEWER_SENTINEL_PATH);
    }
    return;
  }

  vscode.postMessage({ type: MESSAGE_TYPES.OPEN_SETTINGS_FILE, scope });
}
