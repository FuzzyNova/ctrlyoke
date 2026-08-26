/**
 * Pure URL ↔ Route mapping for the hosted dashboard's browser navigation.
 *
 * The Route is the normalized, app-level description of a navigable location
 * (which workflow, whether the workspace viewer is open and on which tab, the
 * selected file / directory / git ref). It is intentionally free of any store
 * or DOM coupling so it can be unit-tested in isolation and reused by both the
 * browser History sync layer and the in-memory navigation stack.
 *
 * URL scheme (query params, carried alongside the existing `?token=`):
 *   workflowKey=<key>&runRef=<ref>         stable workflow/run selection
 *   viewer=explorer|scm|search            workspace viewer open + active tab
 *   file=<relPath>                        explorer file, or scm diff file
 *   dir=<relPath>                         explorer directory (when no file)
 *   lines=<start>-<end>                   explorer file selection (inbound only)
 *   ref=<hash|~diff|~staged|~stash:N>     scm git-ref diff (when no file)
 *   query=<text>&scope=<scope>            workspace search state
 *   includeGitIgnored=true&repo=<id>      optional workspace search filters
 *
 * `viewer` uses the short token `scm` in the URL but maps to the store's
 * canonical `"sourceControl"` tab id internally, keeping shareable URLs tidy
 * while Route stays aligned with the workspace-viewer store types.
 */

import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import type { WorkspaceSearchScope } from "@root/types/HostedWorkspaceViewerTypes";
import {
  BOOLEAN_STRING_VALUES,
  WORKFLOW_VIEW_ADDRESS_KIND,
  WORKSPACE_SEARCH_SCOPES,
  WORKSPACE_VIEWER_TABS,
  type WorkspaceViewerTab,
} from "@root/types/DashboardConstants";

/** Workspace viewer tab id — matches `workspaceViewerStore`'s `activeTab`. */
type ViewerTab = WorkspaceViewerTab;

/**
 * Single source for the `viewer=` URL token of each tab, and its inverse. Every
 * tab needs an entry: a tab missing from here would serialize to another tab's
 * token and silently switch tabs on reload/back.
 */
const VIEWER_URL_TOKENS: Record<ViewerTab, string> = {
  [WORKSPACE_VIEWER_TABS.EXPLORER]: "explorer",
  [WORKSPACE_VIEWER_TABS.SOURCE_CONTROL]: "scm",
  [WORKSPACE_VIEWER_TABS.SEARCH]: "search",
};

const VIEWER_TABS_BY_URL_TOKEN: Record<string, ViewerTab | undefined> =
  Object.fromEntries(
    (Object.keys(VIEWER_URL_TOKENS) as ViewerTab[]).map((tab) => [
      VIEWER_URL_TOKENS[tab],
      tab,
    ])
  );

export interface Route {
  /** Active lineage draft or promoted run, addressed without a filesystem path. */
  workflow?: WorkflowViewAddress;
  /** Open workspace viewer tab; absent means the viewer is closed. */
  viewer?: ViewerTab;
  /** Explorer-selected file, or (in scm) the diff file. */
  file?: string;
  /** Explorer directory, used only when no `file` is present. */
  dir?: string;
  /** SCM git ref (commit hash or `~diff`/`~staged`/`~stash:N`). */
  ref?: string;
  /** Inbound-only selection range for an explorer file. */
  lines?: [number, number];
  /** Workspace search query, restored when the search tab is opened. */
  searchQuery?: string;
  /** Workspace search scope. */
  searchScope?: WorkspaceSearchScope;
  /** Whether workspace search includes git-ignored files. */
  searchIncludeGitIgnored?: boolean;
  /** Selected workspace repository for multi-repo search. */
  searchRepo?: string;
}

/** Plain snapshot of the store fields that determine the current Route. */
export interface RouteSourceState {
  displayedViewAddress: WorkflowViewAddress | null;
  isOpen: boolean;
  activeTab: ViewerTab;
  selectedFilePath: string | null;
  explorerPath: string;
  selectedDiffPath: string | null;
  diffRef: string | null;
  searchQuery?: string;
  searchScope?: WorkspaceSearchScope;
  searchIncludeGitIgnored?: boolean;
  searchRepo?: string | null;
}

/** Forward-slash normalize a path; the rest of the UI keys off these. */
function fwd(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Trim and collapse empty strings to undefined. */
function clean(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseSearchScope(value: string | null): WorkspaceSearchScope {
  return value === WORKSPACE_SEARCH_SCOPES.FILES ||
    value === WORKSPACE_SEARCH_SCOPES.CONTENT ||
    value === WORKSPACE_SEARCH_SCOPES.BOTH
    ? value
    : WORKSPACE_SEARCH_SCOPES.BOTH;
}

function parseBoolean(value: string | null): boolean {
  return value === BOOLEAN_STRING_VALUES.TRUE;
}

function parseLines(value: string | null): [number, number] | undefined {
  if (!value) return undefined;
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);
  if (start <= 0 || end <= 0) return undefined;
  return [start, end];
}

function linesEqual(
  a: [number, number] | undefined,
  b: [number, number] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1];
}

