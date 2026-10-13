import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { CTRLYOKE_FILE_KINDS } from "@root/types/DashboardConstants";
import { createWorkflowFileCompletionExtension } from "@utils/workflowFileSupport/workflowFileCompletionExtension";
import * as workflowFileSupport from "@utils/workflowFileSupport/workflowFileSupport";

describe("workflow file prompt completions", () => {
  it("offers pre-condition tokens when the settings default is configured", () => {
    const text = 'steps:\n  - prompt: "Check $preC"\n';
    const pos = text.indexOf("$preC") + "$preC".length;
    const extension = createWorkflowFileCompletionExtension({
      kind: CTRLYOKE_FILE_KINDS.WORKFLOW_YAML,
      getSupport: () => workflowFileSupport,
      getDataSource: () => ({}) as never,
      getSettingsPreCondition: () => ({ script: "echo hi" }),
      promptClient: { customSource: () => null } as never,
      transport: {} as never,
    });
    const state = EditorState.create({ doc: text, extensions: extension });
    const sources = state.languageDataAt<
      (context: CompletionContext) => unknown
    >("autocomplete", pos);
    const results = sources.map((source) =>
      source(new CompletionContext(state, pos, true))
    );
    const items = results.flatMap((result) =>
      result && typeof result === "object" && "options" in result
        ? (result.options as Array<{ label: string }>).map((item) => item.label)
        : []
    );

    expect(items).toContain("preCondition:stdout");
  });
});
