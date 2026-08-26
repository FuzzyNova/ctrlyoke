import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
} from "react";
import { useWorkflowStore } from "../../store/workflowStore";
import { useUiStore, type RecentWorkflow } from "../../store/uiStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useTerminalStore } from "../../store/terminalStore";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { sendMessage } from "../../hooks/useMessageHandler";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  RUNNER_IDS,
  TERMINAL_SESSION_STATUS,
  type ExecutionState,
} from "../../types/messages";
import {
  DEFAULT_WORKFLOW_NAME,
  WORKTREE_MODES,
  WORKTREE_MODE_OPTIONS,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import { WorkflowList, type UnifiedWorkflowRow } from "./WorkflowList";
import { RunPanel } from "./RunPanel";
import { RunIdentityBadge } from "./RunIdentityBadge";
import type { RunPanelRow } from "./RunSummaryRow";
import { useRunSummaryCacheStore } from "../../store/runSummaryCacheStore";
import { areWorkflowAddressesEqual } from "@utils/viewAddress";
import {
  navigateToWorkflowAddress,
  isDrillableRunNav,
  viewedRunLabel,
} from "../../utils/runNavigation";
import { postWorkflowDefinitionMutation } from "../../utils/workflowMutation";
import type {
  WorkflowKey,
  RunRef,
  WorkflowViewAddress,
} from "@root/types/CtrlYokeTypes";
import { DateRangeFilterControls, MultiCheckboxDropdown } from "../shared";
import { DeleteConfirmModal } from "../shared/DeleteConfirmModal";
import { isWorkflowActive, isWorkflowRunning } from "../../utils/status";
import { ExecutionStateBadge } from "../shared/ExecutionStateBadge";
import { useElementNarrow, useElementTier } from "../../hooks/useElementNarrow";
import { useIsMobile } from "@hooks/useMediaQuery";
import { getContextMenuOpener, useLongPress } from "@hooks/useLongPress";
import {
  useWorkflowContextMenu,
  type WorkflowContextMenuTarget,
} from "@hooks/useWorkflowContextMenu";
import { WebviewLog } from "@utils/logger";
import {
  resolveWorkflowRowTier,
  WORKFLOW_DROPDOWN_TARGET_WIDTH,
  WORKFLOW_STATUS_BUTTON_SIZES,
  type WorkflowRowTier,
} from "../../constants";
import {
  ALL_WORKFLOW_HARNESSES,
  ALL_WORKFLOW_STATES,
  DEFAULT_DATE_RANGE_FILTER,
  getDateEndMs,
  getDateStartMs,
  WORKFLOW_HARNESS_OPTIONS,
  WORKFLOW_STATE_OPTIONS,
  type DateRangeFilter,
} from "../../utils/dateRangeFilter";
import { formatMultiFilterLabel } from "../../utils/filterLabels";

interface WorkflowStatusProps {
  className?: string;
}

const WORKFLOW_ROW_SELECTOR =
  ".running-workflow-item, .workflow-menu-item, .run-panel-row";
const WORKFLOW_ROW_WIDTH_CSS_VAR = "--workflow-row-usable-width";
// Keep the fallback slightly longer than the shared 220ms Tailwind
// slide-out-right animation so a missed animationend cannot strand the
// dropdown in its departing run-panel state.
const RUN_PANEL_EXIT_FALLBACK_MS = 320;

type PendingDelete =
  | {
      address: WorkflowViewAddress;
      scope: WorkflowContextMenuTarget["scope"];
    }
  | {
      scope: "all";
    };

function assertNever(value: never): never {
  throw new Error(`Unexpected pending delete scope: ${String(value)}`);
}

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10;
}

function sortRecentWorkflows(workflows: RecentWorkflow[]): RecentWorkflow[] {
  return [...workflows].sort((a, b) => {
    if ((a.isFavorite ?? false) !== (b.isFavorite ?? false)) {
      return (a.isFavorite ?? false) ? -1 : 1;
    }

    return (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0);
  });
}

/**
 * WorkflowStatus - Split button showing current workflow name with dropdown
 *
 * Features:
 * - Displays current workflow name and execution state
 * - Click main button to edit workflow name inline
 * - Dropdown shows recent workflows
 * - Clear history option
 */