function normalizeWorkflowAddress(
  address: WorkflowViewAddress | undefined
): WorkflowViewAddress | undefined {
  if (!address || !address.workflowKey.trim()) return undefined;
  if (address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
    return address.runRef.trim()
      ? {
          workflowKey: address.workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: address.runRef,
        }
      : undefined;
  }
  return {
    workflowKey: address.workflowKey,
    kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
  };
}

function workflowAddressesEqual(
  a: WorkflowViewAddress | undefined,
  b: WorkflowViewAddress | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b || a.workflowKey !== b.workflowKey || a.kind !== b.kind) {
    return false;
  }
  return (
    a.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT ||
    (b.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN && a.runRef === b.runRef)
  );
}

/**
 * Enforce the nesting rules so equality and serialization are reliable
 * regardless of how a Route was constructed:
 *  - file/dir/ref/lines only exist inside a viewer
 *  - explorer: `file` (+lines) wins over `dir`
 *  - sourceControl: `ref` wins over `file`; `dir`/`lines` are dropped
 *  - all paths are forward-slash normalized
 */
export function normalizeRoute(route: Route): Route {
  const out: Route = {};
  const workflow = normalizeWorkflowAddress(route.workflow);
  if (workflow) out.workflow = workflow;

  if (!route.viewer) return out;
  out.viewer = route.viewer;

  if (route.viewer === WORKSPACE_VIEWER_TABS.EXPLORER) {
    if (route.file) {
      out.file = fwd(route.file);
      if (route.lines && route.lines[0] > 0 && route.lines[1] > 0) {
        out.lines = [route.lines[0], route.lines[1]];
      }
    } else if (route.dir) {
      out.dir = fwd(route.dir);
    }
  } else if (route.viewer === WORKSPACE_VIEWER_TABS.SOURCE_CONTROL) {
    if (route.ref) {
      out.ref = route.ref;
    } else if (route.file) {
      out.file = fwd(route.file);
    }
  } else if (route.viewer === WORKSPACE_VIEWER_TABS.SEARCH) {
    const searchQuery = clean(route.searchQuery);
    if (searchQuery) out.searchQuery = searchQuery;
    if (
      route.searchScope &&
      route.searchScope !== WORKSPACE_SEARCH_SCOPES.BOTH
    ) {
      out.searchScope = route.searchScope;
    }
    if (route.searchIncludeGitIgnored) {
      out.searchIncludeGitIgnored = true;
    }
    const searchRepo = clean(route.searchRepo);
    if (searchRepo) out.searchRepo = searchRepo;
  }

  return out;
}

/** Parse a URL search string (with or without leading `?`) into a Route. */
export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);

  const viewerRaw = params.get("viewer");
  const viewer: ViewerTab | undefined = viewerRaw
    ? VIEWER_TABS_BY_URL_TOKEN[viewerRaw]
    : undefined;

  return normalizeRoute({
    workflow: (() => {
      const workflowKey = clean(params.get("workflowKey"));
      const runRef = clean(params.get("runRef"));
      if (!workflowKey) return undefined;
      return runRef
        ? {
            workflowKey: workflowKey as WorkflowViewAddress["workflowKey"],
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: runRef as Extract<
              WorkflowViewAddress,
              { kind: typeof WORKFLOW_VIEW_ADDRESS_KIND.RUN }
            >["runRef"],
          }
        : {
            workflowKey: workflowKey as WorkflowViewAddress["workflowKey"],
            kind: "draft" as const,
          };
    })(),
    viewer,
    file: clean(params.get("file")),
    dir: clean(params.get("dir")),
    ref: clean(params.get("ref")),
    lines: parseLines(params.get("lines")),
    searchQuery: clean(params.get("query")),
    searchScope: parseSearchScope(params.get("scope")),
    searchIncludeGitIgnored: parseBoolean(params.get("includeGitIgnored")),
    searchRepo: clean(params.get("repo")),
  });
}

/**
 * Serialize a Route back into a URL search string, preserving the auth token
 * from `currentSearch`. Returns a string beginning with `?`, or `""` when no
 * params are present. Param order is deterministic for stable URLs.
 */
