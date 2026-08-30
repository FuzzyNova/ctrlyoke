import { useRef } from "react";
import type { CompletionResult } from "@codemirror/autocomplete";
import { linter, type Diagnostic } from "@codemirror/lint";
import { SingleLineCompletionEditor } from "./SingleLineCompletionEditor";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { useCompletionRequest } from "@hooks/useCompletionRequest";
import { WebviewLog } from "@utils/logger";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { PermissionCompletionItem } from "@root/completions/PermissionListCompletionHelpers";
import type { PermissionCompletionsResponseMessage } from "@root/types/WebviewMessageTypes";
import type { SingleLineCompletionEditorProps } from "./SingleLineCompletionEditor";
import { inspectToolPatternSyntax } from "@root/utils/ToolPatternSyntax";

export type PermissionListEditorProps = Omit<
  SingleLineCompletionEditorProps,
  | "completionSource"
  | "value"
  | "onChange"
  | "onBlur"
  | "multiline"
  | "extensions"
> & {
  value: string[];
  onChange: (value: string[]) => void;
  /**
   * Called on blur with the cleaned (trimmed, blank lines dropped) value.
   * Takes the value directly rather than requiring callers to re-read their
   * own `onChange`-derived state, which would still be stale here: the
   * blur-triggered `onChange(cleaned)` call below only *schedules* a state
   * update, so a caller reading its own state synchronously afterward would
   * see the pre-cleanup value.
   */
  onBlur?: (value: string[]) => void;
};

function buildPermissionCompletionResult(
  items: PermissionCompletionItem[],
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

function parsePermissionCompletionResponse(
  data: unknown
): PermissionCompletionsResponseMessage | null {
  const message = data as Partial<PermissionCompletionsResponseMessage>;
  if (
    message.type !== MESSAGE_TYPES.PERMISSION_COMPLETIONS_RESPONSE ||
    typeof message.seq !== "number" ||
    typeof message.from !== "number" ||
    !Array.isArray(message.items)
  ) {
    return null;
  }

  return message as PermissionCompletionsResponseMessage;
}

function createPermissionListLintExtension() {
  return linter(
    (view): Diagnostic[] => {
      const diagnostics: Diagnostic[] = [];
      const { doc } = view.state;

      for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
        const line = doc.line(lineNumber);
        const pattern = line.text.trim();
        if (!pattern) continue;

        const syntax = inspectToolPatternSyntax(pattern);
        const from = line.from + line.text.indexOf(pattern);
        const to = from + pattern.length;

        if (syntax.hasUnclosedParentheses) {
          diagnostics.push({
            from,
            to,
            severity: "error",
            message: "Unclosed parentheses",
          });
        } else if (syntax.hasWildcardOutsideParentheses) {
          diagnostics.push({
            from,
            to,
            severity: "warning",
            message: "Wildcard needs enclosing parentheses, e.g. shell(*)",
          });
        } else if (syntax.doesNotMatchPattern) {
          diagnostics.push({
            from,
            to,
            severity: "error",
            message: "Invalid pattern syntax",
          });
        }
      }

      return diagnostics;
    },
    { delay: 0 }
  );
}

const permissionListLintExtension = createPermissionListLintExtension();

export function PermissionListEditor({
  value,
  onChange,
  onBlur,
  ...props
}: PermissionListEditorProps) {
  const vscode = getVsCodeApi();
  const valueRef = useRef(value);
  valueRef.current = value;
  const completionSource =
    useCompletionRequest<PermissionCompletionsResponseMessage>({
      parseResponse: parsePermissionCompletionResponse,
      buildResult: (response) => {
        WebviewLog.trace(
          `[completions:${props.id}] response seq=${response.seq} items=${response.items.length}`
        );
        return buildPermissionCompletionResult(response.items, response.from);
      },
      sendRequest: (context, seq) => {
        WebviewLog.trace(
          `[completions:${props.id}] request seq=${seq} pos=${context.pos}`
        );
        vscode.postMessage({
          type: MESSAGE_TYPES.PERMISSION_COMPLETIONS_REQUEST,
          text: context.state.doc.toString(),
          position: context.pos,
          seq,
        });
      },
    });

  // Echo back the exact split of what's in the document (no trim/filter) so
  // the value round-trips losslessly through `syncDocument` on every
  // keystroke. Trimming or dropping blank lines here would make the
  // `value` prop diverge from the live doc mid-edit — e.g. pressing Enter
  // to start a new line produces a trailing blank entry that a filter would
  // strip immediately, and `syncDocument` would then race the user's next
  // keystroke to delete the newline they just typed, corrupting input.
  const handleChange = (text: string) => {
    onChange(text.split("\n"));
  };

  // Clean up blank/whitespace-only lines once editing settles, matching the
  // trim+filter contract callers previously implemented themselves.
  const handleBlur = () => {
    const current = valueRef.current;
    const cleaned = current.map((line) => line.trim()).filter(Boolean);
    const changed =
      cleaned.length !== current.length ||
      cleaned.some((line, index) => line !== current[index]);
    if (changed) {
      onChange(cleaned);
    }
    onBlur?.(changed ? cleaned : current);
  };

  return (
    <SingleLineCompletionEditor
      {...props}
      value={value.join("\n")}
      onChange={handleChange}
      onBlur={handleBlur}
      multiline
      extensions={[permissionListLintExtension]}
      completionSource={completionSource}
    />
  );
}
