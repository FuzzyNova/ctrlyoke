import type { CompletionResult } from "@codemirror/autocomplete";
import { linter, type Diagnostic } from "@codemirror/lint";
import { SingleLineCompletionEditor } from "./SingleLineCompletionEditor";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { useCompletionRequest } from "@hooks/useCompletionRequest";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { PermissionCompletionItem } from "@root/completions/PermissionListCompletionHelpers";
import type { PermissionCompletionsResponseMessage } from "@root/types/WebviewMessageTypes";
import type { SingleLineCompletionEditorProps } from "./SingleLineCompletionEditor";
import { inspectToolPatternSyntax } from "@root/utils/ToolPatternSyntax";

export type PermissionListEditorProps = Omit<
  SingleLineCompletionEditorProps,
  "completionSource" | "value" | "onChange" | "multiline" | "extensions"
> & {
  value: string[];
  onChange: (value: string[]) => void;
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
  ...props
}: PermissionListEditorProps) {
  const vscode = getVsCodeApi();
  const completionSource =
    useCompletionRequest<PermissionCompletionsResponseMessage>({
      parseResponse: parsePermissionCompletionResponse,
      buildResult: (response) =>
        buildPermissionCompletionResult(response.items, response.from),
      sendRequest: (context, seq) => {
        vscode.postMessage({
          type: MESSAGE_TYPES.PERMISSION_COMPLETIONS_REQUEST,
          text: context.state.doc.toString(),
          position: context.pos,
          seq,
        });
      },
    });

  const handleChange = (text: string) => {
    onChange(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    );
  };

  return (
    <SingleLineCompletionEditor
      {...props}
      value={value.join("\n")}
      onChange={handleChange}
      multiline
      extensions={[permissionListLintExtension]}
      completionSource={completionSource}
    />
  );
}
