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
 *   workflow=<workingFilePath>            workflow selection (stable file path)
 *   viewer=explorer|scm                   workspace viewer open + active tab
 *   file=<relPath>                        explorer file, or scm diff file
 *   dir=<relPath>                         explorer directory (when no file)
 *   lines=<start>-<end>                   explorer file selection (inbound only)
 *   ref=<hash|~diff|~staged|~stash:N>     scm git-ref diff (when no file)
 *
 * `viewer` uses the short token `scm` in the URL but maps to the store's
 * canonical `"sourceControl"` tab id internally, keeping shareable URLs tidy
 * while Route stays aligned with the workspace-viewer store types.
 */

/** Workspace viewer tab id — matches `workspaceViewerStore`'s `activeTab`. */
export type ViewerTab = "explorer" | "sourceControl";

export interface Route {
  /** Active workflow's working file path (forward-slash, workspace-stable). */
  workflow?: string;
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
}

/** Plain snapshot of the store fields that determine the current Route. */
export interface RouteSourceState {
  activeWorkflowWorkingFilePath: string | null;
  isOpen: boolean;
  activeTab: ViewerTab;
  selectedFilePath: string | null;
  explorerPath: string;
  selectedDiffPath: string | null;
  diffRef: string | null;
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
  if (route.workflow) out.workflow = fwd(route.workflow);

  if (!route.viewer) return out;
  out.viewer = route.viewer;

  if (route.viewer === "explorer") {
    if (route.file) {
      out.file = fwd(route.file);
      if (route.lines && route.lines[0] > 0 && route.lines[1] > 0) {
        out.lines = [route.lines[0], route.lines[1]];
      }
    } else if (route.dir) {
      out.dir = fwd(route.dir);
    }
  } else {
    if (route.ref) {
      out.ref = route.ref;
    } else if (route.file) {
      out.file = fwd(route.file);
    }
  }

  return out;
}

/** Parse a URL search string (with or without leading `?`) into a Route. */
export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);

  const viewerRaw = params.get("viewer");
  const viewer: ViewerTab | undefined =
    viewerRaw === "explorer"
      ? "explorer"
      : viewerRaw === "scm"
        ? "sourceControl"
        : undefined;

  return normalizeRoute({
    workflow: clean(params.get("workflow")),
    viewer,
    file: clean(params.get("file")),
    dir: clean(params.get("dir")),
    ref: clean(params.get("ref")),
    lines: parseLines(params.get("lines")),
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

  if (normalized.workflow) params.set("workflow", normalized.workflow);

  if (normalized.viewer) {
    params.set("viewer", normalized.viewer === "explorer" ? "explorer" : "scm");
    if (normalized.viewer === "explorer") {
      if (normalized.file) {
        params.set("file", normalized.file);
        if (normalized.lines) {
          params.set("lines", `${normalized.lines[0]}-${normalized.lines[1]}`);
        }
      } else if (normalized.dir) {
        params.set("dir", normalized.dir);
      }
    } else if (normalized.ref) {
      params.set("ref", normalized.ref);
    } else if (normalized.file) {
      params.set("file", normalized.file);
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
    na.workflow === nb.workflow &&
    na.viewer === nb.viewer &&
    na.file === nb.file &&
    na.dir === nb.dir &&
    na.ref === nb.ref
  );
}

/** Structural equality of two Routes (after normalization). */
export function routesEqual(a: Route, b: Route): boolean {
  const na = normalizeRoute(a);
  const nb = normalizeRoute(b);
  return (
    na.workflow === nb.workflow &&
    na.viewer === nb.viewer &&
    na.file === nb.file &&
    na.dir === nb.dir &&
    na.ref === nb.ref &&
    linesEqual(na.lines, nb.lines)
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
  if (s.activeWorkflowWorkingFilePath) {
    raw.workflow = s.activeWorkflowWorkingFilePath;
  }

  if (s.isOpen) {
    raw.viewer = s.activeTab;
    if (s.activeTab === "explorer") {
      if (s.selectedFilePath) {
        raw.file = s.selectedFilePath;
      } else if (s.explorerPath) {
        raw.dir = s.explorerPath;
      }
    } else if (s.diffRef) {
      raw.ref = s.diffRef;
    } else if (s.selectedDiffPath) {
      raw.file = s.selectedDiffPath;
    }
  }

  return normalizeRoute(raw);
}