export function serializeRoute(route: Route, currentSearch = ""): string {
  const normalized = normalizeRoute(route);
  const params = new URLSearchParams();

  const token = new URLSearchParams(currentSearch).get("token");
  if (token) params.set("token", token);

  if (normalized.workflow) {
    params.set("workflowKey", normalized.workflow.workflowKey);
    if (normalized.workflow.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
      params.set("runRef", normalized.workflow.runRef);
    }
  }

  if (normalized.viewer) {
    params.set("viewer", VIEWER_URL_TOKENS[normalized.viewer]);
    if (normalized.viewer === WORKSPACE_VIEWER_TABS.EXPLORER) {
      if (normalized.file) {
        params.set("file", normalized.file);
        if (normalized.lines) {
          params.set("lines", `${normalized.lines[0]}-${normalized.lines[1]}`);
        }
      } else if (normalized.dir) {
        params.set("dir", normalized.dir);
      }
    } else if (normalized.viewer === WORKSPACE_VIEWER_TABS.SOURCE_CONTROL) {
      if (normalized.ref) {
        params.set("ref", normalized.ref);
      } else if (normalized.file) {
        params.set("file", normalized.file);
      }
    } else if (normalized.viewer === WORKSPACE_VIEWER_TABS.SEARCH) {
      if (normalized.searchQuery) {
        params.set("query", normalized.searchQuery);
      }
      if (
        normalized.searchScope &&
        normalized.searchScope !== WORKSPACE_SEARCH_SCOPES.BOTH
      ) {
        params.set("scope", normalized.searchScope);
      }
      if (normalized.searchIncludeGitIgnored) {
        params.set("includeGitIgnored", BOOLEAN_STRING_VALUES.TRUE);
      }
      if (normalized.searchRepo) {
        params.set("repo", normalized.searchRepo);
      }
    }
  }

  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

/**
 * Equality ignoring the inbound-only `lines` selection. Used to decide whether
 * a route change is a distinct navigation worth its own history entry — a line
 * range within the same file is not.
 */
export function sameNavigation(a: Route, b: Route): boolean {
  const na = normalizeRoute(a);
  const nb = normalizeRoute(b);
  return (
    workflowAddressesEqual(na.workflow, nb.workflow) &&
    na.viewer === nb.viewer &&
    na.file === nb.file &&
    na.dir === nb.dir &&
    na.ref === nb.ref &&
    na.searchQuery === nb.searchQuery &&
    (na.searchScope ?? WORKSPACE_SEARCH_SCOPES.BOTH) ===
      (nb.searchScope ?? WORKSPACE_SEARCH_SCOPES.BOTH) &&
    (na.searchIncludeGitIgnored ?? false) ===
      (nb.searchIncludeGitIgnored ?? false) &&
    na.searchRepo === nb.searchRepo
  );
}

/** Structural equality of two Routes (after normalization). */
export function routesEqual(a: Route, b: Route): boolean {
  const na = normalizeRoute(a);
  const nb = normalizeRoute(b);
  return (
    workflowAddressesEqual(na.workflow, nb.workflow) &&
    na.viewer === nb.viewer &&
    na.file === nb.file &&
    na.dir === nb.dir &&
    na.ref === nb.ref &&
    linesEqual(na.lines, nb.lines) &&
    na.searchQuery === nb.searchQuery &&
    (na.searchScope ?? WORKSPACE_SEARCH_SCOPES.BOTH) ===
      (nb.searchScope ?? WORKSPACE_SEARCH_SCOPES.BOTH) &&
    (na.searchIncludeGitIgnored ?? false) ===
      (nb.searchIncludeGitIgnored ?? false) &&
    na.searchRepo === nb.searchRepo
  );
}

/**
 * Search controls are view state, not separate document locations. Update the
 * current URL/history entry while the user edits them, but keep the transition
 * from Search to a file as a real back/forward step.
 */
export function isSearchStateChange(a: Route, b: Route): boolean {
  const na = normalizeRoute(a);
  const nb = normalizeRoute(b);
  return (
    na.viewer === WORKSPACE_VIEWER_TABS.SEARCH &&
    nb.viewer === WORKSPACE_VIEWER_TABS.SEARCH &&
    workflowAddressesEqual(na.workflow, nb.workflow)
  );
}

/**
 * Derive the current Route from a store snapshot. This is the outbound half of
 * the sync layer: when navigable store fields settle, the result feeds the
 * history stack / `pushState`. Selection lines are intentionally not derived —
 * they are an inbound-only deep-link intent, not continuously tracked editor
 * state.
 */
export function deriveRoute(s: RouteSourceState): Route {
  const raw: Route = {};
  if (s.displayedViewAddress) {
    raw.workflow = s.displayedViewAddress;
  }

  if (s.isOpen) {
    raw.viewer = s.activeTab;
    if (s.activeTab === WORKSPACE_VIEWER_TABS.EXPLORER) {
      if (s.selectedFilePath) {
        raw.file = s.selectedFilePath;
      } else if (s.explorerPath) {
        raw.dir = s.explorerPath;
      }
    } else if (s.activeTab === WORKSPACE_VIEWER_TABS.SOURCE_CONTROL) {
      if (s.diffRef) {
        raw.ref = s.diffRef;
      } else if (s.selectedDiffPath) {
        raw.file = s.selectedDiffPath;
      }
    } else if (s.activeTab === WORKSPACE_VIEWER_TABS.SEARCH) {
      raw.searchQuery = s.searchQuery;
      raw.searchScope = s.searchScope;
      raw.searchIncludeGitIgnored = s.searchIncludeGitIgnored;
      raw.searchRepo = s.searchRepo ?? undefined;
    }
  }

  return normalizeRoute(raw);
}
