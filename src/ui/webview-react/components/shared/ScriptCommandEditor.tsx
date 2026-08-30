import type { CompletionResult } from "@codemirror/autocomplete";
import { SingleLineCompletionEditor } from "./SingleLineCompletionEditor";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { ScriptCompletionItem } from "@root/completions/ScriptCommandCompletionHelpers";
import type { ScriptCompletionsResponseMessage } from "@root/types/WebviewMessageTypes";
import type { SingleLineCompletionEditorProps } from "./SingleLineCompletionEditor";
import { useCompletionRequest } from "@hooks/useCompletionRequest";
import { WebviewLog } from "@utils/logger";

type ScriptCommandEditorProps = Omit<
  SingleLineCompletionEditorProps,
  "completionSource"
>;

function buildScriptCompletionResult(
  items: ScriptCompletionItem[],
  from: number
): CompletionResult {
  return {
    from,
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

function parseScriptCompletionResponse(
  data: unknown
): ScriptCompletionsResponseMessage | null {
  const message = data as Partial<ScriptCompletionsResponseMessage>;
  if (
    message.type !== MESSAGE_TYPES.SCRIPT_COMPLETIONS_RESPONSE ||
    typeof message.seq !== "number" ||
    typeof message.from !== "number" ||
    !Array.isArray(message.items)
  ) {
    return null;
  }

  return message as ScriptCompletionsResponseMessage;
}

export function ScriptCommandEditor(props: ScriptCommandEditorProps) {
  const vscode = getVsCodeApi();
  const completionSource =
    useCompletionRequest<ScriptCompletionsResponseMessage>({
      parseResponse: parseScriptCompletionResponse,
      buildResult: (response) => {
        WebviewLog.trace(
          `[completions:${props.id}] response seq=${response.seq} items=${response.items.length}`
        );
        return buildScriptCompletionResult(response.items, response.from);
      },
      sendRequest: (context, seq) => {
        WebviewLog.trace(
          `[completions:${props.id}] request seq=${seq} pos=${context.pos}`
        );
        vscode.postMessage({
          type: MESSAGE_TYPES.SCRIPT_COMPLETIONS_REQUEST,
          text: context.state.doc.toString(),
          position: context.pos,
          seq,
        });
      },
    });

  return (
    <SingleLineCompletionEditor
      {...props}
      completionSource={completionSource}
    />
  );
}
