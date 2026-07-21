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

/** Compare two stable client view addresses. */
function sameAddress(
  a: import("@root/types/CtrlYokeTypes").WorkflowViewAddress | null | undefined,
  b: import("@root/types/CtrlYokeTypes").WorkflowViewAddress | null | undefined
): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.workflowKey === b.workflowKey &&
      a.kind === b.kind &&
      (a.kind === "draft" || (b.kind === "run" && a.runRef === b.runRef)))
  );
}

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
  if (sameAddress(target, ui.displayedViewAddress)) return;

  // Optimistically record the address so a response for an older browser
  // history entry cannot overwrite this navigation while storage is loading.
  ui.setDisplayedRunView(
    target,
    ui.runSummaries,
    ui.executionRunRef ?? undefined
  );
  vscode.postMessage({ type: MESSAGE_TYPES.LOAD_RUN_VIEW, address: target });
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
