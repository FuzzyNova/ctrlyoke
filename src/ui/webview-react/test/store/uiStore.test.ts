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

// ---------------------------------------------------------------------------
// Save workflow dialog
// ---------------------------------------------------------------------------

describe("save workflow dialog", () => {
  it("opens with data and closes", () => {
    store().openSaveWorkflowDialog({
      defaultPath: "/workspace/wf.flightpath.yaml",
      defaultFormat: "yaml",
      workflowsDir: ".flightpath/workflows",
    });
    expect(store().saveWorkflowDialogOpen).toBe(true);
    expect(store().saveWorkflowDialogData?.defaultFormat).toBe("yaml");

    store().closeSaveWorkflowDialog();
    expect(store().saveWorkflowDialogOpen).toBe(false);
    expect(store().saveWorkflowDialogData).toBeNull();
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
      workflowsDir: ".flightpath/workflows",
      defaultTemplateId: "starter",
    });
    expect(store().newWorkflowModalOpen).toBe(true);
    expect(store().templates).toHaveLength(2);
    expect(store().currentTemplate?.id).toBe("starter");
  });

  it("closes and clears currentTemplate", () => {
    store().openNewWorkflowModal({ templates, workflowsDir: "" });
    store().closeNewWorkflowModal();
    expect(store().newWorkflowModalOpen).toBe(false);
    expect(store().currentTemplate).toBeNull();
  });

  it("setCurrentTemplate updates selected template", () => {
    store().openNewWorkflowModal({ templates, workflowsDir: "" });
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
        workflowName: "wf1",
        filePath: "/path/wf1.yaml",
        executionState: "idle",
        lastModifiedAt: 1000,
        isFavorite: true,
      },
      {
        workflowName: "wf2",
        filePath: "/path/wf2.yaml",
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
    store().hideDropdownOption("harness", "copilot-chat");
    expect(store().hiddenDropdownOptions["harness"]).toContain("copilot-chat");

    store().unhideDropdownOption("harness", "copilot-chat");
    expect(store().hiddenDropdownOptions["harness"]).not.toContain(
      "copilot-chat"
    );
  });

  it("does not duplicate hidden options", () => {
    store().hideDropdownOption("harness", "copilot-chat");
    store().hideDropdownOption("harness", "copilot-chat");
    expect(
      store().hiddenDropdownOptions["harness"].filter(
        (v) => v === "copilot-chat"
      )
    ).toHaveLength(1);
  });
});

describe("clearHiddenDropdownOptions", () => {
  it("empties the list for a namespace", () => {
    store().hideDropdownOption("harness", "copilot-chat");
    store().hideDropdownOption("harness", "codex-cli");
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
      defaultPath: "/wf.yaml",
      defaultFormat: "yaml",
      workflowsDir: "",
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
