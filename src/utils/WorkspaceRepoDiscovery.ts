import * as fs from "fs";
import * as path from "path";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import type { WorkspaceRepo } from "../types/HostedWorkspaceViewerTypes";
import { isPathWithinDirectory } from "./PathSecurity";
import { repoToplevel } from "./GitUtils";

/**
 * Case-fold a path for identity comparison on case-insensitive filesystems
 * (Windows, default macOS). Kept in one place so repo de-duplication and
 * containment checks agree.
 */
function pathKey(p: string): string {
  const normalized = path.resolve(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Discover the distinct git repositories spanned by a set of workspace roots.
 *
 * Mirrors how VS Code models multi-root SCM: repositories are keyed by their git
 * toplevel, so two roots inside the same repo collapse to a single entry, a root
 * that is a subdirectory of a repo maps to that repo, and non-repo roots drop
 * out entirely.
 *
 * When a root IS its own repo toplevel we keep the root's own `fsPath` as
 * `rootPath` (not git's realpath-resolved toplevel) so it stays byte-identical
 * to the trusted-root path used for path-containment/prefixing elsewhere; only
 * the ancestor case (root nested below the toplevel) falls back to git's
 * realpath. This must stay the single source of repo identity shared by the
 * hosted SCM service and the snapshot/undo layer so both agree on which repo a
 * file belongs to.
 */
export async function discoverRepos(
  executionRoots: readonly ResolverWorkspaceFolder[]
): Promise<WorkspaceRepo[]> {
  const seen = new Map<string, WorkspaceRepo>();

  // Probe every root's git toplevel concurrently — each spawns its own `git`
  // process and they don't depend on one another. Results are folded into
  // `seen` afterward in the original root order so de-duplication (first root
  // wins for a shared toplevel) stays deterministic.
  const toplevels = await Promise.all(
    executionRoots.map((root) => repoToplevel(root.fsPath))
  );

  executionRoots.forEach((root, i) => {
    const top = toplevels[i];
    if (!top) return;

    // Prefer the root's own path when it is the repo toplevel, so `rootPath`
    // matches the (possibly symlinked) trusted-root path used for prefixing.
    let rootPath = top;
    try {
      if (pathKey(fs.realpathSync(root.fsPath)) === pathKey(top)) {
        rootPath = path.resolve(root.fsPath);
      }
    } catch {
      // realpath failed (root vanished) — fall back to git's toplevel
    }

    const key = pathKey(rootPath);
    if (seen.has(key)) return;

    const sameAsRoot = pathKey(rootPath) === pathKey(root.fsPath);
    const label = sameAsRoot ? root.name : path.basename(rootPath);
    seen.set(key, { id: label, label, rootPath });
  });

  // Guarantee unique ids so the UI selector can key on them safely.
  const repos = [...seen.values()];
  const usedIds = new Set<string>();
  for (const repo of repos) {
    let id = repo.label;
    let n = 2;
    while (usedIds.has(id)) {
      id = `${repo.label} (${n++})`;
    }
    usedIds.add(id);
    repo.id = id;
  }

  return repos;
}

/**
 * The discovered repo whose git toplevel owns an absolute path — the path
 * equals the toplevel or sits within it. The single containment predicate for
 * every path→repo association: the client's prefix map
 * ({@link mapRootPrefixesToRepos}) and the server's repo-scoping
 * (`resolveRepoRoot`/`requireRepoRootForPath`) all resolve through here so they
 * can never disagree about which repo a file belongs to. When repositories
 * are nested, returns the deepest containing repo (the longest resolved root).
 */
export function findRepoForPath(
  absolutePath: string,
  repos: readonly WorkspaceRepo[]
): WorkspaceRepo | undefined {
  const abs = path.resolve(absolutePath);
  let deepestMatch: WorkspaceRepo | undefined;
  let deepestRootLength = -1;
  for (const repo of repos) {
    const repoRoot = path.resolve(repo.rootPath);
    if (
      (abs === repoRoot || isPathWithinDirectory(abs, repoRoot)) &&
      repoRoot.length > deepestRootLength
    ) {
      deepestMatch = repo;
      deepestRootLength = repoRoot.length;
    }
  }
  return deepestMatch;
}

/**
 * Map each root's folder name (the viewer-path prefix it produces) to the id of
 * the repo that owns it. The client uses this to default the SCM repo selector
 * to the repo containing the open file, without reverse-engineering the mapping
 * from `label`/`id` — which diverge from the prefix when a root sits below its
 * git toplevel, and collapse when several roots share one repo.
 *
 * On duplicate root names the first wins, matching how `fromViewerPath`
 * resolves an ambiguous prefix.
 */
export function mapRootPrefixesToRepos(
  executionNamedRoots: readonly ResolverWorkspaceFolder[],
  repos: readonly WorkspaceRepo[]
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const root of executionNamedRoots) {
    if (Object.hasOwn(map, root.name)) continue;
    const repo = findRepoForPath(root.fsPath, repos);
    if (repo) {
      map[root.name] = repo.id;
    }
  }
  return map;
}
