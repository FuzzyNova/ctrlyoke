import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { HooksEditor } from "@components/editor/HooksEditor";
import { HARNESS_IDS } from "@root/types/DashboardConstants";
import { COMPATIBILITY_DIAGNOSTIC_CODES } from "@root/types/CompatibilityTypes";
import type { UserHookConfig } from "@root/types/CtrlYokeTypes";

describe("HooksEditor compatibility diagnostics", () => {
  beforeAll(() => {
    if (!Range.prototype.getClientRects) {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [],
      });
    }
  });

  it("offers Notification and persists its command as a custom hook", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    function ControlledEditor() {
      const [value, setValue] = useState<UserHookConfig[]>([
        { event: "stop", command: "" },
      ]);

      return (
        <HooksEditor
          value={value}
          onChange={(next) => {
            onChange(next);
            if (Array.isArray(next)) setValue(next);
          }}
        />
      );
    }

    render(<ControlledEditor />);

    expect(
      screen.getByRole("option", { name: "Notification" })
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "notification" },
    });
    const command = screen.getByLabelText("hook-0-command");
    await user.click(command);
    fireEvent.paste(command, {
      clipboardData: {
        getData: () => "node ./notification-hook.js",
      },
    });

    expect(onChange).toHaveBeenLastCalledWith([
      { event: "notification", command: "node ./notification-hook.js" },
    ]);
  });

  it.each([
    [HARNESS_IDS.CODEX_CLI, "Codex"],
    [HARNESS_IDS.ANTIGRAVITY_CLI, "Antigravity CLI"],
    [HARNESS_IDS.OPENCODE_CLI, "OpenCode"],
  ] as const)(
    "keeps a notification hook editable while showing the %s compatibility warning",
    (harnessId, harnessName) => {
      render(
        <HooksEditor
          value={[{ event: "notification", command: "node ./hook.js" }]}
          onChange={() => undefined}
          diagnostics={[
            {
              code: COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_UNSUPPORTED,
              severity: "warning",
              harnessId,
              capability: "notification",
              state: {
                fidelity: "unsupported",
                mechanism: "none",
                verification: "verified",
              },
              message: `The ${harnessName} harness does not support the Notification hook event.`,
            },
          ]}
        />
      );

      expect(screen.getByLabelText("hook-0-command")).toHaveTextContent(
        "node ./hook.js"
      );
      expect(
        screen.getByText(
          `The ${harnessName} harness does not support the Notification hook event.`
        )
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "+ Add Hook" })).toBeVisible();
    }
  );

  it("keeps configured hooks editable while showing persistent diagnostics", () => {
    render(
      <HooksEditor
        value={[{ event: "error", command: "node ./hook.js" }]}
        onChange={() => undefined}
        diagnostics={[
          {
            code: "compatibility.hooks.event.unsupported",
            severity: "warning",
            harnessId: "codex-cli",
            capability: "error",
            state: {
              fidelity: "unsupported",
              mechanism: "none",
              verification: "verified",
            },
            message:
              "The Codex CLI harness does not support the Error hook event.",
          },
        ]}
      />
    );

    expect(screen.getByLabelText("hook-0-command")).toHaveTextContent(
      "node ./hook.js"
    );
    expect(
      screen.getByText(/does not support the Error hook event/)
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "+ Add Hook" })).toBeVisible();
  });

  it("renders and round-trips hook environment and timeout controls", () => {
    const onChange = vi.fn();
    render(
      <HooksEditor
        value={[
          {
            event: "stop",
            command: "node ./hook.js",
            env: { HOOK_TOKEN: "${secret:HOOK_TOKEN}" },
            timeoutSec: 30,
          },
        ]}
        onChange={onChange}
      />
    );

    expect(screen.getByLabelText("hook-0-env")).toHaveValue(
      "HOOK_TOKEN=${secret:HOOK_TOKEN}"
    );
    expect(screen.getByLabelText("Timeout (seconds)")).toHaveValue(30);

    const hookEnv = screen.getByLabelText("hook-0-env");
    fireEvent.change(hookEnv, {
      target: { value: "HOOK_TOKEN=${secret:HOOK_TOKEN}\nMODE=ci" },
    });
    fireEvent.blur(hookEnv);
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        env: {
          HOOK_TOKEN: "${secret:HOOK_TOKEN}",
          MODE: "ci",
        },
      }),
    ]);

    fireEvent.change(screen.getByLabelText("Timeout (seconds)"), {
      target: { value: "45" },
    });
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ timeoutSec: 45 }),
    ]);
  });

  it("gives the script editor its own full-width row", () => {
    render(
      <HooksEditor
        value={[{ event: "stop", command: "node ./hook.js" }]}
        onChange={() => undefined}
      />
    );

    const editor = screen
      .getByLabelText("hook-0-command")
      .closest(".cm-editor");
    expect(editor?.parentElement).toHaveClass("w-full", "min-w-0");
    expect(screen.getByLabelText("Event")).toHaveClass("h-7");
    expect(screen.getByLabelText("Timeout (seconds)")).toHaveClass("h-7");

    const removeButton = screen.getByRole("button", { name: "Remove hook" });
    expect(removeButton).toHaveClass("bg-indicator-error", "h-7", "self-end");
    expect(removeButton.querySelector(".codicon-trash")).toBeInTheDocument();
  });

  it("keeps hook commands single-line and blurs on Enter", async () => {
    const user = userEvent.setup();
    render(
      <HooksEditor
        value={[{ event: "stop", command: "node ./hook.js" }]}
        onChange={() => undefined}
      />
    );

    const command = screen.getByLabelText("hook-0-command");
    await user.click(command);
    await user.keyboard("{Enter}");

    expect(command).toHaveTextContent("node ./hook.js");
    expect(command).not.toHaveTextContent("\n");
    expect(command).not.toHaveFocus();
  });

  it("clears hook environment and timeout overrides", () => {
    const onChange = vi.fn();
    render(
      <HooksEditor
        value={[
          {
            event: "stop",
            command: "node ./hook.js",
            env: { HOOK_TOKEN: "${secret:HOOK_TOKEN}" },
            timeoutSec: 30,
          },
        ]}
        onChange={onChange}
      />
    );

    const hookEnvToClear = screen.getByLabelText("hook-0-env");
    fireEvent.change(hookEnvToClear, {
      target: { value: "" },
    });
    fireEvent.blur(hookEnvToClear);
    const clearedEnv = onChange.mock.lastCall?.[0]?.[0] as {
      env?: Record<string, string>;
    };
    expect(clearedEnv.env).toBeUndefined();
    expect(clearedEnv.env).not.toEqual({});

    fireEvent.change(screen.getByLabelText("Timeout (seconds)"), {
      target: { value: "" },
    });
    const clearedTimeout = onChange.mock.lastCall?.[0]?.[0] as {
      timeoutSec?: number;
    };
    expect(clearedTimeout.timeoutSec).toBeUndefined();
  });
});
