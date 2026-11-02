import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportRunDialog } from "@components/workflow/ImportRunDialog";
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { RunImportPreview } from "@root/types/RunImportPreviewTypes";
import {
  RUN_BUNDLE_WORKTREE_MODES,
  RUN_CHANGES_TARGETS,
} from "@root/types/RunBundleTypes";

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
    defaultChangesTarget: RUN_CHANGES_TARGETS.WORKTREE,
    allowedChangesTargets: [
      RUN_CHANGES_TARGETS.WORKTREE,
      RUN_CHANGES_TARGETS.SKIP,
    ],
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
  warnings: [
    "1 values in changes.patch were redacted; those lines will contain [REDACTED] in the continued checkout.",
  ],
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
    useUiStore.getState().openRunImportDialog({
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
        changes: RUN_CHANGES_TARGETS.WORKTREE,
      })
    );
  });

  it("sends an offered target when the CLI default would fail here", () => {
    // A `none` run defaults to the checkout, but this checkout is dirty, so
    // the preview does not offer it; the dialog must not send it implicitly.
    useUiStore.getState().openRunImportDialog({
      requestId: "r4",
      bundleDir: "/bundle",
      preview: {
        ...preview,
        continuation: {
          ...preview.continuation!,
          worktreeMode: RUN_BUNDLE_WORKTREE_MODES.NONE,
          defaultChangesTarget: RUN_CHANGES_TARGETS.CHECKOUT,
        },
      },
    });
    render(<ImportRunDialog />);
    expect(
      screen.getByRole("combobox", { name: /Where changes will land/ })
    ).toHaveValue(RUN_CHANGES_TARGETS.WORKTREE);
    expect(
      screen.queryByRole("option", { name: "This checkout" })
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Import and Continue" })
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.IMPORT_RUN_AND_CONTINUE,
        changes: RUN_CHANGES_TARGETS.WORKTREE,
      })
    );
  });

  it("shows already-imported choices", () => {
    useUiStore.getState().openRunImportDialog({
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

  it("shows patch redactions in the import preview", () => {
    useUiStore.getState().openRunImportDialog({
      requestId: "r-warning",
      bundleDir: "/bundle",
      preview,
    });
    render(<ImportRunDialog />);
    expect(
      screen.getByText(/values in changes\.patch were redacted/)
    ).toBeInTheDocument();
  });
});
