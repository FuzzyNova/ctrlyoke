import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import type { WorkspaceRepo } from "../types/HostedWorkspaceViewerTypes";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

/**
 * Case-fold a path for identity comparison on case-insensitive filesystems
 * (Windows, default macOS). Kept in one place so repo de-duplication and
 * containment checks agree.
 */
function pathKey(p: string): string {
  const normalized = path.resolve(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Returns the git toplevel (realpath, as git reports it) for a directory, or null when it isn't in a repo. */
async function gitToplevel(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "rev-parse", "--show-toplevel"],
      { timeout: GIT_TIMEOUT_MS }
    );
    const top = stdout.trim();
    return top ? path.normalize(top) : null;
  } catch {
    return null;
  }
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
  roots: readonly ResolverWorkspaceFolder[]
): Promise<WorkspaceRepo[]> {
  const seen = new Map<string, WorkspaceRepo>();

  for (const root of roots) {
    const top = await gitToplevel(root.fsPath);
    if (!top) continue;

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
    if (seen.has(key)) continue;

    const sameAsRoot = pathKey(rootPath) === pathKey(root.fsPath);
    const label = sameAsRoot ? root.name : path.basename(rootPath);
    seen.set(key, { id: label, label, rootPath });
  }

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
