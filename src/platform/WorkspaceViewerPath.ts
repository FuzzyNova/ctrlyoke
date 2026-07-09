import * as path from "path";
import type { ResolverWorkspaceFolder } from "./WorkspaceRootResolver";
import { resolveNamedRelativePath } from "./WorkspaceRootResolver";
import { isPathWithinDirectory } from "../utils/PathSecurity";

/**
 * Single source of the **folder-name-prefixed viewer path** convention.
 *
 * A viewer path is the string language the UI, references, snapshots, and SCM
 * all speak: workspace-relative in a single-root workspace, and folder-name-
 * prefixed (`root2/src/index.ts`) in a multi-root `.code-workspace` — the same
 * form `vscode.workspace.asRelativePath(uri, true)` produces. This module owns
 * every direction of that convention so the prefix ⇄ absolute ⇄ repo rules
 * live in exactly one place instead of being re-derived per call site
 * (previously duplicated across the hosted SCM service, the snapshot/undo
 * layer, the resolver, and the reference/link providers).
 *
 * Split into two layers by dependency:
 * - **Pure string primitives** (`firstViewerSegment`, `stripViewerPrefix`,
 *   `joinViewerPath`) — no filesystem knowledge; safe anywhere.
 * - **Root-aware conversions** (`toViewerPath`, `fromViewerPath`,
 *   `rootForViewerPath`) — need the workspace roots and `node:path` semantics.
 *
 * The webview bundle cannot import this module (it pulls in `node:path`); its
 * one prefix read (`repoIdForPath` in `workspaceViewerStore.ts`) mirrors only
 * the `firstViewerSegment` rule and cross-references this module.
 */

// ── Pure prefix-string primitives ──────────────────────────────────────────

/**
 * First path segment of a viewer path (the folder-name prefix candidate in
 * multi-root). Returns the whole string when there is no `/`. Backslashes are
 * normalized so Windows-style inputs behave identically.
 */
export function firstViewerSegment(viewerPath: string): string {
  const normalized = viewerPath.replace(/\\/g, "/");
  const slash = normalized.indexOf("/");
  return slash < 0 ? normalized : normalized.slice(0, slash);
}

/**
 * Remove a known folder-name prefix from a viewer path, returning the
 * remainder — `""` when the path IS exactly the prefix. A path that doesn't
 * carry the prefix (and an empty prefix) is returned unchanged.
 */
export function stripViewerPrefix(viewerPath: string, prefix: string): string {
  if (!prefix) {
    return viewerPath;
  }
  if (viewerPath === prefix) {
    return "";
  }
  return viewerPath.startsWith(`${prefix}/`)
    ? viewerPath.slice(prefix.length + 1)
    : viewerPath;
}

/**
 * Join a folder-name prefix and a root-relative remainder into a viewer path.
 * An empty prefix yields the bare remainder; an empty remainder yields the bare
 * prefix (navigating to a root's own top level).
 */
export function joinViewerPath(prefix: string, rest: string): string {
  if (!prefix) {
    return rest;
  }
  return rest ? `${prefix}/${rest}` : prefix;
}

// ── Root / repo association ─────────────────────────────────────────────────

/**
 * The named root whose folder name prefixes a viewer path, if any — i.e. which
 * root (and therefore which repo) owns the path. Matches the first segment
 * against each root's `name`, falling back to its directory basename, mirroring
 * {@link resolveNamedRelativePath}.
 */
export function rootForViewerPath(
  viewerPath: string,
  namedRoots: readonly ResolverWorkspaceFolder[]
): ResolverWorkspaceFolder | undefined {
  const segment = firstViewerSegment(viewerPath);
  return namedRoots.find(
    (root) => root.name === segment || path.basename(root.fsPath) === segment
  );
}

// ── Absolute ⇄ viewer ───────────────────────────────────────────────────────

/**
 * The workspace roots a conversion resolves against. `namedRoots.length > 1`
 * means multi-root, which turns folder-name prefixing on; 0 or 1 entries keep
 * plain workspace-relative viewer paths.
 */
export interface ViewerRootContext {
  /** Absolute primary root — the single-root base and the unprefixed fallback. */
  primaryRoot: string;
  /** Open named roots in order. */
  namedRoots: readonly ResolverWorkspaceFolder[];
}

function isMultiRoot(ctx: ViewerRootContext): boolean {
  return ctx.namedRoots.length > 1;
}

/** `path.relative` with the result normalized to POSIX (`/`) separators. */
function posixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

/**
 * Absolute filesystem path → viewer path: plain workspace-relative in
 * single-root, folder-name-prefixed (`root2/src/index.ts`) in multi-root.
 * Inverse of {@link fromViewerPath}. Viewer paths always use `/` separators
 * (never OS-native `\`), so both branches normalize. A multi-root path outside
 * every named root falls back to a primary-root-relative path so callers always
 * get a usable string (containment is expected to have been validated
 * upstream).
 */
export function toViewerPath(
  absolutePath: string,
  ctx: ViewerRootContext
): string {
  const primary = path.resolve(ctx.primaryRoot);
  if (!isMultiRoot(ctx)) {
    return posixRelative(primary, absolutePath);
  }
  const root = ctx.namedRoots.find((r) =>
    isPathWithinDirectory(absolutePath, path.resolve(r.fsPath))
  );
  if (!root) {
    return posixRelative(primary, absolutePath);
  }
  return joinViewerPath(root.name, posixRelative(path.resolve(root.fsPath), absolutePath));
}

/**
 * Viewer path → absolute filesystem path. In multi-root, a bare root name
 * resolves to that root's own top level (explorer navigation), and a
 * folder-name-prefixed path resolves against the matching root via
 * {@link resolveNamedRelativePath}; everything else resolves against the
 * primary root. Inverse of {@link toViewerPath}.
 */
export function fromViewerPath(
  viewerPath: string,
  ctx: ViewerRootContext
): string {
  if (!isMultiRoot(ctx)) {
    return path.resolve(path.resolve(ctx.primaryRoot), viewerPath);
  }
  // A bare root name has no slash for `resolveNamedRelativePath` to key off, so
  // match it directly before falling through to the general resolver.
  const normalized = viewerPath.replace(/\\/g, "/");
  const exactRoot = ctx.namedRoots.find((root) => root.name === normalized);
  if (exactRoot) {
    return path.resolve(exactRoot.fsPath);
  }
  return resolveNamedRelativePath(viewerPath, ctx.primaryRoot, ctx.namedRoots);
}

export { resolveNamedRelativePath } from "./WorkspaceRootResolver";
export type { ResolverWorkspaceFolder } from "./WorkspaceRootResolver";
