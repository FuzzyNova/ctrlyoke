/**
 * Maps a Route to a document title, so the browser tab and session-history
 * entries get meaningful, shareable labels (VS Code-style).
 */
import type { Route } from "./route";

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
  if (route.viewer === "explorer") {
    if (route.file) return basename(route.file);
    if (route.dir) return `${basename(route.dir)}/`;
    return "Explorer";
  }
  if (route.viewer === "sourceControl") {
    if (route.ref) return refLabel(route.ref);
    if (route.file) return `${basename(route.file)} (diff)`;
    return "Source Control";
  }
  if (route.viewer === "search") {
    return "Search";
  }
  if (route.workflow) {
    return route.workflow.kind === "run"
      ? `Run ${route.workflow.runRef}`
      : "Draft";
  }
  return undefined;
}

export function routeTitle(route: Route): string {
  const label = locationLabel(route);
  return label ? `${label} — ${APP_NAME}` : APP_NAME;
}
