import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HooksEditor } from "@components/editor/HooksEditor";

describe("HooksEditor compatibility diagnostics", () => {
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

    expect(screen.getByDisplayValue("node ./hook.js")).toBeInTheDocument();
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
