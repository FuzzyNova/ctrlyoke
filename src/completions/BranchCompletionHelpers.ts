import type { PlainCompletionItem } from "./CompletionCore";
import { listLocalBranches } from "../utils/GitUtils";
import { COMPLETION_ITEM_KINDS } from "../types/DashboardConstants";
import { RepositoryListCache } from "./RepositoryListCache";

const branchCache = new RepositoryListCache(listLocalBranches);

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

  const branches = await branchCache.get(repoRoot);
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
