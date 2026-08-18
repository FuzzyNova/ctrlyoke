import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
