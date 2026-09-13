import type { CompletionResult } from "@codemirror/autocomplete";
import { useCompletionRequest } from "@hooks/useCompletionRequest";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { WebviewLog } from "@utils/logger";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { BranchListResponseMessage } from "@root/types/WebviewMessageTypes";
import { SingleLineCompletionEditor } from "./SingleLineCompletionEditor";
import type { SingleLineCompletionEditorProps } from "./SingleLineCompletionEditor";

type BranchNameEditorProps = Omit<
  SingleLineCompletionEditorProps,
  "completionSource"
>;

// Matches the control-surface typography (Tailwind `text-xs`, as used by
// cy-select-trigger/CustomSelect and the other form inputs this editor sits
// beside) instead of the VS Code *editor* font size the CodeMirror theme
// defaults to. Callers can still override via props.fontSize.
const CONTROL_FONT_SIZE = "0.75rem";

function parseBranchListResponse(
  data: unknown
): BranchListResponseMessage | null {
  const message = data as Partial<BranchListResponseMessage>;
  if (
    message.type !== MESSAGE_TYPES.BRANCH_LIST_RESPONSE ||
    typeof message.seq !== "number" ||
    !Array.isArray(message.items)
  ) {
    return null;
  }

  return message as BranchListResponseMessage;
}

function buildBranchCompletionResult(
  items: BranchListResponseMessage["items"]
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

export function BranchNameEditor(props: BranchNameEditorProps) {
  const vscode = getVsCodeApi();
  const completionSource = useCompletionRequest<BranchListResponseMessage>({
    parseResponse: parseBranchListResponse,
    buildResult: (response) => {
      WebviewLog.trace(
        `[completions:${props.id}] response seq=${response.seq} items=${response.items.length}`
      );
      return buildBranchCompletionResult(response.items);
    },
    sendRequest: (context, seq) => {
      WebviewLog.trace(
        `[completions:${props.id}] request seq=${seq} pos=${context.pos}`
      );
      vscode.postMessage({
        type: MESSAGE_TYPES.BRANCH_LIST_REQUEST,
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
