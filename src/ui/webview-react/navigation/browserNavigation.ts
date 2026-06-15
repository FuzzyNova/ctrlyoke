/**
 * Browser History integration: URL ⇄ stores.
 *
 * Mounted once (browser/standalone mode only) by {@link useNavigationSync}. It
 *  - restores the location from the initial URL (deep links / shared links),
 *  - pushes a new URL whenever the navigable route settles to a new value,
 *  - applies the route on `popstate` (browser back/forward chrome and the
 *    in-app controls, which call `history.back()/forward()`),
 *  - keeps `document.title` in sync.
 *
 * The deep-linked workflow is threaded through `READY`'s
 * `preferredWorkingFilePath` rather than a `LOAD_WORKFLOW` round-trip, so the
 * server restores the right workflow with no visible default-then-switch flash.
 * Only the viewer portion of the initial route is applied locally.
 */
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { applyRoute, isApplyingRoute } from "./applyRoute";
import { useBrowserHistoryStore } from "./browserHistoryStore";
import { deriveCurrentRoute } from "./navState";
import { routeTitle } from "./navTitle";
import {
  parseRoute,
  serializeRoute,
  sameNavigation,
  type Route,
} from "./route";

function urlForRoute(route: Route): string {
  return `${window.location.pathname}${serializeRoute(
    route,
    window.location.search
  )}`;
}

function updateTitle(route: Route): void {
  document.title = routeTitle(route);
}

/**
 * The initial workflow resolving (after a token-only load the server restores
 * the most-recent workflow) refines the current entry rather than creating a
 * new one — otherwise Back would land on a pre-workflow empty state.
 */
function shouldReplace(prev: Route, next: Route): boolean {
  return (
    !prev.workflow &&
    !!next.workflow &&
    prev.viewer === next.viewer &&
    prev.file === next.file &&
    prev.dir === next.dir &&
    prev.ref === next.ref
  );
}

export function setupBrowserNavigation(): () => void {
  const vscode = getVsCodeApi();
  const initialRoute = parseRoute(window.location.search);

  // Hand the deep-linked workflow to READY (sent by a later App effect that
  // reads this via getState()), avoiding a default-workflow flash.
  if (initialRoute.workflow) {
    useUiStore.getState().setActiveWorkflowWorkingFilePath(initialRoute.workflow);
  }

  // Canonicalize the entry URL and stamp it as index 0.
  window.history.replaceState({ idx: 0 }, "", urlForRoute(initialRoute));
  useBrowserHistoryStore.getState().reset();
  updateTitle(initialRoute);

  let lastRoute: Route = initialRoute;

  // Apply only the viewer portion locally; the workflow rides READY above.
  applyRoute({ ...initialRoute, workflow: undefined }, vscode);

  const handleStoreChange = (): void => {
    if (isApplyingRoute()) return;
    const route = deriveCurrentRoute();
    // A line range within the same file is not a distinct history entry, so the
    // settle of a `?…&lines=` deep link must not push (and drop the range).
    if (sameNavigation(route, lastRoute)) return;

    const replace = shouldReplace(lastRoute, route);
    lastRoute = route;
    updateTitle(route);

    if (replace) {
      const { idx } = useBrowserHistoryStore.getState();
      window.history.replaceState({ idx }, "", urlForRoute(route));
      return;
    }
    const idx = useBrowserHistoryStore.getState().idx + 1;
    window.history.pushState({ idx }, "", urlForRoute(route));
    useBrowserHistoryStore.getState().set({ idx, length: idx + 1 });
  };

  const handlePopState = (event: PopStateEvent): void => {
    const route = parseRoute(window.location.search);
    lastRoute = route;
    const state = event.state as { idx?: number } | null;
    useBrowserHistoryStore
      .getState()
      .setIdx(typeof state?.idx === "number" ? state.idx : 0);
    applyRoute(route, vscode);
    updateTitle(route);
  };

  const unsubscribers = [
    useUiStore.subscribe(handleStoreChange),
    useWorkspaceViewerStore.subscribe(handleStoreChange),
  ];
  window.addEventListener("popstate", handlePopState);

  return () => {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    window.removeEventListener("popstate", handlePopState);
  };
}
