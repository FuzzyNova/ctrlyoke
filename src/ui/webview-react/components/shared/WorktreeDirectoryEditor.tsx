import {
  GIT_LIST_KINDS,
  GitListCompletionEditor,
  type GitListEditorProps,
} from "./GitListCompletionEditor";

/**
 * Named worktree `directory` field: suggests linked worktrees that can be
 * reused (never the source checkout or a managed run's worktree) and accepts
 * a new directory name or path.
 */
export function WorktreeDirectoryEditor(props: GitListEditorProps) {
  return (
    <GitListCompletionEditor
      {...props}
      kind={GIT_LIST_KINDS.WORKTREE_DIRECTORY}
    />
  );
}