export const WorkflowStatus: React.FC<WorkflowStatusProps> = ({
  className = "",
}) => {
  const vscode = useVsCodeApi();
  const { fileName, workflowName, executionState, currentStep, totalSteps } =
    useWorkflowStore();
  const {
    loadedWorkflows,
    observedRunningWorkflowIds,
    activeWorkflowId,
    activeWorkflowWorkingFilePath,
    displayedViewAddress,
    displayedRunDirectory,
    pendingRunViewSwitch,
    recentWorkflows,
    setRecentWorkflows,
    openDuplicateWorkflowDialog,
    setActiveWorkflowWorkingFilePath,
    runSummaries,
    executionRunRef,
    isViewingHistory,
    setViewingDeletedWorkflow,
  } = useUiStore();
  const { globalSettings, workflowProperties } = useSettingsStore();
  const effectiveWorktree = useMemo(() => {
    const authored = workflowProperties.worktree;
    if (authored === false) return false;
    if (authored === true) return { mode: WORKTREE_MODES.MANAGED };
    if (authored === undefined) {
      const configured = globalSettings.worktree;
      return configured?.mode === WORKTREE_MODES.NONE
        ? false
        : (configured ?? false);
    }
    if (typeof authored === "string") {
      return { mode: WORKTREE_MODES.NAMED, branch: authored };
    }
    return authored;
  }, [globalSettings.worktree, workflowProperties.worktree]);
  const worktreeIndicator = useMemo(() => {
    if (
      effectiveWorktree === false ||
      effectiveWorktree.mode === WORKTREE_MODES.NONE
    ) {
      return undefined;
    }
    const modeLabel =
      WORKTREE_MODE_OPTIONS.find(
        (option) => option.value === effectiveWorktree.mode
      )?.label ?? effectiveWorktree.mode;
    const branch =
      "branch" in effectiveWorktree && effectiveWorktree.branch?.trim();
    return {
      title: `${modeLabel} worktree${branch ? `: ${branch}` : ""}`,
    };
  }, [effectiveWorktree]);
  // Global set of workflows with a running PTY, broadcast by the extension. This
  // is complete for every workflow on every client (including hosted browser
  // tabs) — unlike the per-workflow `sessions` map, which a client only hydrates
  // for the workflow it is actively viewing. Using it here is what keeps the
  // dropdown terminal icon visible for non-viewed workflows and across switches.
  const activeTerminalWorkflows = useTerminalStore(
    (s) => s.activeTerminalWorkflows
  );
  const terminalSessions = useTerminalStore((s) => s.sessions);
  const activeTerminalWorkflowIds = useMemo(
    () => new Set(activeTerminalWorkflows.map((w) => w.workflowId)),
    [activeTerminalWorkflows]
  );
  const activeTerminalRunAddresses = useMemo(
    () =>
      new Set(
        activeTerminalWorkflows.map((w) => `${w.workflowKey}:${w.runRef}`)
      ),
    [activeTerminalWorkflows]
  );

  const activeManagedBy = loadedWorkflows.find(
    (w) => w.id === activeWorkflowId
  )?.managedBy;
  const isExternallyManaged = activeManagedBy != null;
  const workflowHasActiveTerminal = useCallback(
    (workflowId: string | null | undefined) =>
      !!workflowId && activeTerminalWorkflowIds.has(workflowId),
    [activeTerminalWorkflowIds]
  );
  const currentWorkflowHasActiveTerminal =
    workflowHasActiveTerminal(activeWorkflowId) ||
    (activeWorkflowId
      ? (terminalSessions[activeWorkflowId] ?? []).some(
          (session) => session.status === TERMINAL_SESSION_STATUS.RUNNING
        )
      : false);

  const syntheticActiveWorkflow = useMemo(
    () =>
      activeWorkflowId &&
      isWorkflowActive(executionState) &&
      !loadedWorkflows.some((w) => w.id === activeWorkflowId)
        ? {
            id: activeWorkflowId,
            // Sourced from the client's own displayed address — this
            // component's active workflow and displayed address are always
            // the same lineage. Without a real workflowKey here, the
            // dropdown's "hide the recent row already represented by a
            // running row" exclusion (keyed on workflowKey) can't recognize
            // this placeholder, so a stale recent row for the same lineage
            // lingers alongside it until the real WORKFLOW_ADDED broadcast
            // replaces this placeholder.
            workflowKey: displayedViewAddress?.workflowKey,
            runRef:
              displayedViewAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
                ? displayedViewAddress.runRef
                : undefined,
            workflowName:
              workflowName ||
              (fileName
                ? getWorkflowNameFromPath(fileName)
                : DEFAULT_WORKFLOW_NAME),
            filePath: activeWorkflowWorkingFilePath ?? fileName ?? "",
            workingFilePath: activeWorkflowWorkingFilePath ?? undefined,
            executionState,
            currentStep,
            totalSteps,
          }
        : null,
    [
      activeWorkflowId,
      activeWorkflowWorkingFilePath,
      currentStep,
      displayedViewAddress,
      executionState,
      fileName,
      loadedWorkflows,
      totalSteps,
      workflowName,
    ]
  );

  const effectiveLoadedWorkflows = useMemo(
    () =>
      syntheticActiveWorkflow
        ? [...loadedWorkflows, syntheticActiveWorkflow]
        : loadedWorkflows,
    [loadedWorkflows, syntheticActiveWorkflow]
  );

  // Which loaded instances belong in the dropdown's pinned running region.
  // Executing (RUNNING/PAUSING) always qualifies; PAUSED only qualifies for a
  // workflow that was observed executing here (see
  // `uiStore.observedRunningWorkflowIds`). A lineage merely *opened* while its
  // latest run sits paused on disk therefore stays an ordinary lineage row,
  // where its PAUSED badge already comes straight off disk, and where a
  // Resume/Stop pair can't claim a run it doesn't identify: a lineage may hold
  // many paused runs while only ever executing one.
  const runningSectionWorkflows = useMemo(
    () =>
      effectiveLoadedWorkflows.filter(
        (workflow) =>
          isWorkflowRunning(workflow.executionState) ||
          observedRunningWorkflowIds.has(workflow.id)
      ),
    [effectiveLoadedWorkflows, observedRunningWorkflowIds]
  );
  // Lineages represented by a running row — the only ones a recent row must
  // stand down for, so that one lineage never renders twice.
  const runningSectionWorkflowKeys = useMemo(
    () =>
      new Set(
        runningSectionWorkflows
          .map((workflow) => workflow.workflowKey)
          .filter((key): key is WorkflowKey => key !== undefined)
      ),
    [runningSectionWorkflows]
  );

  const recentWorkflowHasActiveTerminal = useCallback(
    (workflow: RecentWorkflow) =>
      (workflow.address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        activeTerminalRunAddresses.has(
          `${workflow.address.workflowKey}:${workflow.address.runRef}`
        )) ||
      effectiveLoadedWorkflows.some(
        (w) =>
          w.workflowKey === workflow.address.workflowKey &&
          activeTerminalWorkflowIds.has(w.id)
      ),
    [
      activeTerminalWorkflowIds,
      activeTerminalRunAddresses,
      effectiveLoadedWorkflows,
    ]
  );

  // Local state
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [dropdownTop, setDropdownTop] = useState(0);
  const [dropdownLeft, setDropdownLeft] = useState(0);
  const [dropdownWidth, setDropdownWidth] = useState<number | null>(null);
  // True only while the exit transition is playing — lets the dropdown stay
  // mounted (with its pre-close content/filters) through the fade so closing
  // animates instead of the list re-filtering out from under it.
  const [isDropdownClosing, setIsDropdownClosing] = useState(false);
  const [workflowSearch, setWorkflowSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedWorkflowStates, setSelectedWorkflowStates] = useState<
    string[]
  >(() => [...ALL_WORKFLOW_STATES]);
  const [selectedWorkflowHarnesses, setSelectedWorkflowHarnesses] = useState<
    string[]
  >(() => [...ALL_WORKFLOW_HARNESSES]);
  const [workflowDateFilter, setWorkflowDateFilter] = useState<DateRangeFilter>(
    DEFAULT_DATE_RANGE_FILTER
  );
  const [favoriteWorkflowsOnly, setFavoriteWorkflowsOnly] = useState(false);
  // Pending lineage or run address waiting for delete confirmation.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null
  );
  const sortedRecentWorkflows = useMemo(
    () => sortRecentWorkflows(recentWorkflows),
    [recentWorkflows]
  );

  // Dropdown view state — ephemeral per-open-session, reset on close. Drilling
  // into a lineage swaps the workflow list for its run panel without closing
  // the dropdown; the same two views are what the badge/chevron/back triggers
  // navigate between (RUN_NAVIGATION_UX_PLAN.md).
  const [dropdownView, setDropdownView] = useState<"workflows" | "runs">(
    "workflows"
  );
  // The run panel remains mounted while returning to the workflow list so its
  // slide-right exit is visible instead of the two views swapping abruptly.
  const [isRunPanelLeaving, setIsRunPanelLeaving] = useState(false);
  // Opening from a workflow-row indicator is a lateral drill-in. The header's
  // Run N button opens the dropdown directly in this view, so its dropdown
  // reveal is enough motion by itself.
  const [shouldAnimateRunPanelEntry, setShouldAnimateRunPanelEntry] =
    useState(false);
  const [drilledWorkflow, setDrilledWorkflow] = useState<{
    workflowKey: WorkflowKey;
    workflowName: string;
  } | null>(null);
  const runPanelExitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  // While a cross-lineage switch is in flight the workflow store still holds
  // the previous workflow's definition. Show the switch target immediately so
  // the click visibly took effect before the snapshot lands. Computed early
  // (rather than just before render) since the run-identity badge's opener
  // also needs it to name the lineage it's drilling into.
  const displayName =
    pendingRunViewSwitch?.workflowName ??
    (fileName
      ? workflowName || getWorkflowNameFromPath(fileName)
      : DEFAULT_WORKFLOW_NAME);
  const isNewWorkflow =
    fileName === DEFAULT_WORKFLOW_NAME && !workflowName && totalSteps === 0;

  const isMobile = useIsMobile();
  const wfStatusSize = isMobile
    ? WORKFLOW_STATUS_BUTTON_SIZES.touch
    : WORKFLOW_STATUS_BUTTON_SIZES.default;
  // Two independent width measurements: the split button's own width drives
  // the header segments, while the dropdown popup's width drives its rows.
  // They differ by hundreds of pixels on mobile (a ~180px trigger opening a
  // full-width popup), so sharing one measurement compacted rows that had room
  // to spare. The popup's is a three-way tier rather than a boolean — stacking
  // and abbreviating happen at different widths.
  const [narrowRef, isNarrow] = useElementNarrow<HTMLDivElement>(300);
  const [dropdownTierRef, dropdownRowTier] = useElementTier<
    WorkflowRowTier,
    HTMLDivElement
  >(resolveWorkflowRowTier, "stacked");

  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Whichever split-button segment opened the dropdown — Escape restores
  // focus here rather than leaving it stranded on an unmounting popup.
  const dropdownOpenerRef = useRef<HTMLElement | null>(null);

  const mergedContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      narrowRef(node);
    },
    [narrowRef]
  );

  const mergedDropdownRef = useCallback(
    (node: HTMLDivElement | null) => {
      dropdownRef.current = node;
      dropdownTierRef(node);
    },
    [dropdownTierRef]
  );

  const updateDropdownTop = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      setDropdownTop(0);
      setDropdownLeft(0);
      setDropdownWidth(null);
      return;
    }

    // Anchor the dropdown to the status control's own bottom (not the header's). The header can
    // have a second row of controls beneath the status (medium/narrow tiers), so anchoring to the
    // header bottom would leave that controls row wedged between the status button and the dropdown
    // list. Opening from the control's bottom makes the list expand directly from where it's invoked.
    const rect = container.getBoundingClientRect();
    const desktopDropdownWidth = Math.min(
      WORKFLOW_DROPDOWN_TARGET_WIDTH,
      window.innerWidth
    );
    const alignedDropdownWidth = isMobile
      ? rect.width
      : Math.max(rect.width, desktopDropdownWidth);
    const centeredLeft = rect.left + rect.width / 2 - alignedDropdownWidth / 2;
    const clampedLeft = Math.max(
      0,
      Math.min(centeredLeft, window.innerWidth - alignedDropdownWidth)
    );
    setDropdownTop(rect.bottom);
    setDropdownLeft(clampedLeft);
    setDropdownWidth(alignedDropdownWidth);
  }, [isMobile]);

  // Some engines resolve untouched rows inside vertical scrollers against the
  // usable content box while touch/hover resolves them under the scrollbar.
  // Measure the natural usable row width and lock every row to it so outlines
  // stay visible and metadata columns cannot jump sideways.
  const syncWorkflowRowWidthLock = useCallback(() => {
    const dropdown = dropdownRef.current;
    const scrollContainer = dropdown?.querySelector(
      dropdownView === "runs"
        ? ".run-panel-items"
        : ".workflow-menu-items, .running-workflow-items"
    );
    if (!dropdown || !scrollContainer) {
      return;
    }

    dropdown.style.removeProperty(WORKFLOW_ROW_WIDTH_CSS_VAR);

    const naturalRows = Array.from(
      scrollContainer.querySelectorAll(WORKFLOW_ROW_SELECTOR)
    )
      .map((row) => row.getBoundingClientRect().width)
      .filter((width) => width > 0);

    if (naturalRows.length === 0) {
      return;
    }

    const usableWidth = Math.min(...naturalRows);
    dropdown.style.setProperty(
      WORKFLOW_ROW_WIDTH_CSS_VAR,
      `${roundMetric(usableWidth)}px`
    );
  }, [dropdownView]);

  // ResizeObserver + window resize run for the component's whole lifetime (not just
  // while open) so dropdownTop/Left/Width are already correct the instant the user
  // clicks the trigger — opening doesn't need to wait a frame to reposition, it just
  // reveals. The scroll listener stays scoped to isDropdownOpen since it only matters
  // for keeping an already-visible popup glued to its anchor as the page scrolls.
  useLayoutEffect(() => {
    updateDropdownTop();

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      updateDropdownTop();
    });
    resizeObserver.observe(container);
    window.addEventListener("resize", updateDropdownTop);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateDropdownTop);
    };
  }, [updateDropdownTop]);

  useLayoutEffect(() => {
    if (!isDropdownOpen) {
      return;
    }

    window.addEventListener("scroll", updateDropdownTop, true);
    return () => {
      window.removeEventListener("scroll", updateDropdownTop, true);
    };
  }, [isDropdownOpen, updateDropdownTop]);

  useEffect(() => {
    const dropdown = dropdownRef.current;
    if (!isDropdownOpen || !dropdown) {
      return;
    }

    const animationFrameIds: number[] = [];
    const timeoutIds: number[] = [];

    const scheduleWidthLock = () => {
      const frameId = window.requestAnimationFrame(() => {
        syncWorkflowRowWidthLock();
      });
      animationFrameIds.push(frameId);
    };

    const mutationObserver = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.type === "childList")) {
        scheduleWidthLock();
      }
    });
    mutationObserver.observe(dropdown, {
      childList: true,
      subtree: true,
    });

    const resizeObserver = new ResizeObserver(() => {
      scheduleWidthLock();
    });
    resizeObserver.observe(dropdown);
    const scrollContainer = dropdown.querySelector(
      dropdownView === "runs"
        ? ".run-panel-items"
        : ".workflow-menu-items, .running-workflow-items"
    );
    if (scrollContainer) {
      resizeObserver.observe(scrollContainer);
    }

    const handleResize = () => {
      dropdown.style.removeProperty(WORKFLOW_ROW_WIDTH_CSS_VAR);
      scheduleWidthLock();
    };

    dropdown.style.removeProperty(WORKFLOW_ROW_WIDTH_CSS_VAR);
    scheduleWidthLock();
    timeoutIds.push(window.setTimeout(scheduleWidthLock, 50));
    window.addEventListener("resize", handleResize);

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleResize);
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
      animationFrameIds.forEach((frameId) =>
        window.cancelAnimationFrame(frameId)
      );
      dropdown.style.removeProperty(WORKFLOW_ROW_WIDTH_CSS_VAR);
    };
  }, [dropdownView, isDropdownOpen, syncWorkflowRowWidthLock]);

  // Closing plays a fade/clip-path transition before the popup actually
  // unmounts. isDropdownOpen (and therefore the rendered list content) stays
  // put until the transition finishes — clearing the search filter immediately
  // instead would re-filter the list mid-fade and make the animation look
  // broken or instant. finishClosingDropdown is the single place that actually
  // flips isDropdownOpen off; it's called from both the transitionend handler
  // and a fallback timer below so a missed/short-circuited transition (e.g. the
  // opacity class never actually changing) can never leave the dropdown wedged
  // in a permanently-closing state that ignores further toggle clicks.
  const closeDropdownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const finishClosingDropdown = useCallback(() => {
    if (closeDropdownTimeoutRef.current) {
      clearTimeout(closeDropdownTimeoutRef.current);
      closeDropdownTimeoutRef.current = null;
    }
    setIsDropdownClosing(false);
    setIsDropdownOpen(false);
    if (runPanelExitTimeoutRef.current) {
      clearTimeout(runPanelExitTimeoutRef.current);
      runPanelExitTimeoutRef.current = null;
    }
    setIsRunPanelLeaving(false);
    setShouldAnimateRunPanelEntry(false);
    setWorkflowSearch("");
    // Dropdown view state is per-open-session — reset so the next open
    // starts from whichever entry view its own trigger implies.
    setDropdownView("workflows");
    setDrilledWorkflow(null);
  }, []);

  useEffect(() => {
    return () => {
      if (closeDropdownTimeoutRef.current) {
        clearTimeout(closeDropdownTimeoutRef.current);
      }
      if (runPanelExitTimeoutRef.current) {
        clearTimeout(runPanelExitTimeoutRef.current);
      }
    };
  }, []);

  const closeDropdown = useCallback(() => {
    if (!isDropdownOpen || isDropdownClosing) {
      return;
    }
    setIsDropdownClosing(true);
    if (closeDropdownTimeoutRef.current) {
      clearTimeout(closeDropdownTimeoutRef.current);
    }
    // Safety net: fires slightly after the 220ms exit transition in case
    // transitionend never arrives, so a toggle click can never get stuck.
    closeDropdownTimeoutRef.current = setTimeout(finishClosingDropdown, 320);
  }, [isDropdownOpen, isDropdownClosing, finishClosingDropdown]);

  const handleDropdownTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      if (
        event.target !== event.currentTarget ||
        event.propertyName !== "opacity"
      ) {
        return;
      }
      if (isDropdownClosing) {
        finishClosingDropdown();
      }
    },
    [isDropdownClosing, finishClosingDropdown]
  );

  const filtersActive =
    selectedWorkflowStates.length !== ALL_WORKFLOW_STATES.length ||
    selectedWorkflowHarnesses.length !== ALL_WORKFLOW_HARNESSES.length ||
    workflowDateFilter.from.length > 0 ||
    workflowDateFilter.to.length > 0 ||
    favoriteWorkflowsOnly;

  const resetWorkflowFilters = useCallback(() => {
    setSelectedWorkflowStates([...ALL_WORKFLOW_STATES]);
    setSelectedWorkflowHarnesses([...ALL_WORKFLOW_HARNESSES]);
    setWorkflowDateFilter(DEFAULT_DATE_RANGE_FILTER);
    setFavoriteWorkflowsOnly(false);
  }, []);

  const handleToggleFilters = useCallback(() => {
    setFiltersOpen((open) => !open);
  }, []);

  // Request recent workflows once on mount so the count badge is visible immediately
  useEffect(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.GET_RECENT_WORKFLOWS });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      const isDropdownPortalClick =
        target instanceof Element &&
        target.closest(".fp-dropdown-popup, .step-context-menu");
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node) &&
        !isDropdownPortalClick
      ) {
        closeDropdown();
      }
    };

    if (isDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [closeDropdown, isDropdownOpen]);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // The backend represents a fresh blank workflow as "New Workflow" with no
  // custom name or steps. Focus it when that state arrives from the header's
  // New button, including when the component mounts into that state.
  useEffect(() => {
    if (!isNewWorkflow) {
      return;
    }

    setEditValue("");
    setIsEditing(true);
  }, [isNewWorkflow]);

  // Start editing workflow name
  const startEditing = useCallback(() => {
    if (!fileName) return;
    // Mid-switch the store still holds the previous workflow's name while the
    // displayed address already targets the new one — a rename here would pair
    // the old name with the new address. Wait for the snapshot.
    if (pendingRunViewSwitch) return;
    setEditValue(workflowName || getWorkflowNameFromPath(fileName));
    setIsEditing(true);
  }, [fileName, pendingRunViewSwitch, workflowName]);

  // Save edited workflow name
  const saveEdit = useCallback(() => {
    const newName = editValue.trim();
    if (!newName) {
      setIsEditing(false);
      return;
    }

    const currentName = workflowName || getWorkflowNameFromPath(fileName || "");
    if (newName !== currentName) {
      // Rename must carry the displayed address/revisions so a promoted run's
      // head is renamed in place — without it the backend falls back to the
      // instance-bound path, which renames whatever run the lineage instance
      // currently holds instead of the viewed run.
      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_NAME,
        workflowName: newName,
      });
    }

    setIsEditing(false);
  }, [editValue, workflowName, fileName, vscode]);

  // Cancel editing
  const cancelEdit = useCallback(() => {
    setIsEditing(false);
  }, []);

  // Handle input key events
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      saveEdit();
    } else if (e.key === "Escape") {
      cancelEdit();
    }
  };

  const finishRunPanelExit = useCallback(() => {
    if (runPanelExitTimeoutRef.current) {
      clearTimeout(runPanelExitTimeoutRef.current);
      runPanelExitTimeoutRef.current = null;
    }
    setIsRunPanelLeaving(false);
    setShouldAnimateRunPanelEntry(false);
    setDropdownView("workflows");
    setDrilledWorkflow(null);
  }, []);

  // Back always returns to the workflow list — even entering via the badge.
  // It remains mounted behind the drawer, so its filters and scroll position
  // survive the round trip without a separate restoration step.
  const handleBackToWorkflowList = useCallback(() => {
    if (dropdownView !== "runs" || isRunPanelLeaving) {
      return;
    }
    setIsRunPanelLeaving(true);
    if (runPanelExitTimeoutRef.current) {
      clearTimeout(runPanelExitTimeoutRef.current);
    }
    runPanelExitTimeoutRef.current = setTimeout(
      finishRunPanelExit,
      RUN_PANEL_EXIT_FALLBACK_MS
    );
  }, [dropdownView, finishRunPanelExit, isRunPanelLeaving]);

  const handleRunPanelAnimationEnd = useCallback(
    (event: React.AnimationEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && isRunPanelLeaving) {
        finishRunPanelExit();
      }
    },
    [finishRunPanelExit, isRunPanelLeaving]
  );

  // Toggle dropdown
  const toggleDropdown = useCallback(() => {
    if (!isDropdownOpen) {
      updateDropdownTop();
      setWorkflowSearch("");
      WebviewLog.debug(
        `[WorkflowStatus:toggleDropdown] opening dropdown — requesting workflows list. ` +
          `Current loadedWorkflows: [${loadedWorkflows.map((w) => `inst:${w.id.slice(0, 8)}(name="${w.workflowName || "(empty)"}", state=${w.executionState})`).join(", ") || "(none)"}], ` +
          (syntheticActiveWorkflow
            ? ` syntheticActive=inst:${syntheticActiveWorkflow.id.slice(0, 8)}(state=${syntheticActiveWorkflow.executionState}),`
            : "") +
          `activeWorkflowId=inst:${activeWorkflowId?.slice(0, 8) ?? "null"}, ` +
          `current fileName="${fileName || "(none)"}", workflowName="${workflowName || "(none)"}"`
      );
      // Request recent workflows and full loaded-workflows list from extension
      vscode.postMessage({ type: MESSAGE_TYPES.GET_RECENT_WORKFLOWS });
      vscode.postMessage({ type: MESSAGE_TYPES.GET_WORKFLOWS_LIST });
      setIsDropdownClosing(false);
      setIsDropdownOpen(true);
      setIsRunPanelLeaving(false);
      setShouldAnimateRunPanelEntry(false);
      setDropdownView("workflows");
      setDrilledWorkflow(null);
      return;
    }
    if (isDropdownClosing) {
      WebviewLog.debug(
        "[WorkflowStatus:toggleDropdown] ignored — still playing the close transition"
      );
      return;
    }
    // Chevron re-click while the run panel is showing switches back to the
    // workflow list instead of closing outright — matching the badge's own
    // "switch views, don't close" behavior when the other view is active.
    if (dropdownView !== "workflows") {
      handleBackToWorkflowList();
      return;
    }
    closeDropdown();
  }, [
    isDropdownOpen,
    isDropdownClosing,
    dropdownView,
    vscode,
    loadedWorkflows,
    activeWorkflowId,
    fileName,
    syntheticActiveWorkflow,
    workflowName,
    updateDropdownTop,
    closeDropdown,
    handleBackToWorkflowList,
  ]);

  // Switch to a loaded workflow
  const handleSwitchWorkflow = useCallback(
    (workflowId: string) => {
      const workflow = effectiveLoadedWorkflows.find(
        (w) => w.id === workflowId
      );
      setActiveWorkflowWorkingFilePath(workflow?.workingFilePath ?? null);
      if (workflow && isWorkflowRunning(workflow.executionState)) {
        useWorkflowStore.getState().clearHistoryOutputs();
        useUiStore.getState().clearHistoryView();
      }
      vscode.postMessage({
        type: MESSAGE_TYPES.SWITCH_WORKFLOW,
        workflowId,
      });
      closeDropdown();
    },
    [
      closeDropdown,
      effectiveLoadedWorkflows,
      setActiveWorkflowWorkingFilePath,
      vscode,
    ]
  );

  // Load workflow from recent list
  const handleSelectWorkflow = useCallback(
    (address: WorkflowViewAddress) => {
      const selectedWorkflow = recentWorkflows.find((workflow) =>
        areWorkflowAddressesEqual(workflow.address, address)
      );
      if (
        selectedWorkflow &&
        ALL_WORKFLOW_STATES.includes(
          selectedWorkflow.executionState as ExecutionState
        )
      ) {
        // The address changes optimistically, so move the lightweight runtime
        // state with it. Otherwise Header keeps rendering the workflow we just
        // left until the asynchronous definition snapshot arrives.
        useWorkflowStore
          .getState()
          .setExecutionState(selectedWorkflow.executionState as ExecutionState);
      }
      // Names the pending switch so the header renames instantly and the
      // panel overlay can say what it is loading.
      navigateToWorkflowAddress(
        vscode,
        address,
        selectedWorkflow?.workflowName
      );
      closeDropdown();
    },
    [closeDropdown, recentWorkflows, vscode]
  );

  // Drill into a lineage's run panel from the workflow list's run-indicator
  // cell — never selects/loads the lineage, only swaps dropdown views.
  const handleDrillIntoRuns = useCallback(
    (workflow: RecentWorkflow) => {
      setDrilledWorkflow({
        workflowKey: workflow.address.workflowKey,
        workflowName: workflow.workflowName,
      });
      setIsRunPanelLeaving(false);
      setShouldAnimateRunPanelEntry(true);
      setDropdownView("runs");
      if (workflow.address.workflowKey !== displayedViewAddress?.workflowKey) {
        useRunSummaryCacheStore
          .getState()
          .ensureRunSummaries(
            workflow.address.workflowKey,
            workflow.lastModifiedAt
          );
      }
    },
    [displayedViewAddress]
  );

  // The run-identity badge always drills into the *displayed* lineage's own
  // panel, so its summaries are already in uiStore — no fetch needed.
  const handleOpenDisplayedRunPanel = useCallback(() => {
    if (!displayedViewAddress) return;
    const alreadyShowingThisPanel =
      isDropdownOpen &&
      !isDropdownClosing &&
      dropdownView === "runs" &&
      drilledWorkflow?.workflowKey === displayedViewAddress.workflowKey;
    if (alreadyShowingThisPanel) {
      closeDropdown();
      return;
    }
    updateDropdownTop();
    setIsDropdownClosing(false);
    setIsDropdownOpen(true);
    setIsRunPanelLeaving(false);
    setShouldAnimateRunPanelEntry(false);
    setDrilledWorkflow({
      workflowKey: displayedViewAddress.workflowKey,
      workflowName: displayName,
    });
    setDropdownView("runs");
  }, [
    displayedViewAddress,
    isDropdownOpen,
    isDropdownClosing,
    dropdownView,
    drilledWorkflow,
    closeDropdown,
    updateDropdownTop,
    displayName,
  ]);

  // Escape backs out of the drilled-in run panel, using the same slide-right
  // transition as the visible back button. From the workflow list it still
  // closes the dropdown and restores focus to the segment that opened it.
  useEffect(() => {
    if (!isDropdownOpen) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (dropdownView === "runs") {
        handleBackToWorkflowList();
        return;
      }
      const opener = dropdownOpenerRef.current;
      closeDropdown();
      opener?.focus();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [closeDropdown, dropdownView, handleBackToWorkflowList, isDropdownOpen]);

  const handleSelectRunPanelRow = useCallback(
    (address: WorkflowViewAddress) => {
      navigateToWorkflowAddress(vscode, address, drilledWorkflow?.workflowName);
      closeDropdown();
    },
    [closeDropdown, drilledWorkflow, vscode]
  );

  const handleDeleteRunPanelRow = useCallback(
    (runRef: RunRef, requestConfirmation = false) => {
      if (!drilledWorkflow) return;
      const address: WorkflowViewAddress = {
        workflowKey: drilledWorkflow.workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      };
      if (requestConfirmation && globalSettings.confirmDeleteOperations) {
        setPendingDelete({ address, scope: "run" });
        return;
      }
      vscode.postMessage({
        type: MESSAGE_TYPES.DELETE_RUN_HISTORY,
        address,
      });
    },
    [drilledWorkflow, globalSettings.confirmDeleteOperations, vscode]
  );

  const handleDeleteAllRunsInPanel = useCallback(() => {
    if (!drilledWorkflow) return;
    vscode.postMessage({
      type: MESSAGE_TYPES.DELETE_ALL_RUNS_FOR_LINEAGE,
      workflowKey: drilledWorkflow.workflowKey,
    });
  }, [drilledWorkflow, vscode]);

  // A lineage delete may target the workflow currently on screen (deleting
  // from the recent-workflows dropdown or the header's own context menu while
  // it's the active view). REMOVE_WORKFLOW_HISTORY hard-deletes the backing
  // files immediately, so record it here rather than waiting on any reply —
  // there isn't one to wait for.
  const markIfViewingDeletedLineage = useCallback(
    (workflowKey: WorkflowKey) => {
      if (workflowKey !== displayedViewAddress?.workflowKey) return;
      setViewingDeletedWorkflow({ workflowKey, workflowName: displayName });
    },
    [displayName, displayedViewAddress, setViewingDeletedWorkflow]
  );

  // Clear workflow history
  const handleClearHistory = useCallback(() => {
    if (!globalSettings.confirmDeleteOperations) {
      vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW_HISTORY });
      if (displayedViewAddress) {
        markIfViewingDeletedLineage(displayedViewAddress.workflowKey);
      }
      setRecentWorkflows([]);
      closeDropdown();
      return;
    }
    setPendingDelete({ scope: "all" });
  }, [
    closeDropdown,
    displayedViewAddress,
    globalSettings.confirmDeleteOperations,
    markIfViewingDeletedLineage,
    setRecentWorkflows,
    vscode,
  ]);

  // Remove a single entry from recent workflow history — shows confirm modal or deletes directly
  const handleRemoveWorkflow = useCallback(
    (address: WorkflowViewAddress) => {
      if (!globalSettings.confirmDeleteOperations) {
        // Skip modal — user opted out of delete confirmation
        vscode.postMessage({
          type: MESSAGE_TYPES.REMOVE_WORKFLOW_HISTORY,
          address,
        });
        markIfViewingDeletedLineage(address.workflowKey);
        setRecentWorkflows(
          useUiStore
            .getState()
            .recentWorkflows.filter(
              (w) => w.address.workflowKey !== address.workflowKey
            )
        );
        return;
      }
      // Show confirmation modal
      setPendingDelete({ address, scope: "lineage" });
    },
    [
      globalSettings.confirmDeleteOperations,
      markIfViewingDeletedLineage,
      setRecentWorkflows,
      vscode,
    ]
  );

  // Confirmed: actually remove the workflow history entry
  const handleRemoveWorkflowConfirm = useCallback(() => {
    if (!pendingDelete) return;
    switch (pendingDelete.scope) {
      case "run":
        vscode.postMessage({
          type: MESSAGE_TYPES.DELETE_RUN_HISTORY,
          address: pendingDelete.address,
        });
        break;
      case "lineage":
        vscode.postMessage({
          type: MESSAGE_TYPES.REMOVE_WORKFLOW_HISTORY,
          address: pendingDelete.address,
        });
        markIfViewingDeletedLineage(pendingDelete.address.workflowKey);
        setRecentWorkflows(
          useUiStore
            .getState()
            .recentWorkflows.filter(
              (w) => w.address.workflowKey !== pendingDelete.address.workflowKey
            )
        );
        break;
      case "all":
        vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW_HISTORY });
        if (displayedViewAddress) {
          markIfViewingDeletedLineage(displayedViewAddress.workflowKey);
        }
        setRecentWorkflows([]);
        closeDropdown();
        break;
      default:
        assertNever(pendingDelete);
    }
    setPendingDelete(null);
  }, [
    closeDropdown,
    displayedViewAddress,
    markIfViewingDeletedLineage,
    pendingDelete,
    setRecentWorkflows,
    vscode,
  ]);

  const handleRemoveWorkflowCancel = useCallback(() => {
    setPendingDelete(null);
  }, []);

  const handleToggleFavorite = useCallback(
    (address: WorkflowViewAddress) => {
      vscode.postMessage({
        type: MESSAGE_TYPES.TOGGLE_WORKFLOW_FAVORITE,
        address,
      });

      setRecentWorkflows(
        sortRecentWorkflows(
          useUiStore.getState().recentWorkflows.map((workflow) =>
            workflow.address.workflowKey === address.workflowKey
              ? {
                  ...workflow,
                  isFavorite: !(workflow.isFavorite ?? false),
                }
              : workflow
          )
        )
      );
    },
    [setRecentWorkflows, vscode]
  );

  const handleWorkflowContextMenuDelete = useCallback(
    (target: WorkflowContextMenuTarget) => {
      if (target.scope === "lineage") {
        handleRemoveWorkflow(target.address);
        return;
      }
      if (target.address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
        handleDeleteRunPanelRow(target.address.runRef, true);
      }
    },
    [handleDeleteRunPanelRow, handleRemoveWorkflow]
  );

  const handleDuplicateWorkflow = useCallback(
    (target: WorkflowContextMenuTarget, opener: HTMLElement | null) => {
      openDuplicateWorkflowDialog(
        {
          source: target.address,
          workflowName: target.workflowName,
        },
        opener
      );
    },
    [openDuplicateWorkflowDialog]
  );

  const {
    openContextMenu: openWorkflowContextMenu,
    workflowContextMenuPortal,
  } = useWorkflowContextMenu({
    onDuplicate: handleDuplicateWorkflow,
    onToggleFavorite: handleToggleFavorite,
    onDelete: handleWorkflowContextMenuDelete,
    onCloseDropdown: closeDropdown,
  });

  const openDisplayedWorkflowContextMenu = useCallback(
    (x: number, y: number, opener: HTMLElement | null = null) => {
      if (!displayedViewAddress) return;
      const displayedLineage = recentWorkflows.find(
        (workflow) =>
          workflow.address.workflowKey === displayedViewAddress.workflowKey
      );
      openWorkflowContextMenu(
        x,
        y,
        {
          address: displayedViewAddress,
          workflowName: displayName,
          scope: "lineage",
          isFavorite: displayedLineage?.isFavorite,
          runDirectory: displayedRunDirectory ?? undefined,
          isExecuting: isWorkflowActive(executionState),
        },
        opener
      );
    },
    [
      displayName,
      displayedRunDirectory,
      displayedViewAddress,
      executionState,
      openWorkflowContextMenu,
      recentWorkflows,
    ]
  );

  const workflowLongPressHandlers = useLongPress(
    openDisplayedWorkflowContextMenu
  );
  const handleWorkflowContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      openDisplayedWorkflowContextMenu(
        event.clientX,
        event.clientY,
        getContextMenuOpener(event.currentTarget, event.target)
      );
    },
    [openDisplayedWorkflowContextMenu]
  );

  // Runtime actions target the stable run address, never an instance UUID.
  const handlePauseWorkflow = useCallback(
    (workflow: (typeof loadedWorkflows)[number]) => {
      if (!workflow.workflowKey || !workflow.runRef) return;
      sendMessage(MESSAGE_TYPES.PAUSE_RUN, {
        address: {
          workflowKey: workflow.workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: workflow.runRef,
        },
      });
    },
    []
  );

  const handleCancelPauseWorkflow = useCallback(
    (workflow: (typeof loadedWorkflows)[number]) => {
      if (!workflow.workflowKey || !workflow.runRef) return;
      sendMessage(MESSAGE_TYPES.CANCEL_PAUSE_RUN, {
        address: {
          workflowKey: workflow.workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: workflow.runRef,
        },
      });
    },
    []
  );

  const handleResumeWorkflow = useCallback(
    (workflow: (typeof loadedWorkflows)[number]) => {
      if (!workflow.workflowKey || !workflow.runRef) return;
      sendMessage(MESSAGE_TYPES.RESUME_RUN, {
        address: {
          workflowKey: workflow.workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: workflow.runRef,
        },
      });
    },
    []
  );

  const handleStopWorkflow = useCallback(
    (workflow: (typeof loadedWorkflows)[number]) => {
      if (!workflow.workflowKey || !workflow.runRef) return;
      sendMessage(MESSAGE_TYPES.STOP_RUN, {
        address: {
          workflowKey: workflow.workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: workflow.runRef,
        },
      });
    },
    []
  );

  // Single flag drives opacity, clip-path, and visible/pointer-events together —
  // splitting these across separate conditions previously let the opacity class
  // go stale during close (it never changed, so the transitionend listener that
  // finalizes the close never fired, wedging the dropdown permanently "closing").
  const dropdownRevealed = isDropdownOpen && !isDropdownClosing && !isEditing;

  const normalizedWorkflowSearch = workflowSearch.trim().toLowerCase();
  const isFilteringWorkflows =
    normalizedWorkflowSearch.length > 0 || filtersActive;
  const workflowDateStartMs = getDateStartMs(workflowDateFilter.from);
  const workflowDateEndMs = getDateEndMs(workflowDateFilter.to);
  const workflowMatchesSearch = (
    workflow: Pick<
      RecentWorkflow,
      | "workflowName"
      | "executionState"
      | "harness"
      | "lastModifiedAt"
      | "startedAt"
      | "isFavorite"
    > & {
      workflowKey?: string;
      filePath?: string;
      workingFilePath?: string;
      completedAt?: number;
    }
  ) => {
    const isFavorite =
      workflow.isFavorite ??
      sortedRecentWorkflows.some(
        (recentWorkflow) =>
          recentWorkflow.address.workflowKey === workflow.workflowKey &&
          (recentWorkflow.isFavorite ?? false)
      );

    if (
      (favoriteWorkflowsOnly && !isFavorite) ||
      !selectedWorkflowStates.includes(workflow.executionState) ||
      (workflow.harness
        ? !selectedWorkflowHarnesses.includes(workflow.harness)
        : selectedWorkflowHarnesses.length !== ALL_WORKFLOW_HARNESSES.length)
    ) {
      return false;
    }

    const workflowTimestamp =
      workflow.lastModifiedAt ?? workflow.startedAt ?? workflow.completedAt;
    if (
      (workflowDateStartMs !== null || workflowDateEndMs !== null) &&
      workflowTimestamp === undefined
    ) {
      return false;
    }

    if (
      workflowTimestamp !== undefined &&
      workflowDateStartMs !== null &&
      workflowTimestamp < workflowDateStartMs
    ) {
      return false;
    }

    if (
      workflowTimestamp !== undefined &&
      workflowDateEndMs !== null &&
      workflowTimestamp > workflowDateEndMs
    ) {
      return false;
    }

    if (!normalizedWorkflowSearch) return true;

    return [
      workflow.workflowName,
      workflow.workflowKey,
      workflow.workingFilePath,
      workflow.executionState,
    ].some((value) => value?.toLowerCase().includes(normalizedWorkflowSearch));
  };

  const filteredRunningWorkflows = runningSectionWorkflows.filter(
    workflowMatchesSearch
  );
  const filteredRecentWorkflows = sortedRecentWorkflows.filter(
    (recentWorkflow) =>
      workflowMatchesSearch(recentWorkflow) &&
      !runningSectionWorkflowKeys.has(recentWorkflow.address.workflowKey)
  );
  // One lineage-keyed row per entry, running lineages first — this is the
  // unified navigation model step 0 of the run-navigation plan calls for:
  // running state is a property of a row, not a separate section, and a
  // lineage never appears twice (filteredRecentWorkflows already excludes
  // whatever is represented by a running row above — and only those, so a
  // loaded-but-not-running lineage keeps its recent row rather than vanishing).
  const workflowListRows: UnifiedWorkflowRow[] = [
    ...filteredRunningWorkflows.map(
      (workflow): UnifiedWorkflowRow => ({
        kind: "running",
        key: `running:${workflow.workflowKey ?? workflow.id}`,
        workflow,
        // The lineage's recent entry is excluded from the recent rows below
        // while it is running, but it is still the only source of the run
        // metadata the row's drill affordance needs.
        lineage: sortedRecentWorkflows.find(
          (recentWorkflow) =>
            recentWorkflow.address.workflowKey === workflow.workflowKey
        ),
      })
    ),
    ...filteredRecentWorkflows.map(
      (workflow): UnifiedWorkflowRow => ({
        kind: "recent",
        key: `recent:${workflow.address.workflowKey}`,
        workflow,
      })
    ),
  ];

  // ── Run panel (drill-in view) derived data ──────────────────────────────
  const isDrilledLineageDisplayed =
    drilledWorkflow?.workflowKey === displayedViewAddress?.workflowKey;
  const drilledRecentEntry = drilledWorkflow
    ? recentWorkflows.find(
        (w) => w.address.workflowKey === drilledWorkflow.workflowKey
      )
    : undefined;
  const cachedRunSummaries = useRunSummaryCacheStore((s) =>
    drilledWorkflow ? s.entries[drilledWorkflow.workflowKey] : undefined
  );
  const runPanelSummaries = isDrilledLineageDisplayed
    ? runSummaries
    : (cachedRunSummaries?.runSummaries ?? []);
  const runPanelHasDraft =
    drilledRecentEntry?.runNav?.hasDraft ??
    (isDrilledLineageDisplayed &&
      displayedViewAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT);
  const runPanelRows: RunPanelRow[] = drilledWorkflow
    ? [
        ...(runPanelHasDraft ? [{ kind: "draft" as const }] : []),
        ...runPanelSummaries.map((summary) => ({
          kind: "run" as const,
          summary,
        })),
      ]
    : [];
  const runPanelIsLoading = drilledWorkflow
    ? isDrilledLineageDisplayed
      ? false
      : !cachedRunSummaries || cachedRunSummaries.status === "loading"
    : false;
  const runPanelLoadError = isDrilledLineageDisplayed
    ? undefined
    : cachedRunSummaries?.status === "error"
      ? (cachedRunSummaries.error ?? "Failed to load runs")
      : undefined;
  const runPanelExecutionRunRef = isDrilledLineageDisplayed
    ? executionRunRef
    : (cachedRunSummaries?.executionRunRef ?? null);
  // The viewed run scrolls into view only for the displayed lineage's own
  // panel (opened via the badge) — drilling into another lineage has no
  // "already viewed" row to seek to.
  const runPanelScrollToKey =
    drilledWorkflow && isDrilledLineageDisplayed && displayedViewAddress
      ? displayedViewAddress.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT
        ? `draft:${drilledWorkflow.workflowKey}`
        : `run:${drilledWorkflow.workflowKey}:${displayedViewAddress.runRef}`
      : null;

  // Badge visibility: the same drillable rule as the list's run indicator,
  // resolved from the displayed lineage's own recent-workflow entry when
  // known, falling back to the live run-summary count for a lineage not yet
  // reflected in the recent list (e.g. a workflow just created this session).
  const displayedRunNav = recentWorkflows.find(
    (w) => w.address.workflowKey === displayedViewAddress?.workflowKey
  )?.runNav;
  const isDisplayedLineageDrillable = displayedRunNav
    ? isDrillableRunNav(displayedRunNav)
    : runSummaries.length > 1;

  const workflowFilterControls = (
    <div className="flex min-w-0 items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-start gap-2">
        <div className="flex-shrink-0 text-xs text-description-fg">
          <MultiCheckboxDropdown
            id="workflow-state-filter"
            selectedValues={selectedWorkflowStates}
            onChange={setSelectedWorkflowStates}
            options={WORKFLOW_STATE_OPTIONS}
            placeholder="No States"
            buttonLabel={formatMultiFilterLabel(
              selectedWorkflowStates,
              ALL_WORKFLOW_STATES,
              "States",
              WORKFLOW_STATE_OPTIONS
            )}
            className="w-fit min-w-[96px]"
            dropdownMaxHeight="260px"
          />
        </div>

        <div className="flex-shrink-0 text-xs text-description-fg">
          <MultiCheckboxDropdown
            id="workflow-harness-filter"
            selectedValues={selectedWorkflowHarnesses}
            onChange={setSelectedWorkflowHarnesses}
            options={WORKFLOW_HARNESS_OPTIONS}
            placeholder="No Harnesses"
            buttonLabel={formatMultiFilterLabel(
              selectedWorkflowHarnesses,
              ALL_WORKFLOW_HARNESSES,
              "Harnesses",
              WORKFLOW_HARNESS_OPTIONS
            )}
            className="w-fit min-w-[116px]"
            dropdownMaxHeight="260px"
            dropdownMinWidth={170}
          />
        </div>

        <DateRangeFilterControls
          value={workflowDateFilter}
          onChange={setWorkflowDateFilter}
        />

        <button
          type="button"
          onClick={() => setFavoriteWorkflowsOnly((only) => !only)}
          title="Favorites only"
          aria-label="Favorites only"
          aria-pressed={favoriteWorkflowsOnly}
          className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded border transition-colors ${
            favoriteWorkflowsOnly
              ? "border-focus-border bg-btn-bg text-favorite"
              : "border-btn-border bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
          }`}
        >
          <i
            className={`codicon ${favoriteWorkflowsOnly ? "codicon-star-full" : "codicon-star-empty"} text-xs`}
          />
        </button>
      </div>

      <button
        type="button"
        onClick={resetWorkflowFilters}
        disabled={!filtersActive}
        title="Clear workflow filters"
        aria-label="Clear workflow filters"
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded border border-btn-border bg-btn-secondary-bg text-btn-secondary-fg transition-colors hover:bg-btn-secondary-hover disabled:cursor-default disabled:opacity-50 disabled:hover:bg-btn-secondary-bg"
      >
        <i className="codicon codicon-clear-all text-xxs" />
      </button>
    </div>
  );

  return (
    <div
      ref={mergedContainerRef}
      className={`workflow-status relative min-w-0 ${className}`}
    >
      {/* Editing Mode */}
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          aria-label="Edit workflow name"
          placeholder="Name your workflow..."
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={saveEdit}
          className="workflow-name-edit-input w-full px-2 py-1 text-sm font-semibold bg-input-bg text-input-fg border border-focus-border rounded outline-none"
          style={{
            boxShadow: "0 0 0 1px var(--vscode-focusBorder)",
          }}
        />
      ) : (
        /* Display Mode - Split Button Style */
        /* eslint-disable-next-line jsx-a11y/no-static-element-interactions */
        <div
          {...workflowLongPressHandlers}
          onContextMenu={handleWorkflowContextMenu}
          className={`workflow-split-button flex border rounded-button overflow-hidden max-w-full sm:max-w-[500px] lg:max-w-none w-full min-w-0 transition-colors ${wfStatusSize.container} ${isDropdownOpen ? "border-cmd-active-border" : "border-cmd-border"}`}
        >
          {/* Main Button - Workflow Name */}
          <button
            type="button"
            onClick={startEditing}
            className={`workflow-button-main fp-dropdown-row flex-1 min-w-0 text-left overflow-hidden cursor-pointer transition-colors ${wfStatusSize.mainButton} bg-cmd-bg text-cmd-fg hover:bg-cmd-active-bg hover:text-cmd-active-fg`}
            title="Click to edit workflow name"
          >
            <div className="flex items-center justify-between gap-2 overflow-hidden">
              {/* Workflow Name */}
              <span className="font-semibold text-sm truncate flex-1 min-w-0">
                {displayName}
              </span>

              {/* External runner badge */}
              {isExternallyManaged && (
                <span
                  className="text-xs px-1.5 py-px rounded uppercase font-semibold flex-shrink-0 bg-btn-bg text-btn-fg border border-btn-border"
                  title={
                    activeManagedBy === RUNNER_IDS.CLI
                      ? "Workflow is being managed by the ctrlyoke CLI"
                      : "Workflow is being managed by another ctrlyoke window"
                  }
                >
                  {activeManagedBy === RUNNER_IDS.CLI ? "CLI" : "VS Code"}
                </span>
              )}

              {!isNarrow && currentWorkflowHasActiveTerminal && (
                <span
                  className="flex-shrink-0 w-4 flex items-center justify-center text-description-fg"
                  title="Terminal session is still running"
                  aria-label="Terminal session is still running"
                >
                  <i className="codicon codicon-terminal text-sm" />
                </span>
              )}

              {!isNarrow && worktreeIndicator && (
                <span
                  className="flex-shrink-0 w-4 flex items-center justify-center text-description-fg"
                  title={worktreeIndicator.title}
                  aria-label={worktreeIndicator.title}
                >
                  <i className="codicon codicon-source-control text-sm" />
                </span>
              )}

              {/* Execution State */}
              {executionState && executionState !== EXECUTION_STATES.IDLE && (
                <ExecutionStateBadge
                  state={executionState}
                  isNarrow={isNarrow}
                  className="flex-shrink-0"
                />
              )}
            </div>
          </button>

          {/* Run identity badge — third segment, only when the displayed
              lineage has more than one addressable target. A single-run
              lineage with no draft keeps exactly today's two-segment header. */}
          {isDisplayedLineageDrillable && displayedViewAddress && (
            <>
              <div
                className={`bg-cmd-bg text-cmd-fg ${wfStatusSize.separatorPy} flex-shrink-0`}
              >
                <div className="w-px h-full bg-current opacity-40" />
              </div>
              <RunIdentityBadge
                label={viewedRunLabel(
                  displayedViewAddress,
                  runSummaries,
                  isNarrow
                )}
                accessibleLabel={`${viewedRunLabel(displayedViewAddress, runSummaries, false)} — browse runs of ${displayName}`}
                isActive={
                  isDropdownOpen &&
                  !isDropdownClosing &&
                  dropdownView === "runs" &&
                  drilledWorkflow?.workflowKey ===
                    displayedViewAddress.workflowKey
                }
                sizeClassName={wfStatusSize.triggerButton}
                onClick={(event) => {
                  dropdownOpenerRef.current = event.currentTarget;
                  handleOpenDisplayedRunPanel();
                }}
              />
            </>
          )}

          {/* Separator — mirrors VS Code's monaco-button-dropdown-separator */}
          <div
            className={`bg-cmd-bg text-cmd-fg ${wfStatusSize.separatorPy} flex-shrink-0`}
          >
            <div className="w-px h-full bg-current opacity-40" />
          </div>

          {/* Dropdown Trigger */}
          <button
            type="button"
            onClick={(event) => {
              dropdownOpenerRef.current = event.currentTarget;
              toggleDropdown();
            }}
            aria-label="Show recent workflows"
            aria-haspopup="listbox"
            aria-expanded={isDropdownOpen}
            title="Show recent workflows"
            className={`workflow-button-dropdown fp-dropdown-row ${wfStatusSize.triggerButton} bg-cmd-bg text-cmd-fg flex items-center justify-center gap-1 transition-colors hover:bg-cmd-active-bg hover:text-cmd-active-fg ${isDropdownOpen ? "bg-cmd-active-bg text-cmd-active-fg fp-dropdown-row-selected" : ""}`}
          >
            {/* Pulsing dot: another loaded workflow is running */}
            {effectiveLoadedWorkflows.some(
              (w) =>
                isWorkflowRunning(w.executionState) && w.id !== activeWorkflowId
            ) && (
              <span
                className="inline-block w-2 h-2 rounded-full bg-indicator-success animate-pulse"
                title="Another workflow is running"
              />
            )}
            {recentWorkflows.length > 0 && (
              <span className="workflow-count-badge hidden sm:inline-block text-xxs font-semibold bg-badge-bg text-badge-fg rounded-full px-1.5 py-0.5 min-w-[16px] text-center">
                {recentWorkflows.length}
              </span>
            )}
            <svg
              className="w-3 h-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        </div>
      )}

      {/* Dropdown Menu */}
      <div
        ref={mergedDropdownRef}
        onTransitionEnd={handleDropdownTransitionEnd}
        className={`workflow-dropdown-menu select-none [-webkit-touch-callout:none] fixed left-0 right-0 w-screen sm:right-auto bg-dropdown-bg border-x-0 sm:border-x border-t-0 border-b border-dropdown-border sm:rounded-b shadow-lg z-panel overflow-clip flex flex-col transition-[opacity,clip-path,visibility] ${dropdownRevealed ? "duration-[250ms] ease-out opacity-100 visible" : "duration-[220ms] ease-in opacity-0 invisible pointer-events-none"}`}
        style={{
          top: dropdownTop,
          left: !isMobile && dropdownWidth !== null ? dropdownLeft : undefined,
          width:
            !isMobile && dropdownWidth !== null ? dropdownWidth : undefined,
          bottom: 0,
          clipPath: dropdownRevealed ? "inset(0 0 0 0)" : "inset(0 0 100% 0)",
        }}
      >
        {/* The workflow list stays mounted as the run panel's underlying
            surface. A row drill-in slides the run panel over it like a drawer,
            so neither direction leaves a blank dropdown frame. */}
        <div className="relative flex flex-1 min-h-0 flex-col overflow-clip">
          <div
            className={`flex h-full min-h-0 flex-col ${
              dropdownView === "runs" ? "pointer-events-none" : ""
            }`}
            aria-hidden={dropdownView === "runs"}
          >
            <WorkflowList
              rows={workflowListRows}
              currentAddress={displayedViewAddress}
              activeWorkflowId={activeWorkflowId}
              runningHasActiveTerminal={workflowHasActiveTerminal}
              recentHasActiveTerminal={recentWorkflowHasActiveTerminal}
              onSelectRecent={handleSelectWorkflow}
              onSwitchRunning={handleSwitchWorkflow}
              onPauseRunning={handlePauseWorkflow}
              onCancelPauseRunning={handleCancelPauseWorkflow}
              onResumeRunning={handleResumeWorkflow}
              onStopRunning={handleStopWorkflow}
              onClearHistory={handleClearHistory}
              onRemove={handleRemoveWorkflow}
              onToggleFavorite={handleToggleFavorite}
              onOpenContextMenu={openWorkflowContextMenu}
              onDrillIntoRuns={handleDrillIntoRuns}
              tier={dropdownRowTier}
              onClose={closeDropdown}
              searchValue={workflowSearch}
              onSearchChange={setWorkflowSearch}
              filtersOpen={filtersOpen}
              filtersActive={filtersActive}
              onToggleFilters={handleToggleFilters}
              filterControls={workflowFilterControls}
              isFiltering={isFilteringWorkflows}
              onNewWorkflow={() => {
                setActiveWorkflowWorkingFilePath(null);
                setEditValue("");
                setIsEditing(true);
                vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW });
                closeDropdown();
              }}
            />
          </div>
          {dropdownView === "runs" && drilledWorkflow ? (
            <div
              className={`absolute inset-0 flex min-h-0 flex-col bg-dropdown-bg ${
                isRunPanelLeaving
                  ? "pointer-events-none animate-slide-out-right"
                  : shouldAnimateRunPanelEntry
                    ? "animate-slide-in-right"
                    : ""
              }`}
              aria-hidden={isRunPanelLeaving}
              onAnimationEnd={handleRunPanelAnimationEnd}
            >
              <RunPanel
                workflowKey={drilledWorkflow.workflowKey}
                workflowName={drilledWorkflow.workflowName}
                rows={runPanelRows}
                isLoading={runPanelIsLoading}
                loadError={runPanelLoadError}
                tier={dropdownRowTier}
                displayedAddress={displayedViewAddress}
                isViewingHistory={isViewingHistory}
                executionRunRef={runPanelExecutionRunRef}
                isFavorite={drilledRecentEntry?.isFavorite}
                draftDirectory={drilledRecentEntry?.runNav?.draftDirectory}
                confirmDeleteOperations={globalSettings.confirmDeleteOperations}
                onBack={handleBackToWorkflowList}
                onClose={closeDropdown}
                onSelectRow={handleSelectRunPanelRow}
                onOpenContextMenu={openWorkflowContextMenu}
                onDeleteRun={handleDeleteRunPanelRow}
                onDeleteAllRuns={handleDeleteAllRunsInPanel}
                scrollToKey={runPanelScrollToKey}
              />
            </div>
          ) : null}
        </div>
      </div>

      {/* Delete workflow history confirmation modal */}
      {workflowContextMenuPortal}
      <DeleteConfirmModal
        isOpen={pendingDelete !== null}
        onCancel={handleRemoveWorkflowCancel}
        onConfirm={handleRemoveWorkflowConfirm}
        title={
          pendingDelete?.scope === "all"
            ? "Delete All Workflow History"
            : pendingDelete?.scope === "run"
              ? "Delete Run History"
              : "Delete Workflow History"
        }
        message={
          pendingDelete?.scope === "all"
            ? "Delete all workflows and their run history?"
            : pendingDelete?.scope === "run"
              ? `Delete run "${pendingDelete.address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN ? pendingDelete.address.runRef : ""}"?`
              : `Remove "${pendingDelete?.address.workflowKey ?? ""}" from history?`
        }
        detail={
          pendingDelete?.scope === "all"
            ? "This will permanently delete all workflow queue files and run history. This action cannot be undone."
            : pendingDelete?.scope === "run"
              ? "This will permanently delete this run's history. This action cannot be undone."
              : "This will permanently delete the workflow's queue files and all run history. This action cannot be undone."
        }
      />
    </div>
  );
};

/**
 * Extract workflow name from file path
 */
function getWorkflowNameFromPath(filePath: string): string {
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  // Source prompt files may use any supported extension; run-scoped workflow
  // definitions always derive their display name from the lineage descriptor.
  return fileName
    .replace(/\.ctrlyoke\.(yaml|yml|json)$/i, "")
    .replace(/\.(yaml|yml|json)$/i, "");
}
