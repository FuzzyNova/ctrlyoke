import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScriptConditionEditor } from "@components/shared/ScriptConditionEditor";
import { CONDITION_ACTIONS } from "@/types/messages";

vi.mock("@components/editor/CodeMirrorEditor", () => ({
  CodeMirrorEditor: ({
    id,
    value,
    onChange,
    placeholder,
    readOnly,
    mode,
  }: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    readOnly?: boolean;
    mode?: string;
  }) => (
    <textarea
      id={id}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder={placeholder}
      disabled={readOnly}
      data-mode={mode}
      data-testid="retry-prompt-editor"
    />
  ),
}));

describe("ScriptConditionEditor", () => {
  it("edits retryPrompt through the end condition CodeMirror mode", () => {
    const onChange = vi.fn();

    render(
      <ScriptConditionEditor
        variant="endCondition"
        value={{
          script: "npm test",
          returns: "true",
          onFail: CONDITION_ACTIONS.RETRY,
          retryPrompt: "Fix {stderr}",
        }}
        onChange={onChange}
        idPrefix="test-condition"
      />
    );

    const editor = screen.getByLabelText("Retry Prompt");
    expect(editor).toHaveAttribute("data-mode", "endCondition");
    expect(editor).toHaveAttribute(
      "placeholder",
      "Validation failed: {stderr}\n\nPlease fix the issues."
    );
    expect(screen.getByText(/Type \{/)).toHaveTextContent("{stderr}");

    fireEvent.change(editor, {
      target: { value: "Use {stdout} and {stderr}" },
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        retryPrompt: "Use {stdout} and {stderr}",
      })
    );
  });
});
