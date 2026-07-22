import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "@store/uiStore";

// Zustand store is a module singleton — reset between tests.
beforeEach(() => {
  useUiStore.getState().resetUi();
});

function store() {
  return useUiStore.getState();
}

// ---------------------------------------------------------------------------
// Section collapse toggles
// ---------------------------------------------------------------------------

describe("togglePromptsCollapse", () => {
  it("flips promptsCollapsed", () => {
    expect(store().stepsCollapsed).toBe(false);
    store().togglePromptsCollapse();
    expect(store().stepsCollapsed).toBe(true);
    store().togglePromptsCollapse();
    expect(store().stepsCollapsed).toBe(false);
  });
});

describe("toggleOutputCollapse", () => {
  it("flips outputCollapsed", () => {
    expect(store().outputCollapsed).toBe(false);
    store().toggleOutputCollapse();
    expect(store().outputCollapsed).toBe(true);
  });
});

describe("toggleEditorCollapse", () => {
  it("flips editorCollapsed", () => {
    expect(store().editorCollapsed).toBe(false);
    store().toggleEditorCollapse();
    expect(store().editorCollapsed).toBe(true);
  });
});

describe("setPromptsCollapsed / setOutputCollapsed / setEditorCollapsed", () => {
  it("set collapse state directly", () => {
    store().setPromptsCollapsed(true);
    expect(store().stepsCollapsed).toBe(true);
    store().setOutputCollapsed(true);
    expect(store().outputCollapsed).toBe(true);
    store().setEditorCollapsed(true);
    expect(store().editorCollapsed).toBe(true);
  });
});

describe("toggleDiffsCollapsed", () => {
  it("flips diffsCollapsed (default is true)", () => {
    // diffsCollapsed starts true in initial state
    const before = store().diffsCollapsed;
    store().toggleDiffsCollapsed();
    expect(store().diffsCollapsed).toBe(!before);
  });
});

// ---------------------------------------------------------------------------
// Properties drawer
// ---------------------------------------------------------------------------

