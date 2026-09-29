import type { DiffResult } from "../git/CommitMessageGenerator";
import type { GitCommitter } from "../git/GitCommitter";

export interface CommitCommandOptions {
  all?: boolean;
  yes?: boolean;
}

export type CommitCommandResult = "committed" | "aborted" | "requires-staging";

/** Commit a generated message only when the selected changes can be committed. */
export async function commitGeneratedChanges(
  diffResult: DiffResult,
  message: string,
  cwd: string,
  options: CommitCommandOptions,
  committer: Pick<GitCommitter, "commit">,
  confirm: () => Promise<boolean>
): Promise<CommitCommandResult> {
  if (!diffResult.staged && !options.all) {
    return "requires-staging";
  }
  if (!options.yes && !(await confirm())) {
    return "aborted";
  }
  await committer.commit(message, cwd, { addAll: options.all });
  return "committed";
}
