import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportRunDialog } from "@components/workflow/ExportRunDialog";
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";

const postMessage = vi.fn();
const address = {
  workflowKey: "workflow-a" as never,
  kind: "run" as const,
  runRef: "run-1" as never,
};

describe("ExportRunDialog", () => {
  beforeEach(() => {
    useUiStore.getState().resetUi();
    postMessage.mockReset();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: { postMessage, getState: vi.fn(), setState: vi.fn() },
    });
  });
  afterEach(cleanup);

  it("previews continuation and exports with snapshots off by default", () => {
    useUiStore.getState().openRunExportDialog({
      requestId: "export-1",
      address,
      workflowName: "Fix tests",
      defaultPath: "/workspace/Fix tests.ctrlyokerun",
      continuable: true,
      changedFiles: ["src/a.ts", "README.md"],
    });
    render(<ExportRunDialog />);

    expect(
      screen.getByText(/2 changed file\(s\): src\/a.ts, README.md/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /Include workspace snapshots/ })
    ).not.toBeChecked();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Omit workspace changes/ })
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Include workspace snapshots/ })
    );
    fireEvent.click(screen.getByRole("button", { name: "Export Run" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.EXPORT_RUN,
      requestId: "export-1",
      address,
      bundleDir: "/workspace/Fix tests.ctrlyokerun",
      includeSnapshots: true,
      includeChanges: false,
    });
  });

  it("shows the redaction summary, external paths, and warnings after export", () => {
    useUiStore.getState().openRunExportDialog({
      requestId: "export-2",
      address,
      workflowName: "Fix tests",
      defaultPath: "/workspace/Fix tests.ctrlyokerun",
      continuable: false,
      changedFiles: [],
      result: {
        bundleDir: "/workspace/Fix tests.ctrlyokerun",
        eventCount: 12,
        continuable: false,
        changedFiles: [],
        redaction: {
          removedCount: 2,
          byRule: { "exact-secret": 2 },
          byFile: { "events.jsonl": 2 },
        },
        externalPaths: ["/outside/file.txt"],
        warnings: ["Missing attachment"],
      },
    });
    render(<ExportRunDialog />);

    expect(screen.getByText("2 value(s) removed")).toBeInTheDocument();
    expect(screen.getByText("exact-secret: 2")).toBeInTheDocument();
    expect(screen.getByText("events.jsonl: 2")).toBeInTheDocument();
    expect(screen.getByText("/outside/file.txt")).toBeInTheDocument();
    expect(screen.getByText("Missing attachment")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Review the bundle contents and redaction summary before sharing/
      )
    ).toBeInTheDocument();
  });
});
