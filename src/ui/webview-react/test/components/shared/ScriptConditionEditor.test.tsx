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
    surface,
    className,
  }: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    readOnly?: boolean;
    mode?: string;
    surface?: string;
    className?: string;
  }) => (
    <textarea
      id={id}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder={placeholder}
      disabled={readOnly}
      data-mode={mode}
      data-surface={surface}
      className={className}
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
    expect(editor).toHaveAttribute("data-surface", "input");
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

  describe("timeout inherit-from-settings behavior", () => {
    it.each(["endCondition", "preCondition", "scriptStep"] as const)(
      "%s: renders an empty timeout with an inherit placeholder when unset",
      (variant) => {
        render(
          <ScriptConditionEditor
            variant={variant}
            value={{ script: "npm test", returns: "true" }}
            onChange={vi.fn()}
            idPrefix="test-condition"
          />
        );

        const timeout = screen.getByLabelText("Timeout (ms)");
        expect(timeout).toHaveValue(null);
        expect(timeout).toHaveAttribute(
          "placeholder",
          "Default (from settings)"
        );
      }
    );

    it.each(["endCondition", "preCondition", "scriptStep"] as const)(
      "%s: clearing the timeout field commits undefined (inherit)",
      (variant) => {
        const onChange = vi.fn();
        render(
          <ScriptConditionEditor
            variant={variant}
            value={{ script: "npm test", returns: "true", timeout: 5000 }}
            onChange={onChange}
            idPrefix="test-condition"
          />
        );

        const timeout = screen.getByLabelText("Timeout (ms)");
        fireEvent.change(timeout, { target: { value: "" } });
        fireEvent.blur(timeout);

        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({ timeout: undefined })
        );
      }
    );

    it.each(["endCondition", "preCondition", "scriptStep"] as const)(
      "%s: commits an explicit timeout verbatim without clamping",
      (variant) => {
        const onChange = vi.fn();
        render(
          <ScriptConditionEditor
            variant={variant}
            value={{ script: "npm test", returns: "true" }}
            onChange={onChange}
            idPrefix="test-condition"
          />
        );

        const timeout = screen.getByLabelText("Timeout (ms)");
        fireEvent.change(timeout, { target: { value: "500" } });
        fireEvent.blur(timeout);

        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({ timeout: 500 })
        );
      }
    );
  });
});
