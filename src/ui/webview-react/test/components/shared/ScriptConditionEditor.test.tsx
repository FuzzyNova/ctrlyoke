import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScriptConditionEditor } from "@components/shared/ScriptConditionEditor";
import { CONDITION_ACTIONS, MESSAGE_TYPES } from "@/types/messages";
import { END_CONDITION_SCRIPT_TYPES } from "@root/types/DashboardConstants";

const { notifyUserMock } = vi.hoisted(() => ({ notifyUserMock: vi.fn() }));

vi.mock("@utils/notifyUser", () => ({ notifyUser: notifyUserMock }));

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
  it("offers the shared script types and creates a starter script", async () => {
    const onChange = vi.fn();
    const postMessage = vi.fn();
    (window.vscodeApi as any).postMessage = postMessage;

    render(
      <ScriptConditionEditor
        variant="endCondition"
        value={{ returns: "true" }}
        onChange={onChange}
        idPrefix="test-condition"
      />
    );

    const picker = screen.getByRole("button", { name: "Script type" });
    fireEvent.click(picker);
    const javascriptOption = screen.getByText("JavaScript").closest("button");
    expect(javascriptOption).not.toBeNull();
    fireEvent.click(javascriptOption!);

    expect(picker).toHaveTextContent("JavaScript");
    fireEvent.click(screen.getByRole("button", { name: "Create Script" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.CREATE_END_CONDITION_SCRIPT,
      requestId: expect.any(String),
      scriptType: END_CONDITION_SCRIPT_TYPES.JAVASCRIPT,
    });

    const requestId = postMessage.mock.calls[0][0].requestId;
    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.END_CONDITION_SCRIPT_CREATED,
          requestId,
          scriptPath: "C:\\workspace\\.ctrlyoke\\scripts\\check_condition.js",
        },
      })
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Script")).toHaveValue(
        "C:\\workspace\\.ctrlyoke\\scripts\\check_condition.js"
      );
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        script: "C:\\workspace\\.ctrlyoke\\scripts\\check_condition.js",
      })
    );
    expect(notifyUserMock).toHaveBeenCalledWith(
      "Created end condition script: check_condition.js",
      "success"
    );
  });

  it("surfaces a scoped creation failure through notifyUser", async () => {
    const postMessage = vi.fn();
    (window.vscodeApi as any).postMessage = postMessage;

    render(
      <ScriptConditionEditor
        variant="endCondition"
        value={{ script: "npm test" }}
        onChange={vi.fn()}
        idPrefix="test-condition"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Script" }));
    const requestId = postMessage.mock.calls[0][0].requestId;
    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.END_CONDITION_SCRIPT_CREATION_FAILED,
          requestId,
          error: "No workspace is open.",
        },
      })
    );

    await waitFor(() => {
      expect(notifyUserMock).toHaveBeenCalledWith(
        "No workspace is open.",
        "error"
      );
    });
  });

  it("shows and edits passRetryPrompt only for pass retries", () => {
    const onChange = vi.fn();

    render(
      <ScriptConditionEditor
        variant="endCondition"
        value={{
          script: "npm test",
          returns: "true",
          onPass: CONDITION_ACTIONS.RETRY,
          passRetryPrompt: "Keep strengthening the test",
        }}
        onChange={onChange}
        idPrefix="test-condition"
      />
    );

    const editor = screen.getByLabelText("Pass Retry Prompt");
    expect(editor).toHaveAttribute("data-mode", "endCondition");
    expect(editor).toHaveAttribute("data-surface", "input");
    expect(editor).toHaveValue("Keep strengthening the test");
    expect(editor).toHaveAttribute(
      "placeholder",
      expect.stringContaining("condition still holds")
    );
    expect(screen.queryByLabelText("Retry Prompt")).not.toBeInTheDocument();

    fireEvent.change(editor, {
      target: { value: "Continue until the condition fails" },
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        passRetryPrompt: "Continue until the condition fails",
      })
    );
  });

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

  describe("scriptStep execution mode override", () => {
    function chooseExecutionMode(label: string): void {
      const current = screen.getByRole("button", { name: "Execution Mode" });
      fireEvent.click(current);
      const option = screen
        .getAllByText(label)
        .map((element) => element.closest("button"))
        .find((button) => button && button !== current);
      if (!option) throw new Error(`Execution mode option not found: ${label}`);
      fireEvent.click(option);
    }

    it("renders an Execution Mode dropdown only for the scriptStep variant", () => {
      render(
        <ScriptConditionEditor
          variant="scriptStep"
          value={{ script: "npm test" }}
          onChange={vi.fn()}
          idPrefix="test-condition"
        />
      );

      expect(
        screen.getByRole("button", { name: "Execution Mode" })
      ).toBeInTheDocument();
    });

    it.each(["endCondition", "preCondition"] as const)(
      "%s: never renders an Execution Mode dropdown — conditions always run headless",
      (variant) => {
        render(
          <ScriptConditionEditor
            variant={variant}
            value={{ script: "npm test", returns: "true" }}
            onChange={vi.fn()}
            idPrefix="test-condition"
          />
        );

        expect(
          screen.queryByRole("button", { name: "Execution Mode" })
        ).not.toBeInTheDocument();
      }
    );

    it("defaults to Inherit when unset", () => {
      render(
        <ScriptConditionEditor
          variant="scriptStep"
          value={{ script: "npm test" }}
          onChange={vi.fn()}
          idPrefix="test-condition"
        />
      );

      expect(
        screen.getByRole("button", { name: "Execution Mode" })
      ).toHaveTextContent(/Inherit/);
    });

    it("commits an explicit interactive override", () => {
      const onChange = vi.fn();
      render(
        <ScriptConditionEditor
          variant="scriptStep"
          value={{ script: "npm test" }}
          onChange={onChange}
          idPrefix="test-condition"
        />
      );

      chooseExecutionMode("Interactive");

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ executionMode: "interactive" })
      );
    });

    it("clears back to inherit when Inherit is re-selected", () => {
      const onChange = vi.fn();
      render(
        <ScriptConditionEditor
          variant="scriptStep"
          value={{ script: "npm test", executionMode: "headless" }}
          onChange={onChange}
          idPrefix="test-condition"
        />
      );

      chooseExecutionMode("Inherit (Interactive)");

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ executionMode: undefined })
      );
    });
  });
});