describe("properties drawer", () => {
  it("opens and closes", () => {
    expect(store().propertiesDrawerOpen).toBe(false);
    store().openPropertiesDrawer();
    expect(store().propertiesDrawerOpen).toBe(true);
    store().closePropertiesDrawer();
    expect(store().propertiesDrawerOpen).toBe(false);
  });

  it("togglePropertiesDrawer flips state", () => {
    store().togglePropertiesDrawer();
    expect(store().propertiesDrawerOpen).toBe(true);
    store().togglePropertiesDrawer();
    expect(store().propertiesDrawerOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Output step selection
// ---------------------------------------------------------------------------

describe("selectOutputStep", () => {
  it("sets selectedOutputStep", () => {
    store().selectOutputStep(3);
    expect(store().selectedOutputStep).toBe(3);
  });

  it("accepts null to reset to current step", () => {
    store().selectOutputStep(3);
    store().selectOutputStep(null);
    expect(store().selectedOutputStep).toBeNull();
  });
});

describe("setPendingFindRequest", () => {
  it("stores and clears the pending output find request", () => {
    store().setPendingFindRequest({
      query: "needle",
      preferredTarget: { kind: "queue", stepIndex: 0 },
    });
    expect(store().pendingFindRequest).toEqual({
      query: "needle",
      preferredTarget: { kind: "queue", stepIndex: 0 },
    });

    store().setPendingFindRequest(null);
    expect(store().pendingFindRequest).toBeNull();
  });
});

describe("history search state", () => {
  it("opens, updates, and closes the history search drawer", () => {
    expect(store().isHistorySearchOpen).toBe(false);

    store().openHistorySearch();
    store().setHistorySearchQuery("needle");
    store().setHistorySearchResults(
      [
        {
          workflowKey: "wf-1" as never,
          runRef: "run-2026-07-20T10-30-00-000Z" as never,
          workflowName: "Search Workflow",
          runId: 3,
          startedAt: 1234,
          executionState: "completed",
          target: { kind: "queue", stepIndex: 0 },
          matchType: "response",
          matchSnippet: "needle found here",
          matchContext: "Prompt 1",
        },
      ],
      true
    );
    store().setPendingHistorySearchNavigation({
      address: {
        workflowKey: "wf-1" as never,
        kind: "run",
        runRef: "run-2026-07-20T10-30-00-000Z" as never,
      },
      findQuery: "needle",
      target: { kind: "queue", stepIndex: 0 },
    });

    expect(store().isHistorySearchOpen).toBe(true);
    expect(store().historySearchQuery).toBe("needle");
    expect(store().historySearchResults).toHaveLength(1);
    expect(store().historySearchLoading).toBe(true);
    expect(store().pendingHistorySearchNavigation).toEqual({
      address: {
        workflowKey: "wf-1" as never,
        kind: "run",
        runRef: "run-2026-07-20T10-30-00-000Z" as never,
      },
      findQuery: "needle",
      target: { kind: "queue", stepIndex: 0 },
    });

    store().closeHistorySearch();

    expect(store().isHistorySearchOpen).toBe(false);
    expect(store().historySearchLoading).toBe(false);
  });

  it("keeps history search and global settings mutually exclusive", () => {
    store().toggleGlobalSettings();
    expect(store().globalSettingsOpen).toBe(true);

    store().openHistorySearch();
    expect(store().isHistorySearchOpen).toBe(true);
    expect(store().globalSettingsOpen).toBe(false);

    store().setHistorySearchResults([], true);
    store().toggleGlobalSettings();
    expect(store().globalSettingsOpen).toBe(true);
    expect(store().isHistorySearchOpen).toBe(false);
    expect(store().historySearchLoading).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Save workflow dialog
// ---------------------------------------------------------------------------

describe("save workflow dialog", () => {
  it("opens with data and closes", () => {
    store().openSaveWorkflowDialog({
      requestId: "save-1",
      address: { workflowKey: "workflow-1" as any, kind: "draft" },
      title: "Save draft",
      defaultPath: "/workspace/wf.ctrlyoke.yaml",
      defaultFormat: "yaml",
    });
    expect(store().saveWorkflowDialogOpen).toBe(true);
    expect(store().saveWorkflowDialogData?.defaultFormat).toBe("yaml");

    store().closeSaveWorkflowDialog();
    expect(store().saveWorkflowDialogOpen).toBe(false);
    expect(store().saveWorkflowDialogData).toBeNull();
  });

  it("ignores stale save-path responses after the destination changes or dialog closes", () => {
    store().openSaveWorkflowDialog({
      requestId: "save-1",
      address: { workflowKey: "workflow-1" as any, kind: "draft" },
      title: "Save draft",
      defaultPath: "/workspace/wf.ctrlyoke.yaml",
      defaultFormat: "yaml",
    });
    store().beginSavePathCheck(
      "save-1:path:1",
      "/workspace/first.ctrlyoke.yaml"
    );
    store().beginSavePathCheck(
      "save-1:path:2",
      "/workspace/second.ctrlyoke.yaml"
    );
    store().resolveSavePathCheck({
      requestId: "save-1:path:1",
      path: "/workspace/first.ctrlyoke.yaml",
      exists: true,
    });
    expect(store().savePathCheck?.checking).toBe(true);
    expect(store().savePathCheck?.path).toBe("/workspace/second.ctrlyoke.yaml");

    store().closeSaveWorkflowDialog();
    store().resolveSavePathCheck({
      requestId: "save-1:path:2",
      path: "/workspace/second.ctrlyoke.yaml",
      exists: true,
    });
    expect(store().savePathCheck).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// New workflow modal
// ---------------------------------------------------------------------------

describe("new workflow modal", () => {
  const templates = [
    { id: "blank", name: "Blank", description: "", isBuiltIn: true },
    { id: "starter", name: "Starter", description: "", isBuiltIn: true },
  ];

  it("opens with templates and selects default", () => {
    store().openNewWorkflowModal({
      templates,
      defaultTemplateId: "starter",
    });
    expect(store().newWorkflowModalOpen).toBe(true);
    expect(store().templates).toHaveLength(2);
    expect(store().currentTemplate?.id).toBe("starter");
  });

  it("closes and clears currentTemplate", () => {
    store().openNewWorkflowModal({ templates });
    store().closeNewWorkflowModal();
    expect(store().newWorkflowModalOpen).toBe(false);
    expect(store().currentTemplate).toBeNull();
  });

  it("setCurrentTemplate updates selected template", () => {
    store().openNewWorkflowModal({ templates });
    store().setCurrentTemplate(templates[1]);
    expect(store().currentTemplate?.id).toBe("starter");
  });
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe("setLoading", () => {
  it("activates loading with optional message", () => {
    store().setLoading(true, "Saving...");
    expect(store().isLoading).toBe(true);
    expect(store().loadingMessage).toBe("Saving...");
  });

  it("clears message when loading is false", () => {
    store().setLoading(true, "Saving...");
    store().setLoading(false);
    expect(store().isLoading).toBe(false);
    expect(store().loadingMessage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------

describe("showToast / hideToast", () => {
  it("shows a toast with default type info", () => {
    store().showToast("Hello!");
    expect(store().toast?.message).toBe("Hello!");
    expect(store().toast?.type).toBe("info");
    expect(store().toast?.visible).toBe(true);
  });

  it("shows a toast with specified type", () => {
    store().showToast("Done", "success");
    expect(store().toast?.type).toBe("success");
  });

  it("hideToast clears toast to null", () => {
    store().showToast("Hi");
    store().hideToast();
    expect(store().toast).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Run history view
// ---------------------------------------------------------------------------

describe("setHistoryView", () => {
  it("enters history mode with runIndex and availableRuns", () => {
    store().setHistoryView(2, 5);
    expect(store().isViewingHistory).toBe(true);
    expect(store().viewingRunIndex).toBe(2);
    expect(store().availableRuns).toBe(5);
  });

  it("stores run timestamps when provided", () => {
    store().setHistoryView(0, 3, [1000, 900, 800]);
    expect(store().runTimestamps).toEqual([1000, 900, 800]);
  });
});

describe("setDisplayedRunView", () => {
  it("keeps pending rewind scoped to the addressed run and clears it on the next view", () => {
    const run = {
      workflowKey: "wf-1" as never,
      runRef: "run-2026-07-20T10-30-00-000Z" as never,
      runId: 4,
      startedAt: 1000,
      executionState: "idle" as never,
      stepCount: 2,
      definitionRevision: 3,
      hasMixedHarnesses: false,
      hasMixedModels: false,
    };
    store().setDisplayedRunView(
      { workflowKey: "wf-1" as never, kind: "run", runRef: run.runRef },
      [run],
      undefined,
      { definitionRevision: 3, descriptorRevision: 8 },
      { fromStepIndex: 1, baseDefinitionRevision: 2 }
    );
    expect(store().pendingRewind).toEqual({
      fromStepIndex: 1,
      baseDefinitionRevision: 2,
    });

    store().setDisplayedRunView(
      { workflowKey: "wf-1" as never, kind: "draft" },
      [run],
      undefined,
      { definitionRevision: 1, descriptorRevision: 9 }
    );
    expect(store().pendingRewind).toBeNull();
  });
});

describe("descriptor revision monotonicity", () => {
  const runAddress = {
    workflowKey: "wf-1" as never,
    kind: "run" as const,
    runRef: "run-2026-07-20T10-30-00-000Z" as never,
  };

  it("never lets an identity lower the descriptor revision for the displayed address", () => {
    store().setDisplayedViewIdentity(runAddress, 2, 6);
    // A stale identity built between a run-file write and its descriptor commit.
    store().setDisplayedViewIdentity(runAddress, 3, 5);
    expect(store().displayedDefinitionRevision).toBe(3);
    expect(store().displayedDescriptorRevision).toBe(6);
  });

  it("still lets an identity lower the definition revision (discard restores an older head)", () => {
    store().setDisplayedViewIdentity(runAddress, 3, 6);
    store().setDisplayedViewIdentity(runAddress, 2, 7);
    expect(store().displayedDefinitionRevision).toBe(2);
    expect(store().displayedDescriptorRevision).toBe(7);
  });

  it("adopts the incoming descriptor revision verbatim on an address switch", () => {
    store().setDisplayedViewIdentity(runAddress, 2, 6);
    store().setDisplayedViewIdentity(
      { workflowKey: "wf-2" as never, kind: "draft" },
      1,
      2
    );
    expect(store().displayedDescriptorRevision).toBe(2);
  });

  it("keeps newer descriptor knowledge across a same-address run view snapshot", () => {
    store().setDisplayedViewIdentity(runAddress, 2, 6);
    store().setDisplayedRunView(runAddress, [], undefined, {
      definitionRevision: 3,
      descriptorRevision: 5,
    });
    expect(store().displayedDefinitionRevision).toBe(3);
    expect(store().displayedDescriptorRevision).toBe(6);
  });

  it("adoptDescriptorRevision only raises, and only for the displayed address", () => {
    store().setDisplayedViewIdentity(runAddress, 3, 5);
    store().adoptDescriptorRevision(runAddress, 6);
    expect(store().displayedDescriptorRevision).toBe(6);
    store().adoptDescriptorRevision(runAddress, 4);
    expect(store().displayedDescriptorRevision).toBe(6);
    store().adoptDescriptorRevision(
      { workflowKey: "other" as never, kind: "draft" },
      9
    );
    expect(store().displayedDescriptorRevision).toBe(6);
  });
});

describe("requestRunViewLoad", () => {
  const summary = {
    workflowKey: "wf-1" as never,
    runRef: "run-2026-07-20T10-30-00-000Z" as never,
    runId: 4,
    startedAt: 1000,
    executionState: "running" as never,
    stepCount: 2,
    definitionRevision: 3,
    hasMixedHarnesses: false,
    hasMixedModels: false,
  };

  it("carries summaries and the executing run across runs of the same lineage", () => {
    store().setDisplayedRunView(
      { workflowKey: "wf-1" as never, kind: "run", runRef: summary.runRef },
      [summary],
      summary.runRef
    );

    store().requestRunViewLoad(
      {
        workflowKey: "wf-1" as never,
        kind: "run",
        runRef: "run-2026-07-19T10-30-00-000Z" as never,
      },
      [summary],
      summary.runRef
    );

    expect(store().runSummaries).toEqual([summary]);
    expect(store().executionRunRef).toBe(summary.runRef);
  });

  it("drops the previous lineage's summaries and executing run on a workflow switch", () => {
    store().setDisplayedRunView(
      { workflowKey: "wf-1" as never, kind: "run", runRef: summary.runRef },
      [summary],
      summary.runRef
    );

    store().requestRunViewLoad(
      {
        workflowKey: "wf-2" as never,
        kind: "run",
        runRef: "run-2026-07-21T10-30-00-000Z" as never,
      },
      [summary],
      summary.runRef
    );

    // Keeping them would build a header address out of wf-2 plus wf-1's run,
    // which is what made Stop target a foreign run and do nothing.
    expect(store().runSummaries).toEqual([]);
    expect(store().executionRunRef).toBeNull();
  });

  it("records a pending switch for cross-lineage requests only", () => {
    store().setDisplayedRunView(
      { workflowKey: "wf-1" as never, kind: "run", runRef: summary.runRef },
      [summary],
      summary.runRef
    );

    const switchRequestId = store().requestRunViewLoad(
      { workflowKey: "wf-2" as never, kind: "draft" },
      [],
      undefined,
      "Target workflow"
    );
    expect(store().pendingRunViewSwitch).toEqual({
      requestId: switchRequestId,
      workflowName: "Target workflow",
    });

    // A same-lineage follow-up supersedes the switch: its snapshot refines the
    // panels already on screen, so no overlay/rename should remain pending.
    store().requestRunViewLoad(
      {
        workflowKey: "wf-2" as never,
        kind: "run",
        runRef: "run-2026-07-21T10-30-00-000Z" as never,
      },
      []
    );
    expect(store().pendingRunViewSwitch).toBeNull();
  });

  it("clearPendingRunViewLoad clears the pending switch with the request", () => {
    store().requestRunViewLoad(
      { workflowKey: "wf-9" as never, kind: "draft" },
      [],
      undefined,
      "Somewhere else"
    );
    expect(store().pendingRunViewSwitch).not.toBeNull();

    store().clearPendingRunViewLoad();
    expect(store().pendingRunViewRequestId).toBeNull();
    expect(store().pendingRunViewSwitch).toBeNull();
  });
});

describe("clearHistoryView", () => {
  it("exits history mode and resets to run 0", () => {
    store().setHistoryView(2, 5);
    store().clearHistoryView();
    expect(store().isViewingHistory).toBe(false);
    expect(store().viewingRunIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Recent workflows
// ---------------------------------------------------------------------------

describe("setRecentWorkflows", () => {
  it("replaces recent workflows list", () => {
    store().setRecentWorkflows([
      {
        address: { workflowKey: "wf1" as never, kind: "draft" },
        workflowName: "wf1",
        executionState: "idle",
        lastModifiedAt: 1000,
        isFavorite: true,
      },
      {
        address: { workflowKey: "wf2" as never, kind: "draft" },
        workflowName: "wf2",
        executionState: "completed",
        lastModifiedAt: 900,
      },
    ]);
    expect(store().recentWorkflows).toHaveLength(2);
    expect(store().recentWorkflows[0].workflowName).toBe("wf1");
  });
});

describe("toggleRecentWorkflowsDropdown", () => {
  it("flips recentWorkflowsDropdownOpen", () => {
    expect(store().recentWorkflowsDropdownOpen).toBe(false);
    store().toggleRecentWorkflowsDropdown();
    expect(store().recentWorkflowsDropdownOpen).toBe(true);
    store().closeRecentWorkflowsDropdown();
    expect(store().recentWorkflowsDropdownOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dropdown hide feature
// ---------------------------------------------------------------------------

describe("hideDropdownOption / unhideDropdownOption", () => {
  it("hides an option and unhides it", () => {
    store().hideDropdownOption("harness", "codex-cli");
    expect(store().hiddenDropdownOptions["harness"]).toContain("codex-cli");

    store().unhideDropdownOption("harness", "codex-cli");
    expect(store().hiddenDropdownOptions["harness"]).not.toContain("codex-cli");
  });

  it("does not duplicate hidden options", () => {
    store().hideDropdownOption("harness", "codex-cli");
    store().hideDropdownOption("harness", "codex-cli");
    expect(
      store().hiddenDropdownOptions["harness"].filter((v) => v === "codex-cli")
    ).toHaveLength(1);
  });
});

describe("clearHiddenDropdownOptions", () => {
  it("empties the list for a namespace", () => {
    store().hideDropdownOption("harness", "codex-cli");
    store().hideDropdownOption("harness", "qwen-cli");
    store().clearHiddenDropdownOptions("harness");
    expect(store().hiddenDropdownOptions["harness"]).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resetUi
// ---------------------------------------------------------------------------

describe("resetUi", () => {
  it("clears modal and transient state back to defaults", () => {
    store().openSaveWorkflowDialog({
      requestId: "save-1",
      address: { workflowKey: "workflow-1" as any, kind: "draft" },
      title: "Save draft",
      defaultPath: "/wf.yaml",
      defaultFormat: "yaml",
    });
    store().setLoading(true, "Loading...");
    store().showToast("Hello");

    store().resetUi();

    expect(store().saveWorkflowDialogOpen).toBe(false);
    expect(store().isLoading).toBe(false);
    expect(store().toast).toBeNull();
    expect(store().propertiesDrawerOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// contentPreviewModal
// ---------------------------------------------------------------------------

describe("setContentPreviewModal", () => {
  it("starts as null", () => {
    expect(store().contentPreviewModal).toBeNull();
  });

  it("sets diff modal state", () => {
    store().setContentPreviewModal({
      title: "Working Tree Diff (~diff)",
      content: "diff --git a/foo.ts b/foo.ts\n...",
      language: "diff",
      ref: "diff",
    });
    const modal = store().contentPreviewModal;
    expect(modal).not.toBeNull();
    expect(modal?.language).toBe("diff");
    expect(modal?.title).toBe("Working Tree Diff (~diff)");
    expect(modal?.ref).toBe("diff");
  });

  it("sets xml modal state for prior context", () => {
    store().setContentPreviewModal({
      title: "$previous — Prior Context",
      content: "<priorContext>...</priorContext>",
      language: "xml",
      ref: "previous",
    });
    expect(store().contentPreviewModal?.language).toBe("xml");
    expect(store().contentPreviewModal?.ref).toBe("previous");
  });

  it("clears modal when set to null", () => {
    store().setContentPreviewModal({
      title: "Staged Changes (~staged)",
      content: "diff content",
      language: "diff",
      ref: "staged",
    });
    store().setContentPreviewModal(null);
    expect(store().contentPreviewModal).toBeNull();
  });
});
