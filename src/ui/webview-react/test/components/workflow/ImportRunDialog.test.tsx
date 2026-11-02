import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportRunDialog } from "@components/workflow/ImportRunDialog";
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { RunImportPreview } from "@root/types/RunImportPreviewTypes";

const postMessage = vi.fn();
const preview: RunImportPreview = {
  provenance: {
    workflowName: "Demo",
    sourceRoot: "/source",
    exportedAt: "today",
    exportedByVersion: "0.4.1",
  },
  continuable: true,
  continuation: {
    baseCommit: { commit: "abc123", exists: true },
    worktreeMode: "managed",
    defaultChangesTarget: "managed-worktree",
    allowedChangesTargets: ["managed-worktree", "skip"],
    checkoutClean: false,
    checkoutAtBaseCommit: false,
    patchFileCount: 2,
  },
  pendingSteps: [
    {
      stepIndex: 1,
      kind: "prompt",
      name: "Finish",
      promptPreview: "continue",
      harness: "codex-cli",
      model: "gpt",
      secretGrants: [],
      promptRedacted: false,
    },
  ],
  sessions: [
    {
      stepIndex: 1,
      harness: "codex-cli",
      availability: "missing",
      executedStepIndices: [0],
      notFromThisRun: false,
    },
  ],
  blockers: [],
};

describe("ImportRunDialog", () => {
  beforeEach(() => {
    useUiStore.getState().resetUi();
    postMessage.mockReset();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: { postMessage, getState: vi.fn(), setState: vi.fn() },
    });
  });
  afterEach(cleanup);

  it("disables continue while blockers exist and reports missing sessions", () => {
    useUiStore
      .getState()
      .openRunImportDialog({
        requestId: "r1",
        bundleDir: "/bundle",
        preview: {
          ...preview,
          blockers: [
            { code: "base-commit-missing", message: "fetch commit abc" },
          ],
        },
      });
    render(<ImportRunDialog />);
    expect(screen.getByText(/executed steps covered: 1/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Import and Continue" })
    ).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("fetch commit abc");
  });

  it("supports view-only import when a session is missing", () => {
    useUiStore
      .getState()
      .openRunImportDialog({ requestId: "r2", bundleDir: "/bundle", preview });
    render(<ImportRunDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.IMPORT_RUN,
        requestId: "r2",
      })
    );
  });

  it("shows already-imported choices", () => {
    useUiStore
      .getState()
      .openRunImportDialog({
        requestId: "r3",
        bundleDir: "/bundle",
        preview: {
          ...preview,
          provenance: {
            ...preview.provenance,
            alreadyImported: {
              workflowKey: "existing" as never,
              runRef: "run-existing" as never,
            },
          },
        },
      });
    render(<ImportRunDialog />);
    expect(
      screen.getByRole("button", { name: "Open existing import" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Import again" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import again" }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: MESSAGE_TYPES.IMPORT_RUN, again: true })
    );
  });
});
