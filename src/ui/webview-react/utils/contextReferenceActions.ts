import { MESSAGE_TYPES } from "@/types/messages";
import { isStandalone } from "@hooks/useVsCodeApi";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useUiStore } from "@store/uiStore";

/**
 * Shape of a context reference to act on, independent of where it came from
 * (a CodeMirror decoration's `data-*` attributes or a parsed
 * {@link ContextReferenceMatch} rendered in the output prompt row).
 */
export interface ContextReferenceTarget {
  type: string | null | undefined;
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

function toLineNumber(
  value: string | number | null | undefined
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Single source of truth for "open this context reference". Used by the prompt
 * editor's CodeMirror click handler and by the output prompt row's inline link
 * rendering so both open symbols, selections, directories, files, and git
 * commits identically. Transport-aware: in the hosted browser (`isStandalone`)
 * navigation routes through the workspace-viewer store; in the VS Code panel it
 * posts messages the extension host turns into native editor/diff actions.
 *
 * Returns true when the reference was handled.
 */
export function openContextReference(
  target: ContextReferenceTarget,
  vscode: VsCodeLike,
  stepCount?: number
): boolean {
  const { type } = target;

  if (type === "git") {
    const gitRef = target.gitRef ?? "";
    if (isStandalone) {
      void useWorkspaceViewerStore.getState().openToGitRef(gitRef);
    } else {
      vscode.postMessage({ type: MESSAGE_TYPES.OPEN_GIT_CHANGE, ref: gitRef });
    }
    return true;
  }

  if (type === "priorContext") {
    vscode.postMessage({
      type: MESSAGE_TYPES.REQUEST_PRIOR_CONTEXT_PREVIEW,
      ref: target.ref,
      stepCount,
    });
    return true;
  }

  if (type === "skill") {
    vscode.postMessage({
      type: MESSAGE_TYPES.OPEN_SKILL,
      skillName: target.skillName ?? "",
    });
    return true;
  }

  if (type === "mcp") {
    vscode.postMessage({
      type: MESSAGE_TYPES.REQUEST_MCP_CONFIG_PREVIEW,
      mcpServerName: target.mcpServerName ?? "",
    });
    return true;
  }

  if (type === "secret") {
    const ui = useUiStore.getState();
    ui.setGlobalSettingsTab("secrets");
    if (!ui.globalSettingsOpen) ui.toggleGlobalSettings();
    return true;
  }

  const path = target.path ?? "";
  const lineStart = toLineNumber(target.lineStart);
  const lineEnd = toLineNumber(target.lineEnd);

  if (isStandalone) {
    const store = useWorkspaceViewerStore.getState();
    if (type === "directory") {
      store.openToDirectory(path);
      return true;
    }
    if (type === "file" || type === "lineRange" || type === "symbol") {
      store.openToFile(path, lineStart, lineEnd);
      return true;
    }
    return false;
  }

  if (type === "file" || type === "directory") {
    vscode.postMessage({ type: MESSAGE_TYPES.OPEN_FILE, path });
    return true;
  }

  if (type === "lineRange" || type === "symbol") {
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
