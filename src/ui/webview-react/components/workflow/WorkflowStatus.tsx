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
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  RUNNER_IDS,
  HARNESS_IDS,
  HARNESS_INFO,
  TERMINAL_SESSION_STATUS,
  type ExecutionState,
} from "../../types/messages";
import { DEFAULT_WORKFLOW_NAME } from "@root/types/DashboardConstants";
import { WorkflowList, type UnifiedWorkflowRow } from "./WorkflowList";
import { areWorkflowAddressesEqual } from "@utils/viewAddress";
import { postWorkflowDefinitionMutation } from "../../utils/workflowMutation";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import { DeleteConfirmModal } from "../shared/DeleteConfirmModal";
import { MultiCheckboxDropdown } from "../shared/MultiCheckboxDropdown";
import {
  getExecutionStateBadgeClass,
  getExecutionStateBadgeIcon,
  isWorkflowActive,
  isWorkflowRunning,
} from "../../utils/status";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import { useIsMobile } from "@hooks/useMediaQuery";
import { WebviewLog } from "@utils/logger";
import { WORKFLOW_STATUS_BUTTON_SIZES } from "../../constants";

interface WorkflowStatusProps {
  className?: string;
}

const ALL_WORKFLOW_STATES = Object.values(EXECUTION_STATES);
const ALL_WORKFLOW_HARNESSES = Object.values(HARNESS_IDS);
const WORKFLOW_ROW_SELECTOR = ".running-workflow-item, .workflow-menu-item";
const WORKFLOW_ROW_WIDTH_CSS_VAR = "--workflow-row-usable-width";

const WORKFLOW_STATE_OPTIONS = ALL_WORKFLOW_STATES.map((state) => ({
  value: state,
  label: state,
}));

const WORKFLOW_HARNESS_OPTIONS = ALL_WORKFLOW_HARNESSES.map((harness) => ({
  value: harness,
  label: HARNESS_INFO[harness].name,
}));

type WorkflowDatePreset = "all" | "last7" | "last30" | "lastMonth" | "custom";

interface WorkflowDateFilter {
  preset: WorkflowDatePreset;
  from: string;
  to: string;
}

const DEFAULT_WORKFLOW_DATE_FILTER: WorkflowDateFilter = {
  preset: "all",
  from: "",
  to: "",
};

const DATE_INPUT_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

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

function formatDateInput(timestamp: number): string {
  return DATE_INPUT_FORMATTER.format(new Date(timestamp));
}

function getDatePresetRange(
  preset: Exclude<WorkflowDatePreset, "all" | "custom">
): Pick<WorkflowDateFilter, "from" | "to"> {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (preset === "lastMonth") {
    const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const to = new Date(today.getFullYear(), today.getMonth(), 0);
    return {
      from: formatDateInput(from.getTime()),
      to: formatDateInput(to.getTime()),
    };
  }

  const days = preset === "last7" ? 6 : 29;
  const from = new Date(today);
  from.setDate(today.getDate() - days);

  return {
    from: formatDateInput(from.getTime()),
    to: formatDateInput(today.getTime()),
  };
}

