import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_HISTORY_SEARCH_FILTERS,
  getHistorySearchActiveFilterCount,
  useUiStore,
} from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { useWorkflowStore } from "@store/workflowStore";
import { EXECUTION_STATES } from "@/types/messages";
import type { ExecutionState, WorkflowSummary } from "@/types/messages";
import {
  RUNNER_IDS,
  TOAST_LEVEL_MODES,
  USER_FEEDBACK_SEVERITY,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import {
  DEFAULT_WORKSPACE_ENTRY_SORT,
  WORKSPACE_ENTRY_SORT_DIRECTIONS,
  WORKSPACE_ENTRY_SORT_KEYS,
} from "@root/types/HostedWorkspaceViewerTypes";
import { nextWorkspaceEntrySort } from "@utils/workspaceEntrySort";
import { getDatePresetRange } from "@utils/dateRangeFilter";
import { workflowViewAddressKey } from "@utils/viewAddress";
import { TOAST_QUEUE_LIMIT } from "@/constants";

// Zustand store is a module singleton — reset between tests.
beforeEach(() => {
  useUiStore.getState().resetUi();
  useUiStore.setState({ workspaceEntrySort: DEFAULT_WORKSPACE_ENTRY_SORT });
  useSettingsStore.setState({
    fullGlobalSettings: null,
    globalSettings: {
      ...useSettingsStore.getState().globalSettings,
      toastLevel: TOAST_LEVEL_MODES.ALL,
    },
  });
});

afterEach(() => {
  useSettingsStore.setState({
    fullGlobalSettings: null,
    globalSettings: {
      ...useSettingsStore.getState().globalSettings,
      toastLevel: TOAST_LEVEL_MODES.ALL,
    },
  });
});

function store() {
  return useUiStore.getState();
}

// ---------------------------------------------------------------------------
// Section collapse toggles
// ---------------------------------------------------------------------------

describe("revealWorkflowVariable", () => {
  it("expands the desktop sidebar and records the request", () => {
    useUiStore.setState({ settingsCollapsed: true });
    store().revealWorkflowVariable("region", { mobile: false });
    expect(store().settingsCollapsed).toBe(false);
    expect(store().mobileWorkflowPropsOpen).toBe(false);
    expect(store().workflowVariableRevealRequest?.name).toBe("region");
  });

  it("opens the mobile overlay instead on mobile", () => {
    useUiStore.setState({ settingsCollapsed: true });
    store().revealWorkflowVariable("region", { mobile: true });
    expect(store().mobileWorkflowPropsOpen).toBe(true);
    expect(store().settingsCollapsed).toBe(true);
  });

  it("makes a repeat request for the same name observable", () => {
    store().revealWorkflowVariable("region", { mobile: false });
    const first = store().workflowVariableRevealRequest;
    store().revealWorkflowVariable("region", { mobile: false });
    expect(store().workflowVariableRevealRequest).not.toBe(first);
    store().clearWorkflowVariableRevealRequest();
    expect(store().workflowVariableRevealRequest).toBeNull();
  });
});

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

describe("workspace entry sorting", () => {
  it("defaults to the shared Name-ascending selection", () => {
    expect(store().workspaceEntrySort).toEqual(DEFAULT_WORKSPACE_ENTRY_SORT);
  });

  it("persists the preference and updates it through its defined action", () => {
    const sort = {
      key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
      direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING,
    };
    store().setWorkspaceEntrySort(sort);

    expect(store().workspaceEntrySort).toEqual(sort);
    const persisted = useUiStore.persist.getOptions().partialize?.(store());
    expect(persisted).toMatchObject({ workspaceEntrySort: sort });
  });

  it("keeps the four header transition outcomes single-sourced", () => {
    const nameAscending = DEFAULT_WORKSPACE_ENTRY_SORT;
    const nameDescending = {
      key: WORKSPACE_ENTRY_SORT_KEYS.NAME,
      direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING,
    };
    const modifiedDescending = {
      key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
      direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING,
    };
    const modifiedAscending = {
      key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
      direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING,
    };

    expect(
      nextWorkspaceEntrySort(nameAscending, WORKSPACE_ENTRY_SORT_KEYS.NAME)
    ).toEqual(nameDescending);
    expect(
      nextWorkspaceEntrySort(
        nameAscending,
        WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT
      )
    ).toEqual(modifiedDescending);
    expect(
      nextWorkspaceEntrySort(
        modifiedDescending,
        WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT
      )
    ).toEqual(modifiedAscending);
    expect(
      nextWorkspaceEntrySort(modifiedAscending, WORKSPACE_ENTRY_SORT_KEYS.NAME)
    ).toEqual(nameAscending);
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
// Output step filtering
// ---------------------------------------------------------------------------

describe("hidden output targets", () => {
  const runAddress = {
    workflowKey: "workflow-1" as never,
    kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
    runRef: "run-1" as never,
  } as const;
  const otherRunAddress = {
    ...runAddress,
    runRef: "run-2" as never,
  } as const;
  const runKey = workflowViewAddressKey(runAddress);
  const otherRunKey = workflowViewAddressKey(otherRunAddress);

  it("toggles a target and records/removes its hidden timestamp", () => {
    expect(store().outputStepFilterVersion).toBe(0);

    store().toggleHiddenOutputTarget(runKey, "queue:0");
    expect(store().hiddenOutputTargets[runKey]).toEqual({
      keys: ["queue:0"],
      hiddenAtMs: { "queue:0": expect.any(Number) },
    });
    expect(store().outputStepFilterVersion).toBe(1);

    store().toggleHiddenOutputTarget(runKey, "queue:0");
    expect(store().hiddenOutputTargets).toEqual({});
    expect(store().outputStepFilterVersion).toBe(2);
  });

  it("solos a target, then clears when that target is soloed again", () => {
    const allTargets = ["queue:0", "queue:1", "finalStep:0"];

    store().soloOutputTargets(runKey, ["queue:1"], allTargets);
    expect(store().hiddenOutputTargets[runKey]?.keys).toEqual([
      "queue:0",
      "finalStep:0",
    ]);
    expect(store().outputStepFilterVersion).toBe(1);

    store().soloOutputTargets(runKey, ["queue:1"], allTargets);
    expect(store().hiddenOutputTargets).toEqual({});
    expect(store().outputStepFilterVersion).toBe(2);
  });

  it("solos several targets together, hiding only the rest", () => {
    const allTargets = ["queue:0", "finalStep:0", "queue:1", "finalStep:1"];
    const finalLoops = ["finalStep:0", "finalStep:1"];

    store().soloOutputTargets(runKey, finalLoops, allTargets);
    expect(store().hiddenOutputTargets[runKey]?.keys).toEqual([
      "queue:0",
      "queue:1",
    ]);

    store().soloOutputTargets(runKey, finalLoops, allTargets);
    expect(store().hiddenOutputTargets).toEqual({});
  });

  it("hides and shows a set of targets together, keeping earlier hide times", () => {
    store().toggleHiddenOutputTarget(runKey, "finalStep:0");
    const firstHiddenAt =
      store().hiddenOutputTargets[runKey]?.hiddenAtMs["finalStep:0"];

    store().setOutputTargetsHidden(
      runKey,
      ["finalStep:0", "finalStep:1"],
      true
    );
    expect(store().hiddenOutputTargets[runKey]?.keys).toEqual([
      "finalStep:0",
      "finalStep:1",
    ]);
    expect(store().hiddenOutputTargets[runKey]?.hiddenAtMs["finalStep:0"]).toBe(
      firstHiddenAt
    );

    store().setOutputTargetsHidden(
      runKey,
      ["finalStep:0", "finalStep:1"],
      false
    );
    expect(store().hiddenOutputTargets).toEqual({});
  });

  it("does not expose one view address's filter under another address", () => {
    store().toggleHiddenOutputTarget(runKey, "queue:0");

    expect(store().hiddenOutputTargets[otherRunKey]).toBeUndefined();
  });

  it("prunes stale address entries whenever a new address is written", () => {
    store().toggleHiddenOutputTarget(runKey, "queue:0");
    store().toggleHiddenOutputTarget(otherRunKey, "queue:1");

    expect(store().hiddenOutputTargets).toEqual({
      [otherRunKey]: {
        keys: ["queue:1"],
        hiddenAtMs: { "queue:1": expect.any(Number) },
      },
    });
  });

  it("drops another address's filter as soon as this address renders", () => {
    store().toggleHiddenOutputTarget(otherRunKey, "queue:1");

    store().pruneHiddenOutputTargets(runKey, new Set(["queue:0", "queue:1"]));

    // Navigating away and back must not restore the old run's filter.
    expect(store().hiddenOutputTargets).toEqual({});
  });

  it("prunes hidden keys whose target no longer exists", () => {
    store().toggleHiddenOutputTarget(runKey, "queue:0");
    store().toggleHiddenOutputTarget(runKey, "queue:5");

    store().pruneHiddenOutputTargets(runKey, new Set(["queue:0"]));

    expect(store().hiddenOutputTargets[runKey]?.keys).toEqual(["queue:0"]);
  });

  it("keeps the filter when no targets are rendered yet", () => {
    store().toggleHiddenOutputTarget(runKey, "queue:0");
    const versionBefore = store().outputStepFilterVersion;

    // A replay that momentarily empties the output must not wipe a filter set
    // on a step that is still running.
    store().pruneHiddenOutputTargets(runKey, new Set());

    expect(store().hiddenOutputTargets[runKey]?.keys).toEqual(["queue:0"]);
    expect(store().outputStepFilterVersion).toBe(versionBefore);
  });

  it("bumps the filter version when clearing", () => {
    store().toggleHiddenOutputTarget(runKey, "queue:0");
    store().clearHiddenOutputTargets(runKey);

    expect(store().hiddenOutputTargets).toEqual({});
    expect(store().outputStepFilterVersion).toBe(2);
  });

  it("does not include transient filter state in persisted output", () => {
    store().toggleHiddenOutputTarget(runKey, "queue:0");
    const persisted = useUiStore.persist.getOptions().partialize?.(store());

    expect(persisted).not.toHaveProperty("hiddenOutputTargets");
    expect(persisted).not.toHaveProperty("outputStepFilterVersion");
  });

  it("does not change workflow status or progress state", () => {
    const workflowBefore = useWorkflowStore.getState();
    const entriesBefore = workflowBefore.liveOrderedEntries;

    store().toggleHiddenOutputTarget(runKey, "queue:0");

    const workflowAfter = useWorkflowStore.getState();
    expect(workflowAfter.currentStep).toBe(workflowBefore.currentStep);
    expect(workflowAfter.totalSteps).toBe(workflowBefore.totalSteps);
    expect(workflowAfter.steps).toBe(workflowBefore.steps);
    expect(workflowAfter.liveOrderedEntries).toBe(entriesBefore);
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
  it("counts a date range as one active filter", () => {
    const presetFilters = {
      ...DEFAULT_HISTORY_SEARCH_FILTERS,
      dateRange: { preset: "last7" as const, ...getDatePresetRange("last7") },
    };
    expect(getHistorySearchActiveFilterCount(presetFilters)).toBe(1);

    expect(
      getHistorySearchActiveFilterCount({
        ...DEFAULT_HISTORY_SEARCH_FILTERS,
        dateRange: { preset: "custom", from: "2026-01-01", to: "" },
      })
    ).toBe(1);
  });

  it("defaults search modes off and resets them with history search state", () => {
    expect(store().historySearchDeep).toBe(false);
    expect(store().historySearchRegex).toBe(false);

    store().setHistorySearchDeep(true);
    expect(store().historySearchDeep).toBe(true);
    store().setHistorySearchRegex(true);
    expect(store().historySearchRegex).toBe(true);

    store().resetHistorySearchFilters();
    expect(store().historySearchDeep).toBe(false);
    expect(store().historySearchRegex).toBe(false);

    store().setHistorySearchDeep(true);
    store().setHistorySearchRegex(true);
    store().resetUi();
    expect(store().historySearchDeep).toBe(false);
    expect(store().historySearchRegex).toBe(false);
  });

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
          eventKind: "response",
          matchField: "content",
          matchSnippet: "needle found here",
          matchContext: "Prompt 1",
        },
      ],
      true
    );
    store().setPendingHistorySearchNavigation({
      address: {
        workflowKey: "wf-1" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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

  it("closeFullscreenDrawers closes settings and history search together", () => {
    useUiStore.setState({
      globalSettingsOpen: true,
      isHistorySearchOpen: true,
      historySearchLoading: true,
    });

    store().closeFullscreenDrawers();

    expect(store().globalSettingsOpen).toBe(false);
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
      address: {
        workflowKey: "workflow-1" as any,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
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
      address: {
        workflowKey: "workflow-1" as any,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
      title: "Save draft",
      defaultPath: "/workspace/wf.ctrlyoke.yaml",
      defaultFormat: "yaml",
    });
    store().beginSavePathCheck(
      "save-1:path:1",
      "/workspace/first.ctrlyoke.yaml",
      {
        workflowKey: "workflow-1" as any,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      }
    );
    store().beginSavePathCheck(
      "save-1:path:2",
      "/workspace/second.ctrlyoke.yaml",
      {
        workflowKey: "workflow-1" as any,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      }
    );
    store().resolveSavePathCheck({
      requestId: "save-1:path:1",
      path: "/workspace/first.ctrlyoke.yaml",
      address: {
        workflowKey: "workflow-1" as any,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
      exists: true,
      bundlePreview: {
        copyCount: 99,
        inlineCount: 0,
        pruneCount: 0,
        warnings: [],
        blockers: [],
        planFingerprint: "stale",
      },
    });
    expect(store().savePathCheck?.checking).toBe(true);
    expect(store().savePathCheck?.path).toBe("/workspace/second.ctrlyoke.yaml");

    store().resolveSavePathCheck({
      requestId: "save-1:path:2",
      path: "/workspace/second.ctrlyoke.yaml",
      address: {
        workflowKey: "workflow-1" as any,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
      exists: true,
      bundlePreview: {
        copyCount: 2,
        inlineCount: 1,
        pruneCount: 1,
        warnings: [],
        blockers: [],
        planFingerprint: "current",
      },
    });
    expect(store().savePathCheck?.bundlePreview?.planFingerprint).toBe(
      "current"
    );

    store().closeSaveWorkflowDialog();
    store().resolveSavePathCheck({
      requestId: "save-1:path:2",
      path: "/workspace/second.ctrlyoke.yaml",
      address: {
        workflowKey: "workflow-1" as any,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
      exists: true,
      bundlePreview: {
        copyCount: 2,
        inlineCount: 1,
        pruneCount: 1,
        warnings: [],
        blockers: [],
        planFingerprint: "current",
      },
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

describe("toast queue", () => {
  function setToastLevel(
    toastLevel: (typeof TOAST_LEVEL_MODES)[keyof typeof TOAST_LEVEL_MODES]
  ): void {
    const settings: FullGlobalSettings = {
      settings: {
        ...CTRLYOKE_SETTINGS_DEFAULTS,
        notifications: {
          ...CTRLYOKE_SETTINGS_DEFAULTS.notifications,
          toastLevel,
        },
      },
      sources: {},
      isMultiRoot: false,
    };
    useSettingsStore.setState({ fullGlobalSettings: settings });
  }

  it("filters enqueueToast below the threshold and admits at-or-above severities", () => {
    setToastLevel(TOAST_LEVEL_MODES.WARNING_AND_ERROR);

    store().enqueueToast({
      message: "Info",
      severity: USER_FEEDBACK_SEVERITY.INFO,
    });
    store().enqueueToast({
      message: "Success",
      severity: USER_FEEDBACK_SEVERITY.SUCCESS,
    });
    store().enqueueToast({
      message: "Warning",
      severity: USER_FEEDBACK_SEVERITY.WARNING,
    });
    store().enqueueToast({
      message: "Error",
      severity: USER_FEEDBACK_SEVERITY.ERROR,
    });

    expect(store().toastQueue.map((toast) => toast.message)).toEqual([
      "Warning",
      "Error",
    ]);
  });

  it("fails open for enqueueToast before settings load", () => {
    store().enqueueToast({
      message: "Early toast",
      severity: USER_FEEDBACK_SEVERITY.INFO,
    });

    expect(store().toastQueue).toHaveLength(1);
  });

  it("filters showToast below the threshold and admits at-or-above severities", () => {
    setToastLevel(TOAST_LEVEL_MODES.ERROR_ONLY);

    store().showToast("Info", USER_FEEDBACK_SEVERITY.INFO);
    store().showToast("Success", USER_FEEDBACK_SEVERITY.SUCCESS);
    store().showToast("Warning", USER_FEEDBACK_SEVERITY.WARNING);
    store().showToast("Error", USER_FEEDBACK_SEVERITY.ERROR);

    expect(store().toastQueue.map((toast) => toast.message)).toEqual(["Error"]);
  });

  it("fails open for showToast before settings load", () => {
    store().showToast("Early toast", USER_FEEDBACK_SEVERITY.INFO);

    expect(store().toastQueue).toHaveLength(1);
  });

  function setMirroredToastLevel(
    toastLevel: (typeof TOAST_LEVEL_MODES)[keyof typeof TOAST_LEVEL_MODES]
  ): void {
    useSettingsStore.setState({
      globalSettings: {
        ...useSettingsStore.getState().globalSettings,
        toastLevel,
      },
    });
  }

  it("applies the mirrored globalSettings threshold before the drawer loads", () => {
    // `fullGlobalSettings` stays null until the settings drawer is opened, so
    // the INIT-mirrored value is the only threshold available after a reload.
    setMirroredToastLevel(TOAST_LEVEL_MODES.ERROR_ONLY);

    store().showToast("Info", USER_FEEDBACK_SEVERITY.INFO);
    store().enqueueToast({
      message: "Warning",
      severity: USER_FEEDBACK_SEVERITY.WARNING,
    });
    store().showToast("Error", USER_FEEDBACK_SEVERITY.ERROR);

    expect(store().toastQueue.map((toast) => toast.message)).toEqual(["Error"]);
  });

  it("prefers fullGlobalSettings over the mirrored value once loaded", () => {
    setMirroredToastLevel(TOAST_LEVEL_MODES.NONE);
    setToastLevel(TOAST_LEVEL_MODES.ALL);

    store().showToast("Info", USER_FEEDBACK_SEVERITY.INFO);

    expect(store().toastQueue).toHaveLength(1);
  });

  it("shows a toast with default info severity", () => {
    store().showToast("Hello!");
    expect(store().toastQueue[0]).toMatchObject({
      message: "Hello!",
      severity: USER_FEEDBACK_SEVERITY.INFO,
    });
  });

  it("supports enqueue, dedupe, cap, dismissal, and clearing", () => {
    store().enqueueToast({
      message: "First",
      severity: USER_FEEDBACK_SEVERITY.INFO,
      dedupeKey: "same",
    });
    store().enqueueToast({
      message: "Duplicate",
      severity: USER_FEEDBACK_SEVERITY.ERROR,
      dedupeKey: "same",
    });
    for (let index = 0; index < TOAST_QUEUE_LIMIT + 2; index++) {
      store().showToast(`Toast ${index}`, USER_FEEDBACK_SEVERITY.SUCCESS);
    }

    expect(store().toastQueue).toHaveLength(TOAST_QUEUE_LIMIT);
    expect(
      store().toastQueue.some((toast) => toast.message === "Duplicate")
    ).toBe(false);
    const firstId = store().toastQueue[0].id;
    store().dismissToast(firstId);
    expect(store().toastQueue.some((toast) => toast.id === firstId)).toBe(
      false
    );
    store().clearToasts();
    expect(store().toastQueue).toEqual([]);
  });

  it("keeps hideToast as a compatibility wrapper for clearing", () => {
    store().showToast("Hi");
    store().hideToast();
    expect(store().toastQueue).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Run history view
// ---------------------------------------------------------------------------

describe("setHistoryView", () => {
  it("enters history mode", () => {
    store().setHistoryView();
    expect(store().isViewingHistory).toBe(true);
  });
});

describe("setDisplayedRunView", () => {
  it("stores the directory alongside the address for both address-setting actions", () => {
    const runAddress = {
      workflowKey: "wf-1" as never,
      kind: "run" as const,
      runRef: "run-2026-07-20T10-30-00-000Z" as never,
    };
    store().setDisplayedRunView(
      runAddress,
      [],
      undefined,
      undefined,
      undefined,
      "C:/runs/wf-1/run-1"
    );
    expect(store().displayedViewAddress).toEqual(runAddress);
    expect(store().displayedRunDirectory).toBe("C:/runs/wf-1/run-1");

    const draftAddress = {
      workflowKey: "wf-1" as never,
      kind: "draft" as const,
    };
    store().setDisplayedViewIdentity(draftAddress, 2, 3, "C:/runs/wf-1/draft");
    expect(store().displayedViewAddress).toEqual(draftAddress);
    expect(store().displayedRunDirectory).toBe("C:/runs/wf-1/draft");
  });

  it("keeps pending rewind scoped to the addressed run and clears it on the next view", () => {
    const run = {
      workflowKey: "wf-1" as never,
      runRef: "run-2026-07-20T10-30-00-000Z" as never,
      runDirectory: "/runs/wf-1/run",
      runId: 4,
      startedAt: 1000,
      executionState: "idle" as never,
      stepCount: 2,
      definitionRevision: 3,
      hasMixedHarnesses: false,
      hasMixedModels: false,
    };
    store().setDisplayedRunView(
      {
        workflowKey: "wf-1" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: run.runRef,
      },
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
      { workflowKey: "wf-1" as never, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
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
      { workflowKey: "wf-2" as never, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
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
      { workflowKey: "other" as never, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
      9
    );
    expect(store().displayedDescriptorRevision).toBe(6);
  });
});

describe("requestRunViewLoad", () => {
  const summary = {
    workflowKey: "wf-1" as never,
    runRef: "run-2026-07-20T10-30-00-000Z" as never,
    runDirectory: "/runs/wf-1/run",
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
      {
        workflowKey: "wf-1" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: summary.runRef,
      },
      [summary],
      summary.runRef
    );

    store().requestRunViewLoad(
      {
        workflowKey: "wf-1" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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
      {
        workflowKey: "wf-1" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: summary.runRef,
      },
      [summary],
      summary.runRef
    );

    store().requestRunViewLoad(
      {
        workflowKey: "wf-2" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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

  it("restores the system-generated lock when a workflow switch rolls back", () => {
    const originalAddress = {
      workflowKey: "wf-1" as never,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    };
    store().setDisplayedRunView(
      originalAddress,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );

    store().requestRunViewLoad(
      { workflowKey: "wf-2" as never, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
      []
    );
    expect(store().viewedLineageIsSystemGenerated).toBe(false);

    store().rollbackRunViewLoad();

    expect(store().displayedViewAddress).toEqual(originalAddress);
    expect(store().viewedLineageIsSystemGenerated).toBe(true);
  });

  it("records a pending switch for cross-lineage requests only", () => {
    store().setDisplayedRunView(
      {
        workflowKey: "wf-1" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: summary.runRef,
      },
      [summary],
      summary.runRef
    );

    const targetAddress = {
      workflowKey: "wf-2" as never,
      kind: "draft" as const,
    };
    const switchRequestId = store().requestRunViewLoad(
      targetAddress,
      [],
      undefined,
      "Target workflow"
    );
    expect(store().pendingRunViewSwitch).toEqual({
      requestId: switchRequestId,
      workflowName: "Target workflow",
      address: targetAddress,
    });

    // A same-lineage follow-up supersedes the switch: its snapshot refines the
    // panels already on screen, so no overlay/rename should remain pending.
    store().requestRunViewLoad(
      {
        workflowKey: "wf-2" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: "run-2026-07-21T10-30-00-000Z" as never,
      },
      []
    );
    expect(store().pendingRunViewSwitch).toBeNull();
  });

  it("clearPendingRunViewLoad clears the pending switch with the request", () => {
    store().requestRunViewLoad(
      { workflowKey: "wf-9" as never, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
      [],
      undefined,
      "Somewhere else"
    );
    expect(store().pendingRunViewSwitch).not.toBeNull();

    store().clearPendingRunViewLoad();
    expect(store().pendingRunViewRequestId).toBeNull();
    expect(store().pendingRunViewSwitch).toBeNull();
  });

  it("does not mark the requested address as applied — only markViewAddressApplied does", () => {
    // requestRunViewLoad is the optimistic navigation step; it must not claim
    // that workflowStore holds the new address's content yet, or a snapshot
    // rejected/lost after this point would be indistinguishable from one that
    // genuinely arrived and applied.
    store().requestRunViewLoad(
      { workflowKey: "wf-9" as never, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
      []
    );
    expect(store().appliedViewAddress).toBeNull();
  });
});

describe("markViewAddressApplied", () => {
  it("records the address whose content workflowStore actually holds", () => {
    const address = { workflowKey: "wf-1" as never, kind: "draft" as const };
    expect(store().appliedViewAddress).toBeNull();

    store().markViewAddressApplied(address, 4);

    expect(store().appliedViewAddress).toEqual(address);
    expect(store().appliedDefinitionRevision).toBe(4);
  });

  it("keeps the applied revision independent of the displayed one", () => {
    // An identity published ahead of a write's snapshot advances only the
    // optimistic token the next mutation echoes; the content the client is
    // rendering is still the older revision until a snapshot applies it.
    store().markViewAddressApplied(
      { workflowKey: "wf-1" as never, kind: "draft" as const },
      4
    );
    store().setDisplayedViewIdentity(
      { workflowKey: "wf-1" as never, kind: "draft" as const },
      5,
      2
    );

    expect(store().displayedDefinitionRevision).toBe(5);
    expect(store().appliedDefinitionRevision).toBe(4);
  });
});

describe("markAppliedDefinitionRevision", () => {
  it("advances monotonically so a late push cannot rewind applied content", () => {
    store().markAppliedDefinitionRevision(6);
    store().markAppliedDefinitionRevision(3);

    expect(store().appliedDefinitionRevision).toBe(6);
  });
});

describe("clearHistoryView", () => {
  it("exits history mode", () => {
    store().setHistoryView();
    store().clearHistoryView();
    expect(store().isViewingHistory).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Recent workflows
// ---------------------------------------------------------------------------

describe("setRecentWorkflows", () => {
  it("replaces recent workflows list", () => {
    store().setRecentWorkflows([
      {
        address: {
          workflowKey: "wf1" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
        workflowName: "wf1",
        executionState: "idle",
        lastModifiedAt: 1000,
        isFavorite: true,
      },
      {
        address: {
          workflowKey: "wf2" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
        workflowName: "wf2",
        executionState: "completed",
        lastModifiedAt: 900,
      },
    ]);
    expect(store().recentWorkflows).toHaveLength(2);
    expect(store().recentWorkflows[0].workflowName).toBe("wf1");
  });
});

describe("updateRecentWorkflowFromSummary", () => {
  it("never lowers lineage recency when a live run summary is older", () => {
    store().setRecentWorkflows([
      {
        address: {
          workflowKey: "wf-1" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: "run-1" as never,
        },
        workflowName: "wf-1",
        executionState: "running",
        lastModifiedAt: 2_000,
      },
    ]);

    store().updateRecentWorkflowFromSummary({
      id: "wf-1",
      workflowKey: "wf-1" as never,
      workflowName: "wf-1",
      filePath: "",
      executionState: "running",
      currentStep: 1,
      totalSteps: 1,
      startedAt: 1_000,
      completedAt: undefined,
    } as WorkflowSummary);

    expect(store().recentWorkflows[0].lastModifiedAt).toBe(2_000);
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
      address: {
        workflowKey: "workflow-1" as any,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
      title: "Save draft",
      defaultPath: "/wf.yaml",
      defaultFormat: "yaml",
    });
    store().setLoading(true, "Loading...");
    store().showToast("Hello");

    store().resetUi();

    expect(store().saveWorkflowDialogOpen).toBe(false);
    expect(store().isLoading).toBe(false);
    expect(store().toastQueue).toEqual([]);
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

// ---------------------------------------------------------------------------
// suffixEditConfirmation
// ---------------------------------------------------------------------------

describe("setSuffixEditConfirmation", () => {
  const address = {
    workflowKey: "workflow-a" as never,
    kind: "run" as const,
    runRef: "run-2026-07-20T10-30-00-000Z" as never,
  };

  it("starts as null", () => {
    expect(store().suffixEditConfirmation).toBeNull();
  });

  it("sets the pending confirmation", () => {
    store().setSuffixEditConfirmation({
      action: "discardContinuation",
      address,
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 5,
    });
    expect(store().suffixEditConfirmation).toEqual({
      action: "discardContinuation",
      address,
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 5,
    });
  });

  it("clears the pending confirmation when set to null", () => {
    store().setSuffixEditConfirmation({
      action: "startNewRunInstead",
      address,
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 5,
    });
    store().setSuffixEditConfirmation(null);
    expect(store().suffixEditConfirmation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Observed-running ledger (workflow dropdown's pinned "Running" region)
// ---------------------------------------------------------------------------

describe("observedRunningWorkflowIds", () => {
  const summary = (
    id: string,
    executionState: ExecutionState
  ): WorkflowSummary => ({
    id,
    workflowKey: `key-${id}` as WorkflowSummary["workflowKey"],
    workflowName: `Workflow ${id}`,
    filePath: `/workspace/${id}.ctrlyoke.json`,
    executionState,
    currentStep: 0,
    totalSteps: 1,
  });

  beforeEach(() => {
    // resetUi() deliberately leaves the loaded-instance list (and therefore the
    // ledger derived from it) alone, so clear both explicitly.
    useUiStore.setState({
      loadedWorkflows: [],
      observedRunningWorkflowIds: new Set<string>(),
    });
  });

  it("starts empty", () => {
    expect(store().observedRunningWorkflowIds.size).toBe(0);
  });

  it("admits a workflow observed running", () => {
    store().addLoadedWorkflow(summary("a", EXECUTION_STATES.RUNNING));
    expect([...store().observedRunningWorkflowIds]).toEqual(["a"]);
  });

  it("admits a workflow observed pausing", () => {
    store().addLoadedWorkflow(summary("a", EXECUTION_STATES.PAUSING));
    expect([...store().observedRunningWorkflowIds]).toEqual(["a"]);
  });

  it("does not admit a workflow first seen already paused", () => {
    store().addLoadedWorkflow(summary("a", EXECUTION_STATES.PAUSED));
    expect(store().observedRunningWorkflowIds.size).toBe(0);
  });

  it("retains an admitted workflow across running → pausing → paused", () => {
    store().addLoadedWorkflow(summary("a", EXECUTION_STATES.RUNNING));
    store().updateLoadedWorkflow(summary("a", EXECUTION_STATES.PAUSING));
    store().updateLoadedWorkflow(summary("a", EXECUTION_STATES.PAUSED));
    expect([...store().observedRunningWorkflowIds]).toEqual(["a"]);
  });

  it("retains an admitted workflow through a wholesale list replacement", () => {
    store().addLoadedWorkflow(summary("a", EXECUTION_STATES.RUNNING));
    store().setLoadedWorkflows([summary("a", EXECUTION_STATES.PAUSED)]);
    expect([...store().observedRunningWorkflowIds]).toEqual(["a"]);
  });

  it("evicts a workflow removed from the loaded list", () => {
    store().addLoadedWorkflow(summary("a", EXECUTION_STATES.RUNNING));
    store().removeLoadedWorkflow("a");
    expect(store().observedRunningWorkflowIds.size).toBe(0);
  });

  it("prunes ids missing from a wholesale list replacement", () => {
    store().setLoadedWorkflows([
      summary("a", EXECUTION_STATES.RUNNING),
      summary("b", EXECUTION_STATES.RUNNING),
    ]);
    store().setLoadedWorkflows([summary("b", EXECUTION_STATES.PAUSED)]);
    expect([...store().observedRunningWorkflowIds]).toEqual(["b"]);
  });

  it("does not re-admit a paused workflow whose instance reappears after eviction", () => {
    store().addLoadedWorkflow(summary("a", EXECUTION_STATES.RUNNING));
    store().removeLoadedWorkflow("a");
    store().addLoadedWorkflow(summary("a", EXECUTION_STATES.PAUSED));
    expect(store().observedRunningWorkflowIds.size).toBe(0);
  });

  it("keeps the same Set identity when nothing moved", () => {
    store().addLoadedWorkflow(summary("a", EXECUTION_STATES.RUNNING));
    const first = store().observedRunningWorkflowIds;
    store().updateLoadedWorkflow(summary("a", EXECUTION_STATES.PAUSED));
    expect(store().observedRunningWorkflowIds).toBe(first);
  });

  it("evicts an observed workflow when a terminal summary arrives", () => {
    store().addLoadedWorkflow({
      ...summary("a", EXECUTION_STATES.RUNNING),
      externalOwner: { locality: "external", runner: RUNNER_IDS.CLI },
    });
    store().updateLoadedWorkflow({
      ...summary("a", EXECUTION_STATES.COMPLETED),
      externalOwner: { locality: "external", runner: RUNNER_IDS.CLI },
    });

    expect([...store().observedRunningWorkflowIds]).toEqual([]);
  });
});
