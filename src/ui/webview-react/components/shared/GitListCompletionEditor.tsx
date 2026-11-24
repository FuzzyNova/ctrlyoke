import {
  autocompletion,
  type Completion,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { useCompletionRequest } from "@hooks/useCompletionRequest";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { WebviewLog } from "@utils/logger";
import { SCM_CHANGE_COUNT_COLOR_CLASS } from "@utils/scmStatus";
import { formatRelativeTimeVerbose } from "@utils/time";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type {
  BranchListResponseMessage,
  WorktreeDirectoryListResponseMessage,
} from "@root/types/WebviewMessageTypes";
import type { LocalBranchSummary } from "@root/utils/GitUtils";
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

/** A dropdown option carrying the extra rows this editor renders itself. */
interface GitListCompletion extends Completion {
  branch?: LocalBranchSummary;
  /** Shown as a second, muted line (e.g. a worktree's full path). */
  secondaryLine?: string;
}

// Matches the control-surface typography (Tailwind `text-xs`, as used by
// cy-select-trigger/CustomSelect and the other form inputs this editor sits
// beside) instead of the VS Code *editor* font size the CodeMirror theme
// defaults to. Callers can still override via props.fontSize.
const CONTROL_FONT_SIZE = "0.75rem";

const BRANCH_STATUS_CLASS = "cm-gitListBranchStatus";
const SECONDARY_LINE_CLASS = "cm-gitListSecondaryLine";

// After the label (50) and CodeMirror's own detail (80).
const BRANCH_STATUS_POSITION = 60;
const SECONDARY_LINE_POSITION = 90;

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
    options: items.map((item, index): GitListCompletion => ({
      label: item.label,
      detail: item.detail,
      // Rendered inside the row rather than as CodeMirror's `info`, which
      // floats a separate box beside the dropdown.
      secondaryLine: item.documentation,
      branch: item.branch,
      apply: item.insertText,
      boost: -index,
    })),
  };
}

function appendText(parent: HTMLElement, text: string, className: string) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  parent.appendChild(span);
}

/**
 * posh-git's upstream markers (`≡` in sync, `↓behind ↑ahead`, `×` upstream
 * gone), colored like `WorktreeGitStatus`, then the tip commit's age.
 */
function renderBranchStatus(completion: Completion): Node | null {
  const branch = (completion as GitListCompletion).branch;
  if (!branch) return null;

  const status = document.createElement("span");
  status.className = BRANCH_STATUS_CLASS;
  if (branch.upstreamGone) {
    appendText(status, "×", SCM_CHANGE_COUNT_COLOR_CLASS.deleted);
  } else if (branch.upstream) {
    if (branch.ahead === 0 && branch.behind === 0) {
      appendText(status, "≡", "text-description-fg");
    }
    if (branch.behind > 0) {
      appendText(
        status,
        `↓${branch.behind}`,
        SCM_CHANGE_COUNT_COLOR_CLASS.deleted
      );
    }
    if (branch.ahead > 0) {
      appendText(
        status,
        `↑${branch.ahead}`,
        SCM_CHANGE_COUNT_COLOR_CLASS.added
      );
    }
  }
  const age = formatRelativeTimeVerbose(branch.committedAtMs);
  if (age) appendText(status, age, "text-description-fg");

  status.title = [
    branch.upstreamGone
      ? `Upstream ${branch.upstream ?? "branch"} is gone`
      : branch.upstream
        ? `Tracks ${branch.upstream}: ${branch.ahead} ahead, ${branch.behind} behind`
        : "No upstream branch",
    age ? `Last commit ${age.toLocaleLowerCase()}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  return status.childElementCount > 0 ? status : null;
}

function renderSecondaryLine(completion: Completion): Node | null {
  const text = (completion as GitListCompletion).secondaryLine;
  if (!text) return null;

  const line = document.createElement("div");
  line.className = SECONDARY_LINE_CLASS;
  line.textContent = text;
  // The line truncates in a narrow dropdown; hovering shows all of it.
  line.title = text;
  return line;
}

// Scoped through the editor's theme class, which CodeMirror also puts on the
// tooltip container, so these rules reach the dropdown mounted on <body>.
const gitListOptionTheme = EditorView.theme({
  [`.${BRANCH_STATUS_CLASS}`]: {
    display: "inline-flex",
    gap: "0.5em",
    marginLeft: "0.85em",
  },
  [`.${SECONDARY_LINE_CLASS}`]: {
    color: "var(--vscode-descriptionForeground)",
    fontSize: "0.9em",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    paddingTop: "1px",
  },
});

const gitListOptionExtensions = [
  autocompletion({
    addToOptions: [
      { render: renderBranchStatus, position: BRANCH_STATUS_POSITION },
      { render: renderSecondaryLine, position: SECONDARY_LINE_POSITION },
    ],
  }),
  gitListOptionTheme,
];

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
      // The host lists every name for an empty field, so a click or tap can
      // show the choices before anything is typed.
      openCompletionsOnPointerFocus={
        props.openCompletionsOnPointerFocus ?? true
      }
      extensions={[...gitListOptionExtensions, ...(props.extensions ?? [])]}
      completionSource={completionSource}
    />
  );
}
