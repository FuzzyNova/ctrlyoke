/**
 * Maps a Route to a document title, so the browser tab and session-history
 * entries get meaningful, shareable labels (VS Code-style).
 */
import type { Route } from "./route";
import { WORKSPACE_VIEWER_TABS } from "@root/types/DashboardConstants";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  isDisplayedLineageDrillable,
  viewedRunLabel,
} from "@utils/runNavigation";
import { resolveWorkflowDisplayName } from "@utils/workflowDisplayName";

const APP_NAME = "ctrlyoke";

/** The displayed workflow, as the header names it. */
export interface WorkflowTitle {
  name: string;
  /** "Run 1042" / "Draft" — present only when the header shows a run badge. */
  runLabel?: string;
}

/**
 * Reads the displayed workflow's title parts from the live stores, using the
 * header's own name and run-badge rules so the tab and header always agree.
 */
export function currentWorkflowTitle(): WorkflowTitle | undefined {
  const ui = useUiStore.getState();
  const address = ui.displayedViewAddress;
  if (!address) return undefined;
  const { workflowName, fileName } = useWorkflowStore.getState();
  const name = resolveWorkflowDisplayName(
    ui.pendingRunViewSwitch?.workflowName,
    workflowName,
    fileName
  );
  return isDisplayedLineageDrillable(
    address,
    ui.recentWorkflows,
    ui.runSummaries
  )
    ? { name, runLabel: viewedRunLabel(address, ui.runSummaries, false) }
    : { name };
}

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

function locationLabel(
  route: Route,
  workflow: WorkflowTitle | undefined
): string | undefined {
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
  if (workflow) {
    return workflow.runLabel
      ? `${workflow.name} - ${workflow.runLabel}`
      : workflow.name;
  }
  return undefined;
}

/**
 * A workspace-viewer location is labelled by what it shows; otherwise the tab
 * carries the displayed workflow's name. The route's own workflow address is
 * only a runRef, and is dropped from the URL for the implicit latest workflow,
 * so the name comes from `workflow` instead.
 */
export function routeTitle(route: Route, workflow?: WorkflowTitle): string {
  const label = locationLabel(route, workflow);
  return label ? `${label} — ${APP_NAME}` : APP_NAME;
}
