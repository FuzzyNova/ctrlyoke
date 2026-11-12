import type { PlainCompletionItem } from "./CompletionCore";
import { COMPLETION_ITEM_KINDS } from "../types/DashboardConstants";
import {
  WorktreeManager,
  type WorktreeDirectoryCandidate,
} from "../core/orchestration/WorktreeManager";
import { RepositoryListCache } from "./RepositoryListCache";

const directoryCache = new RepositoryListCache<WorktreeDirectoryCandidate>(
  (repoRoot) => new WorktreeManager().listWorktreeDirectories(repoRoot)
);

/** Clear cached worktree directory lists; intended for tests and workspace resets. */
export function clearWorktreeDirectoryCompletionCache(): void {
  directoryCache.clear();
}

function describeDirectoryBranch(
  candidate: WorktreeDirectoryCandidate
): string {
  if (candidate.branchName) return `on ${candidate.branchName}`;
  return candidate.detached ? "detached HEAD" : "Existing worktree";
}

/**
 * Return the linked worktrees a named worktree's `directory` can reuse,
 * filtered by case-insensitive prefix of the directory name. The field also
 * accepts a new directory name or a path, so an empty list never blocks
 * typing.
 */
export async function getWorktreeDirectoryCompletions(
  repoRoot: string | undefined,
  filterText: string
): Promise<PlainCompletionItem[]> {
  if (!repoRoot) {
    return [];
  }

  const candidates = await directoryCache.get(repoRoot);
  const prefix = filterText.toLocaleLowerCase();
  return candidates
    .filter((candidate) =>
      candidate.name.toLocaleLowerCase().startsWith(prefix)
    )
    .map((candidate) => ({
      label: candidate.name,
      kind: COMPLETION_ITEM_KINDS.REFERENCE,
      insertText: candidate.name,
      detail: describeDirectoryBranch(candidate),
      documentation: candidate.worktreePath,
    }));
}
