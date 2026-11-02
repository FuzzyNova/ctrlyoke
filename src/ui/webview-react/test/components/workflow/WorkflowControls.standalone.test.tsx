import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.hoisted(() => {
  window.__ctrlyokeStandalone = true;
});

import { WorkflowControls } from "@components/workflow/WorkflowControls";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";

const postMessage = vi.fn();

describe("WorkflowControls bundle load choice in hosted mode", () => {
  beforeEach(() => {
    postMessage.mockReset();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: { postMessage, getState: vi.fn(), setState: vi.fn() },
    });
  });
  afterEach(cleanup);

  it("offers run import from a selected bundle workflow", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<WorkflowControls />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open workflow menu/i })
    );
    fireEvent.click(screen.getByRole("option", { name: /Load from File/i }));
    fireEvent.change(screen.getByLabelText("Or enter a path"), {
      target: { value: "runs/demo.ctrlyokerun/workflow.ctrlyoke.json" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load File" }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.REQUEST_RUN_IMPORT_PREVIEW,
        bundleDir: "runs/demo.ctrlyokerun",
      })
    );
  });

  it("loads only the authored workflow when run import is declined", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<WorkflowControls />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open workflow menu/i })
    );
    fireEvent.click(screen.getByRole("option", { name: /Load from File/i }));
    fireEvent.change(screen.getByLabelText("Or enter a path"), {
      target: { value: "runs/demo.ctrlyokerun/workflow.ctrlyoke.json" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load File" }));
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.LOAD_WORKFLOW,
      filePath: "runs/demo.ctrlyokerun/workflow.ctrlyoke.json",
    });
  });
});
