import {
  GIT_LIST_KINDS,
  GitListCompletionEditor,
  type GitListEditorProps,
} from "./GitListCompletionEditor";

/** Local Git branch field: suggests existing branches, accepts new names. */
export function BranchNameEditor(props: GitListEditorProps) {
  return <GitListCompletionEditor {...props} kind={GIT_LIST_KINDS.BRANCH} />;
}
