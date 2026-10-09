import { describe, expect, it } from "vitest";
import {
  CompletionContext,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { promptTokenLanguageDataExtension } from "@utils/promptCompletion/promptTokenCompletionExtension";
import { createWorkflowContextCompletionSource } from "@utils/promptCompletion/promptTokenCompletionExtension";
import { getContextualPriorCompletions } from "@root/completions/PromptContextCompletions";

describe("promptTokenLanguageDataExtension", () => {
  const source: CompletionSource = () => ({
    from: 0,
    options: [{ label: "item" }],
  });

  function sourcesAt(state: EditorState): readonly CompletionSource[] {
    return state.languageDataAt<CompletionSource>("autocomplete", 0);
  }

  it("registers each source as autocomplete language data", () => {
    const state = EditorState.create({
      doc: "@",
      extensions: promptTokenLanguageDataExtension({ sources: [source] }),
    });
    const [registered] = sourcesAt(state);
    expect(registered(new CompletionContext(state, 1, true))).toMatchObject({
      options: [{ label: "item" }],
    });
  });

  it("skips sources where the gate rejects the position", () => {
    const state = EditorState.create({
      doc: "@",
      extensions: promptTokenLanguageDataExtension({
        sources: [source],
        gate: (context) => context.pos > 5,
      }),
    });
    const [registered] = sourcesAt(state);
    expect(registered(new CompletionContext(state, 1, true))).toBeNull();
  });
});

describe("workflow-aware prompt completions", () => {
  const workflowContext = {
    stepNames: ["Setup"],
    vars: { project_name: "demo" },
    field: "retryPrompt" as const,
    hasPreCondition: true,
    stepCount: 1,
    hasFinalStep: true,
  };
  const source = createWorkflowContextCompletionSource(
    { customSource: () => null },
    () => workflowContext,
    getContextualPriorCompletions
  );

  it("offers named prior steps without an out-of-range step", async () => {
    const state = EditorState.create({ doc: "$step:" });
    const result = await source(
      new CompletionContext(state, state.doc.length, true)
    );
    expect(result?.options.map((item) => [item.label, item.detail])).toEqual([
      ["step:1", "Step 1: Setup"],
    ]);
  });

  it("offers declared variables after `{{`", async () => {
    const state = EditorState.create({ doc: "{{project" });
    const result = await source(
      new CompletionContext(state, state.doc.length, true)
    );
    expect(result?.options.map((item) => [item.label, item.apply])).toEqual([
      ["project_name", "project_name}} "],
    ]);
  });

  it("keeps an existing variable closer when completing inside `{{foo}}`", async () => {
    const state = EditorState.create({ doc: "{{project}}" });
    const result = await source(
      new CompletionContext(state, state.doc.length - 2, true)
    );
    expect(
      result?.options.find((item) => item.label === "project_name")?.apply
    ).toBe("project_name");
  });

  it("gates retry and condition-output completions consistently", async () => {
    const promptState = EditorState.create({ doc: "$" });
    const promptSource = createWorkflowContextCompletionSource(
      { customSource: () => null },
      () => ({ ...workflowContext, field: "prompt", hasPreCondition: false }),
      getContextualPriorCompletions
    );
    const result = await promptSource(
      new CompletionContext(promptState, 1, true)
    );
    expect(result?.options.map((item) => item.label)).not.toContain(
      "endCondition:stdout"
    );
    expect(result?.options.map((item) => item.label)).not.toContain(
      "preCondition:stdout"
    );
  });
});
