import type { PlainCompletionItem } from "./CompletionCore";
import { listLocalBranches } from "../utils/GitUtils";
import { COMPLETION_ITEM_KINDS } from "../types/DashboardConstants";

const BRANCH_CACHE_DURATION_MS = 10_000;

interface BranchCacheEntry {
  branches: string[];
  timestamp: number;
}

const branchCache = new Map<string, BranchCacheEntry>();

/** Clear cached branch lists; intended for tests and workspace resets. */
export function clearBranchCompletionCache(): void {
  branchCache.clear();
}

/**
 * Return local Git branch completions for the supplied repository root.
 * Branch names are filtered by case-insensitive prefix and are never
 * excluded because they are checked out in another worktree.
 */
export async function getBranchCompletions(
  repoRoot: string | undefined,
  filterText: string
): Promise<PlainCompletionItem[]> {
  if (!repoRoot) {
    return [];
  }

  const now = Date.now();
  const cached = branchCache.get(repoRoot);
  let branches: string[];

  if (cached && now - cached.timestamp < BRANCH_CACHE_DURATION_MS) {
    branches = cached.branches;
  } else {
    try {
      branches = await listLocalBranches(repoRoot);
    } catch {
      branches = [];
    }
    branchCache.set(repoRoot, { branches, timestamp: now });
  }

  const prefix = filterText.toLocaleLowerCase();
  return branches
    .filter((branch) => branch.toLocaleLowerCase().startsWith(prefix))
    .map((branch) => ({
      label: branch,
      kind: COMPLETION_ITEM_KINDS.REFERENCE,
      insertText: branch,
      detail: "Existing branch",
    }));
}