function getDateStartMs(date: string): number | null {
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00`);
  const time = parsed.getTime();
  return Number.isNaN(time) ? null : time;
}

function getDateEndMs(date: string): number | null {
  if (!date) return null;
  const parsed = new Date(`${date}T23:59:59.999`);
  const time = parsed.getTime();
  return Number.isNaN(time) ? null : time;
}

function formatMultiFilterLabel(
  selectedValues: string[],
  allValues: string[],
  pluralLabel: string,
  options: Array<{ value: string; label: string }>
): string {
  if (selectedValues.length === allValues.length) {
    return `All ${pluralLabel}`;
  }

  if (selectedValues.length === 1) {
    return (
      options.find((option) => option.value === selectedValues[0])?.label ??
      selectedValues[0]
    );
  }

  return `${selectedValues.length} ${pluralLabel}`;
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
    activeWorkflowId,
    activeWorkflowWorkingFilePath,
    displayedViewAddress,
    pendingRunViewSwitch,
    recentWorkflows,
    setRecentWorkflows,
    setActiveWorkflowWorkingFilePath,
  } = useUiStore();
  const { globalSettings } = useSettingsStore();
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

  const isCLIManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy ===
    RUNNER_IDS.CLI;
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
            workflowKey: undefined,
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

  const recentWorkflowHasActiveTerminal = useCallback(
    (workflow: RecentWorkflow) =>
      (workflow.address.kind === "run" &&
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
  const [workflowDateFilter, setWorkflowDateFilter] =
    useState<WorkflowDateFilter>(DEFAULT_WORKFLOW_DATE_FILTER);
  const [favoriteWorkflowsOnly, setFavoriteWorkflowsOnly] = useState(false);
  // Pending workflow path waiting for delete confirmation
  const [pendingDeleteAddress, setPendingDeleteAddress] =
    useState<WorkflowViewAddress | null>(null);
  const sortedRecentWorkflows = useMemo(
    () => sortRecentWorkflows(recentWorkflows),
    [recentWorkflows]
  );

  const isMobile = useIsMobile();
  const wfStatusSize = isMobile
    ? WORKFLOW_STATUS_BUTTON_SIZES.touch
    : WORKFLOW_STATUS_BUTTON_SIZES.default;
  const [narrowRef, isNarrow] = useElementNarrow<HTMLDivElement>(300);

  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const mergedContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      narrowRef(node);
    },
    [narrowRef]
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
    const desktopDropdownWidth = Math.min(500, window.innerWidth);
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
    const scrollContainer = dropdown?.querySelector(".workflow-menu-items");
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
  }, []);

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
    const scrollContainer = dropdown.querySelector(".workflow-menu-items");
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
  }, [isDropdownOpen, syncWorkflowRowWidthLock]);

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
    setWorkflowSearch("");
  }, []);

  useEffect(() => {
    return () => {
      if (closeDropdownTimeoutRef.current) {
        clearTimeout(closeDropdownTimeoutRef.current);
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
    setWorkflowDateFilter(DEFAULT_WORKFLOW_DATE_FILTER);
    setFavoriteWorkflowsOnly(false);
  }, []);

  const handleToggleFilters = useCallback(() => {
    setFiltersOpen((open) => !open);
  }, []);

  const handleDatePresetChange = useCallback((preset: WorkflowDatePreset) => {
    if (preset === "all") {
      setWorkflowDateFilter(DEFAULT_WORKFLOW_DATE_FILTER);
      return;
    }

    if (preset === "custom") {
      setWorkflowDateFilter((current) => ({
        ...current,
        preset,
      }));
      return;
    }

    setWorkflowDateFilter({
      preset,
      ...getDatePresetRange(preset),
    });
  }, []);

  const handleDateBoundChange = useCallback(
    (bound: "from" | "to", value: string) => {
      setWorkflowDateFilter((current) => ({
        ...current,
        preset:
          value || current[bound === "from" ? "to" : "from"] ? "custom" : "all",
        [bound]: value,
      }));
    },
    []
  );

  // Request recent workflows once on mount so the count badge is visible immediately
  useEffect(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.GET_RECENT_WORKFLOWS });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      const isDropdownPortalClick =
        target instanceof Element && target.closest(".fp-dropdown-popup");
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
      return;
    }
    if (isDropdownClosing) {
      WebviewLog.debug(
        "[WorkflowStatus:toggleDropdown] ignored — still playing the close transition"
      );
      return;
    }
    closeDropdown();
  }, [
    isDropdownOpen,
    isDropdownClosing,
    vscode,
    loadedWorkflows,
    activeWorkflowId,
    fileName,
    syntheticActiveWorkflow,
    workflowName,
    updateDropdownTop,
    closeDropdown,
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
      if (areWorkflowAddressesEqual(address, displayedViewAddress)) {
        closeDropdown();
        return;
      }

      // Record a request ID before the asynchronous load so RUN_VIEW_LOADED can
      // discard responses from an older recent-workflow selection.
      const ui = useUiStore.getState();
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
      const requestId = ui.requestRunViewLoad(
        address,
        ui.runSummaries,
        ui.executionRunRef ?? undefined,
        // Names the pending switch so the header renames instantly and the
        // panel overlay can say what it is loading.
        selectedWorkflow?.workflowName
      );
      vscode.postMessage({
        type: MESSAGE_TYPES.LOAD_RUN_VIEW,
        address,
        requestId,
      });
      closeDropdown();
    },
    [closeDropdown, displayedViewAddress, recentWorkflows, vscode]
  );

  // Clear workflow history
  const handleClearHistory = useCallback(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW_HISTORY });
    setRecentWorkflows([]);
    closeDropdown();
  }, [closeDropdown, setRecentWorkflows, vscode]);

  // Remove a single entry from recent workflow history — shows confirm modal or deletes directly
  const handleRemoveWorkflow = useCallback(
    (address: WorkflowViewAddress) => {
      if (!globalSettings.confirmDeleteOperations) {
        // Skip modal — user opted out of delete confirmation
        vscode.postMessage({
          type: MESSAGE_TYPES.REMOVE_WORKFLOW_HISTORY,
          address,
        });
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
      setPendingDeleteAddress(address);
    },
    [globalSettings.confirmDeleteOperations, setRecentWorkflows, vscode]
  );

  // Confirmed: actually remove the workflow history entry
  const handleRemoveWorkflowConfirm = useCallback(() => {
    if (!pendingDeleteAddress) return;
    vscode.postMessage({
      type: MESSAGE_TYPES.REMOVE_WORKFLOW_HISTORY,
      address: pendingDeleteAddress,
    });
    setRecentWorkflows(
      useUiStore
        .getState()
        .recentWorkflows.filter(
          (w) => w.address.workflowKey !== pendingDeleteAddress.workflowKey
        )
    );
    setPendingDeleteAddress(null);
  }, [pendingDeleteAddress, setRecentWorkflows, vscode]);

  const handleRemoveWorkflowCancel = useCallback(() => {
    setPendingDeleteAddress(null);
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

  // Runtime actions target the stable run address, never an instance UUID.
  const handlePauseWorkflow = useCallback(
    (workflow: (typeof loadedWorkflows)[number]) => {
      if (!workflow.workflowKey || !workflow.runRef) return;
      vscode.postMessage({
        type: MESSAGE_TYPES.PAUSE_RUN,
        address: {
          workflowKey: workflow.workflowKey,
          kind: "run",
          runRef: workflow.runRef,
        },
      });
    },
    [vscode]
  );

  const handleCancelPauseWorkflow = useCallback(
    (workflow: (typeof loadedWorkflows)[number]) => {
      if (!workflow.workflowKey || !workflow.runRef) return;
      vscode.postMessage({
        type: MESSAGE_TYPES.CANCEL_PAUSE_RUN,
        address: {
          workflowKey: workflow.workflowKey,
          kind: "run",
          runRef: workflow.runRef,
        },
      });
    },
    [vscode]
  );

  const handleResumeWorkflow = useCallback(
    (workflow: (typeof loadedWorkflows)[number]) => {
      if (!workflow.workflowKey || !workflow.runRef) return;
      vscode.postMessage({
        type: MESSAGE_TYPES.RESUME_RUN,
        address: {
          workflowKey: workflow.workflowKey,
          kind: "run",
          runRef: workflow.runRef,
        },
      });
    },
    [vscode]
  );

  const handleStopWorkflow = useCallback(
    (workflow: (typeof loadedWorkflows)[number]) => {
      if (!workflow.workflowKey || !workflow.runRef) return;
      vscode.postMessage({
        type: MESSAGE_TYPES.STOP_RUN,
        address: {
          workflowKey: workflow.workflowKey,
          kind: "run",
          runRef: workflow.runRef,
        },
      });
    },
    [vscode]
  );

  // While a cross-lineage switch is in flight the workflow store still holds
  // the previous workflow's definition. Show the switch target immediately so
  // the click visibly took effect before the snapshot lands.
  const displayName =
    pendingRunViewSwitch?.workflowName ??
    (fileName
      ? workflowName || getWorkflowNameFromPath(fileName)
      : DEFAULT_WORKFLOW_NAME);

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

  const filteredEffectiveLoadedWorkflows = effectiveLoadedWorkflows.filter(
    workflowMatchesSearch
  );
  const filteredRecentWorkflows = sortedRecentWorkflows.filter(
    (recentWorkflow) =>
      workflowMatchesSearch(recentWorkflow) &&
      !effectiveLoadedWorkflows.some(
        (loadedWorkflow) =>
          loadedWorkflow.workflowKey === recentWorkflow.address.workflowKey
      )
  );
  // One lineage-keyed row per entry, running lineages first — this is the
  // unified navigation model step 0 of the run-navigation plan calls for:
  // running state is a property of a row, not a separate section, and a
  // lineage never appears twice (filteredRecentWorkflows already excludes
  // whatever is represented by a loaded/running workflow above).
  const workflowListRows: UnifiedWorkflowRow[] = [
    ...filteredEffectiveLoadedWorkflows.map(
      (workflow): UnifiedWorkflowRow => ({
        kind: "running",
        key: `running:${workflow.workflowKey ?? workflow.id}`,
        workflow,
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
  const workflowFilterControls = (
    <div className="flex min-w-0 items-start gap-2">
      <div className="flex min-w-0 flex-1 items-start gap-2 overflow-x-auto pb-0.5">
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
          />
        </div>

        <select
          aria-label="Workflow date preset"
          value={workflowDateFilter.preset}
          onChange={(event) =>
            handleDatePresetChange(event.target.value as WorkflowDatePreset)
          }
          className="h-7 min-w-[112px] flex-shrink-0 rounded border border-input-border bg-input-bg px-1.5 text-xs text-input-fg outline-none focus:border-focus-border"
        >
          <option value="all">Any time</option>
          <option value="last7">Last 7 days</option>
          <option value="last30">Last 30 days</option>
          <option value="lastMonth">Last month</option>
          <option value="custom">Custom range</option>
        </select>

        {workflowDateFilter.preset === "custom" && (
          <>
            <input
              type="date"
              aria-label="Workflow date from"
              value={workflowDateFilter.from}
              onChange={(event) =>
                handleDateBoundChange("from", event.target.value)
              }
              className="h-7 w-[128px] flex-shrink-0 rounded border border-input-border bg-input-bg px-1.5 text-xs text-input-fg outline-none focus:border-focus-border"
            />
            <input
              type="date"
              aria-label="Workflow date to"
              value={workflowDateFilter.to}
              onChange={(event) =>
                handleDateBoundChange("to", event.target.value)
              }
              className="h-7 w-[128px] flex-shrink-0 rounded border border-input-border bg-input-bg px-1.5 text-xs text-input-fg outline-none focus:border-focus-border"
            />
          </>
        )}

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
        <div
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

              {/* CLI Managed badge */}
              {isCLIManaged && (
                <span
                  className="text-xs px-1.5 py-px rounded uppercase font-semibold flex-shrink-0 bg-btn-bg text-btn-fg border border-btn-border"
                  title="Workflow is being managed by the ctrlyoke CLI"
                >
                  CLI
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

              {/* Execution State */}
              {executionState && executionState !== EXECUTION_STATES.IDLE && (
                <span
                  className={`text-xs px-1.5 py-px rounded uppercase font-semibold flex-shrink-0 ${getExecutionStateBadgeClass(executionState)}`}
                  title={isNarrow ? executionState : undefined}
                >
                  {isNarrow ? (
                    <i
                      className={`codicon ${getExecutionStateBadgeIcon(executionState)}`}
                    />
                  ) : (
                    executionState
                  )}
                </span>
              )}
            </div>
          </button>

          {/* Separator — mirrors VS Code's monaco-button-dropdown-separator */}
          <div
            className={`bg-cmd-bg text-cmd-fg ${wfStatusSize.separatorPy} flex-shrink-0`}
          >
            <div className="w-px h-full bg-current opacity-40" />
          </div>

          {/* Dropdown Trigger */}
          <button
            type="button"
            onClick={toggleDropdown}
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
        ref={dropdownRef}
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
        {/* Unified workflow list — one row per lineage, running lineages first */}
        <div className="flex-1 min-h-0 overflow-clip flex flex-col">
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
            isNarrow={isNarrow}
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
              vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW });
              closeDropdown();
            }}
          />
        </div>
      </div>

      {/* Delete workflow history confirmation modal */}
      <DeleteConfirmModal
        isOpen={pendingDeleteAddress !== null}
        onCancel={handleRemoveWorkflowCancel}
        onConfirm={handleRemoveWorkflowConfirm}
        title="Delete Workflow History"
        message={`Remove "${pendingDeleteAddress ? pendingDeleteAddress.workflowKey : ""}" from history?`}
        detail="This will permanently delete the workflow's queue files and all run history. This action cannot be undone."
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
