import type { CompletionResult } from "@codemirror/autocomplete";
import { useCompletionRequest } from "@hooks/useCompletionRequest";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { WebviewLog } from "@utils/logger";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type {
  BranchListResponseMessage,
  WorktreeDirectoryListResponseMessage,
} from "@root/types/WebviewMessageTypes";
import { SingleLineCompletionEditor } from "./SingleLineCompletionEditor";
import type { SingleLineCompletionEditorProps } from "./SingleLineCompletionEditor";

/** A host round trip that lists Git names (branches, worktree directories). */
type GitListResponseMessage =
  BranchListResponseMessage | WorktreeDirectoryListResponseMessage;

export const GIT_LIST_KINDS = {
  BRANCH: {
    request: MESSAGE_TYPES.BRANCH_LIST_REQUEST,
    response: MESSAGE_TYPES.BRANCH_LIST_RESPONSE,
  },
  WORKTREE_DIRECTORY: {
    request: MESSAGE_TYPES.WORKTREE_DIRECTORY_LIST_REQUEST,
    response: MESSAGE_TYPES.WORKTREE_DIRECTORY_LIST_RESPONSE,
  },
} as const;

export type GitListKind = (typeof GIT_LIST_KINDS)[keyof typeof GIT_LIST_KINDS];

export type GitListEditorProps = Omit<
  SingleLineCompletionEditorProps,
  "completionSource"
>;

// Matches the control-surface typography (Tailwind `text-xs`, as used by
// cy-select-trigger/CustomSelect and the other form inputs this editor sits
// beside) instead of the VS Code *editor* font size the CodeMirror theme
// defaults to. Callers can still override via props.fontSize.
const CONTROL_FONT_SIZE = "0.75rem";

function parseGitListResponse(
  kind: GitListKind,
  data: unknown
): GitListResponseMessage | null {
  const message = data as Partial<GitListResponseMessage>;
  if (
    message.type !== kind.response ||
    typeof message.seq !== "number" ||
    !Array.isArray(message.items)
  ) {
    return null;
  }

  return message as GitListResponseMessage;
}

function buildGitListCompletionResult(
  items: GitListResponseMessage["items"]
): CompletionResult | null {
  if (items.length === 0) return null;

  return {
    from: 0,
    filter: false,
    options: items.map((item, index) => ({
      label: item.label,
      detail: item.detail,
      info: item.documentation,
      apply: item.insertText,
      boost: -index,
    })),
  };
}

/**
 * Single-line field whose whole value is one Git name the host lists. Free
 * text always stays: an unmatched value (a new branch, a new worktree directory)
 * is as valid as a suggestion.
 */
export function GitListCompletionEditor({
  kind,
  ...props
}: GitListEditorProps & { kind: GitListKind }) {
  const vscode = getVsCodeApi();
  const completionSource = useCompletionRequest<GitListResponseMessage>({
    parseResponse: (data) => parseGitListResponse(kind, data),
    buildResult: (response) => {
      WebviewLog.trace(
        `[completions:${props.id}] response seq=${response.seq} items=${response.items.length}`
      );
      return buildGitListCompletionResult(response.items);
    },
    sendRequest: (context, seq) => {
      WebviewLog.trace(
        `[completions:${props.id}] request seq=${seq} pos=${context.pos}`
      );
      vscode.postMessage({
        type: kind.request,
        filterText: context.state.doc.toString(),
        seq,
      });
    },
  });

  return (
    <SingleLineCompletionEditor
      {...props}
      fontSize={props.fontSize ?? CONTROL_FONT_SIZE}
      completionSource={completionSource}
    />
  );
}
