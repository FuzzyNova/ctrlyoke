/**
 * Applies a Route to the live stores — the inbound half of navigation.
 *
 * Used by the back/forward controls (and, in a later step, by browser popstate
 * handling) to move the app to a previously visited location. Workflow switches
 * round-trip through the extension/host via postMessage; workspace-viewer state
 * is driven through the existing store actions (the explorer consumes the
 * `pendingNavigation` it sets).
 *
 * While a route is being applied, `isApplyingRoute()` returns true so the
 * navigation recorder ignores the resulting store mutations — a back/forward
 * step must not push a brand-new history entry.
 */
import { MESSAGE_TYPES } from "@/types/messages";
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import type { Route } from "./route";

interface PostMessageApi {
  postMessage: (message: unknown) => void;
}

let applying = false;

/** True while {@link applyRoute} is mutating stores; gates the nav recorder. */
export function isApplyingRoute(): boolean {
  return applying;
}

export function applyRoute(route: Route, vscode: PostMessageApi): void {
  applying = true;
  try {
    applyWorkflow(route, vscode);
    applyViewer(route);
  } finally {
    applying = false;
  }
}

function applyWorkflow(route: Route, vscode: PostMessageApi): void {
  const target = route.workflow;
  if (!target) return;

  const ui = useUiStore.getState();
  if (target === (ui.activeWorkflowWorkingFilePath ?? undefined)) return;

  // Optimistically set the working file path (mirrors WorkflowStatus's switch
  // handlers) so the derived route settles immediately; the host confirms the
  // switch asynchronously.
  ui.setActiveWorkflowWorkingFilePath(target);

  const loaded = ui.loadedWorkflows.find((w) => w.workingFilePath === target);
  if (loaded) {
    vscode.postMessage({
      type: MESSAGE_TYPES.SWITCH_WORKFLOW,
      workflowId: loaded.id,
    });
  } else {
    vscode.postMessage({ type: MESSAGE_TYPES.LOAD_WORKFLOW, filePath: target });
  }
}

function applyViewer(route: Route): void {
  const wv = useWorkspaceViewerStore.getState();

  if (!route.viewer) {
    if (wv.isOpen) wv.close();
    return;
  }

  if (route.viewer === "explorer") {
    if (route.file) {
      wv.openToFile(route.file, route.lines?.[0], route.lines?.[1]);
    } else {
      wv.clearFile();
      wv.openToDirectory(route.dir ?? "");
    }
    return;
  }

  // sourceControl
  if (route.ref) {
    // openToGitRef opens the viewer on the SCM tab and fetches the ref diff.
    void wv.openToGitRef(route.ref);
  } else if (route.file) {
    // openToDiff sets pendingDiff; the SCM pane reloads the diff content.
    wv.openToDiff(route.file);
  } else {
    if (!wv.isOpen) wv.open();
    wv.setActiveTab("sourceControl");
    wv.clearDiff();
  }
}
