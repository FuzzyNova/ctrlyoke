import type {
  CommitMessageGenerator,
  DiffResult,
} from "../git/CommitMessageGenerator";
import type { GitCommitter } from "../git/GitCommitter";

export interface CommitCommandOptions {
  all?: boolean;
  yes?: boolean;
}

export type CommitCommandResult = "committed" | "aborted" | "requires-staging";

export async function generateCommitMessageForChanges(
  generator: Pick<CommitMessageGenerator, "getDiff" | "generateMessage">,
  cwd: string,
  options: CommitCommandOptions,
  instructions?: string
): Promise<
  | { diffResult: null }
  | { diffResult: DiffResult; message: string }
> {
  const diffResult = await generator.getDiff(cwd, {
    includeUnstaged: options.all,
  });
  if (!diffResult) {
    return { diffResult: null };
  }
  const { message } = await generator.generateMessage(
    diffResult.diff,
    cwd,
    undefined,
    instructions
  );
  return { diffResult, message };
}

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
