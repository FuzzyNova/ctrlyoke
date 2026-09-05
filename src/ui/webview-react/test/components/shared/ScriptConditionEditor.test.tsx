import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
    onBlur,
    placeholder,
    readOnly,
    mode,
    surface,
    className,
  }: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    onBlur?: () => void;
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
      onBlur={onBlur}
      placeholder={placeholder}
      disabled={readOnly}
      data-mode={mode}
      data-surface={surface}
      className={className}
      data-testid="retry-prompt-editor"
    />
  ),
}));

vi.mock("@components/shared/ScriptCommandEditor", () => ({
  ScriptCommandEditor: ({
    id,
    value,
    onChange,
    onBlur,
    placeholder,
    disabled,
    className,
    multiline,
  }: {
    id: string;
    value: string;
    onChange: (value: string) => void;
    onBlur?: () => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    multiline?: boolean;
  }) => (
    <input
      type="text"
      id={id}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      data-multiline={multiline ? "true" : "false"}
    />
  ),
}));

describe("ScriptConditionEditor", () => {
  beforeAll(() => {
    if (!Range.prototype.getClientRects) {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [],
      });
    }
  });

  it("opens the script creation modal and creates a named starter script", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Create New Script" }));

    const picker = screen.getByRole("button", { name: "Script type" });
    fireEvent.click(picker);
    const javascriptOption = screen.getByText("JavaScript").closest("button");
    expect(javascriptOption).not.toBeNull();
    fireEvent.click(javascriptOption!);

    expect(picker).toHaveTextContent("JavaScript");
    expect(screen.getByLabelText("Script name")).toHaveValue(
      "check_condition.js"
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Script" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.CREATE_END_CONDITION_SCRIPT,
      requestId: expect.any(String),
      scriptType: END_CONDITION_SCRIPT_TYPES.JAVASCRIPT,
      scriptName: "check_condition.js",
    });

    const createRequest = postMessage.mock.calls.find(
      ([message]) => message.type === MESSAGE_TYPES.CREATE_END_CONDITION_SCRIPT
    )?.[0];
    const requestId = createRequest.requestId;
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

    fireEvent.click(screen.getByRole("button", { name: "Create New Script" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Script" }));
    const requestId = postMessage.mock.calls.find(
      ([message]) => message.type === MESSAGE_TYPES.CREATE_END_CONDITION_SCRIPT
    )?.[0].requestId;
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

  it("does not create a script when the modal is cancelled", () => {
    const postMessage = vi.fn();
    (window.vscodeApi as any).postMessage = postMessage;

    render(
      <ScriptConditionEditor
        variant="endCondition"
        value={{}}
        onChange={vi.fn()}
        idPrefix="test-condition"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Create New Script" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      postMessage.mock.calls.filter(
        ([message]) =>
          message.type === MESSAGE_TYPES.CREATE_END_CONDITION_SCRIPT
      )
    ).toHaveLength(0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["endCondition", "preCondition", "scriptStep"] as const)(
    "%s commits script edits on blur instead of every keystroke",
    async (variant) => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(
        <ScriptConditionEditor
          variant={variant}
          value={{ script: "" }}
          onChange={onChange}
          idPrefix={`test-${variant}`}
        />
      );

      const script = document.getElementById(`test-${variant}-script`);
      if (!script) throw new Error("Script editor was not rendered");
      await user.click(script);
      await user.type(script, "npm test && npm run lint");

      expect(onChange).not.toHaveBeenCalled();

      fireEvent.blur(script);

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({ script: "npm test && npm run lint" })
        );
      });
    }
  );

  it.each(["endCondition", "preCondition", "scriptStep"] as const)(
    "%s opts its script field into multiline mode",
    (variant) => {
      render(
        <ScriptConditionEditor
          variant={variant}
          value={{ script: "npm test" }}
          onChange={vi.fn()}
          idPrefix={`test-${variant}`}
        />
      );

      expect(
        document.getElementById(`test-${variant}-script`)
      ).toHaveAttribute("data-multiline", "true");
    }
  );

  it.each(["preCondition", "endCondition"] as const)(
    "%s renders and round-trips environment variables",
    (variant) => {
      const onChange = vi.fn();
      render(
        <ScriptConditionEditor
          variant={variant}
          value={{
            script: "npm test",
            returns: "true",
            env: { CI_TOKEN: "${secret:CI_TOKEN}" },
          }}
          onChange={onChange}
          idPrefix={`test-${variant}`}
        />
      );

      const env = screen.getByLabelText(`test-${variant}-env`);
      expect(env).toHaveValue("CI_TOKEN=${secret:CI_TOKEN}");
      fireEvent.change(env, {
        target: { value: "CI_TOKEN=${secret:CI_TOKEN}\nMODE=ci" },
      });
      fireEvent.blur(env);

      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          env: {
            CI_TOKEN: "${secret:CI_TOKEN}",
            MODE: "ci",
          },
        })
      );
    }
  );

  it.each(["preCondition", "endCondition"] as const)(
    "%s clears environment variables instead of persisting an empty map",
    (variant) => {
      const onChange = vi.fn();
      render(
        <ScriptConditionEditor
          variant={variant}
          value={{
            script: "npm test",
            returns: "true",
            env: { CI_TOKEN: "${secret:CI_TOKEN}" },
          }}
          onChange={onChange}
          idPrefix={`test-${variant}`}
        />
      );

      const env = screen.getByLabelText(`test-${variant}-env`);
      fireEvent.change(env, {
        target: { value: "" },
      });
      fireEvent.blur(env);

      const updated = onChange.mock.lastCall?.[0] as {
        env?: Record<string, string>;
      };
      expect(updated.env).toBeUndefined();
      expect(updated.env).not.toEqual({});
    }
  );

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

    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(editor);

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
          retryPrompt: "Fix $preCondition:stderr",
        }}
        onChange={onChange}
        idPrefix="test-condition"
      />
    );

    const editor = screen.getByLabelText("Retry Prompt");
    expect(editor).toHaveAttribute("data-mode", "endCondition");
    expect(editor).toHaveAttribute("data-surface", "input");
    expect(
      screen.getByText(/Type \$ for condition-output references/)
    ).toHaveTextContent("$preCondition:stderr");

    fireEvent.change(editor, {
      target: { value: "Use $preCondition:stdout and $endCondition:stderr" },
    });

    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(editor);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        retryPrompt: "Use $preCondition:stdout and $endCondition:stderr",
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

  describe("shell override", () => {
    it("commits a shell override on blur", () => {
      const onChange = vi.fn();

      render(
        <ScriptConditionEditor
          variant="scriptStep"
          value={{ script: "npm test" }}
          onChange={onChange}
          idPrefix="test-script"
        />
      );

      const shell = screen.getByLabelText("Shell");
      fireEvent.change(shell, { target: { value: "bash" } });
      fireEvent.blur(shell);

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ shell: "bash" })
      );
    });

    it("clears a shell override as undefined", () => {
      const onChange = vi.fn();

      render(
        <ScriptConditionEditor
          variant="endCondition"
          value={{ script: "npm test", shell: "pwsh" }}
          onChange={onChange}
          idPrefix="test-end"
        />
      );

      const shell = screen.getByLabelText("Shell");
      fireEvent.change(shell, { target: { value: "" } });
      fireEvent.blur(shell);

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ shell: undefined })
      );
      expect(onChange.mock.lastCall?.[0]).not.toHaveProperty("shell", "");
    });

    it.each(["scriptStep", "preCondition", "endCondition"] as const)(
      "%s renders the shell field",
      (variant) => {
        render(
          <ScriptConditionEditor
            variant={variant}
            value={{ script: "npm test" }}
            onChange={vi.fn()}
            idPrefix={`test-${variant}`}
          />
        );

        expect(screen.getByLabelText("Shell")).toHaveAttribute(
          "placeholder",
          "Auto (terminal.shellExecutable, or platform default)"
        );
      }
    );

    it("round-trips an existing shell override into the input", () => {
      render(
        <ScriptConditionEditor
          variant="preCondition"
          value={{ script: "npm test", shell: "/bin/zsh" }}
          onChange={vi.fn()}
          idPrefix="test-pre"
        />
      );

      expect(screen.getByLabelText("Shell")).toHaveValue("/bin/zsh");
    });
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

  describe("script environment", () => {
    it.each(["scriptStep", "preCondition", "endCondition"] as const)(
      "%s renders and round-trips the environment map",
      (variant) => {
        const onChange = vi.fn();

        render(
          <ScriptConditionEditor
            variant={variant}
            value={{ script: "npm test", env: { CI: "true" } }}
            onChange={onChange}
            idPrefix={`test-${variant}`}
          />
        );

        const env = screen.getByLabelText(`test-${variant}-env`);
        expect(env).toHaveValue("CI=true");
        fireEvent.change(env, { target: { value: "CI=true\nTOKEN=value" } });
        fireEvent.blur(env);

        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({
            env: { CI: "true", TOKEN: "value" },
          })
        );
      }
    );
  });
});
