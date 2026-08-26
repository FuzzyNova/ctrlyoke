/**
 * Maps a Route to a document title, so the browser tab and session-history
 * entries get meaningful, shareable labels (VS Code-style).
 */
import type { Route } from "./route";
import {
  WORKFLOW_VIEW_ADDRESS_KIND,
  WORKSPACE_VIEWER_TABS,
} from "@root/types/DashboardConstants";

const APP_NAME = "ctrlyoke";

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function refLabel(ref: string): string {
  if (ref === "~diff") return "Working Tree";
  if (ref === "~staged") return "Staged Changes";
  if (ref.startsWith("~stash:")) return `Stash #${ref.slice("~stash:".length)}`;
  const short = ref.startsWith("~") ? ref.slice(1) : ref;
  return `Commit ${short.slice(0, 7)}`;
}

function locationLabel(route: Route): string | undefined {
  if (route.viewer === WORKSPACE_VIEWER_TABS.EXPLORER) {
    if (route.file) return basename(route.file);
    if (route.dir) return `${basename(route.dir)}/`;
    return "Explorer";
  }
  if (route.viewer === WORKSPACE_VIEWER_TABS.SOURCE_CONTROL) {
    if (route.ref) return refLabel(route.ref);
    if (route.file) return `${basename(route.file)} (diff)`;
    return "Source Control";
  }
  if (route.viewer === WORKSPACE_VIEWER_TABS.SEARCH) {
    return "Search";
  }
  if (route.workflow) {
    return route.workflow.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
      ? `Run ${route.workflow.runRef}`
      : "Draft";
  }
  return undefined;
}

export function routeTitle(route: Route): string {
  const label = locationLabel(route);
  return label ? `${label} — ${APP_NAME}` : APP_NAME;
}
