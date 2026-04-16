import React, { useState, useRef, useEffect, useCallback } from "react";
import { useWorkflowStore } from "../../store/workflowStore";
import { useUiStore } from "../../store/uiStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useTerminalStore } from "../../store/terminalStore";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  TERMINAL_SESSION_STATUS,
  RUNNER_IDS,
} from "../../types/messages";
import { DEFAULT_WORKFLOW_NAME } from "@root/types/DashboardConstants";
import { RecentWorkflows } from "./RecentWorkflows";
import { RunningWorkflowItem } from "./RunningWorkflowItem";
import { DeleteConfirmModal } from "../shared/DeleteConfirmModal";
import { getExecutionStateBadgeClass } from "../../utils/status";
import { WebviewLog } from "@utils/logger";

interface WorkflowStatusProps {
  className?: string;
}

interface RecentWorkflow {
  workflowName: string;
  filePath: string;
  executionState: string;
  lastModifiedAt?: number;
  startedAt?: number;
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
  const { fileName, workflowName, executionState } = useWorkflowStore();
  const {
    loadedWorkflows,
    activeWorkflowId,
    activeWorkflowWorkingFilePath,
    setActiveWorkflowWorkingFilePath,
  } = useUiStore();
  const { globalSettings } = useSettingsStore();
  const terminalSessionsByWorkflow = useTerminalStore((s) => s.sessions);

  const isCLIManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy ===
    RUNNER_IDS.CLI;
  const workflowHasActiveTerminal = useCallback(
    (workflowId: string | null | undefined) =>
      !!workflowId &&
      (terminalSessionsByWorkflow[workflowId] ?? []).some(
        (session) => session.status === TERMINAL_SESSION_STATUS.RUNNING
      ),
    [terminalSessionsByWorkflow]
  );
  const currentWorkflowHasActiveTerminal =
    workflowHasActiveTerminal(activeWorkflowId);

  // Accumulates filePath/workingFilePath → workflowId for every workflow that has
  // ever been in loadedWorkflows this session. Used by recentWorkflowHasActiveTerminal
  // to find terminal sessions for completed workflows (which are removed from
  // loadedWorkflows on completion but may still have active shell terminals).
  const seenWorkflowIdsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    for (const workflow of loadedWorkflows) {
      if (workflow.filePath) {
        seenWorkflowIdsRef.current.set(workflow.filePath, workflow.id);
      }
      if (workflow.workingFilePath) {
        seenWorkflowIdsRef.current.set(workflow.workingFilePath, workflow.id);
      }
    }
  }, [loadedWorkflows]);

  const recentWorkflowHasActiveTerminal = useCallback(
    (workflow: RecentWorkflow) => {
      // Case 1: workflow is still in loadedWorkflows (RUNNING/PAUSED)
      const loadedWorkflow = loadedWorkflows.find(
        (w) =>
          w.filePath === workflow.filePath ||
          w.workingFilePath === workflow.filePath
      );
      if (loadedWorkflow) {
        return workflowHasActiveTerminal(loadedWorkflow.id);
      }

      // Case 2: workflow completed/stopped and was previously in loadedWorkflows.
      // Its workflowId was recorded in seenWorkflowIdsRef while active — use it
      // to check for still-running terminal sessions (e.g. an open shell).
      const knownWorkflowId = seenWorkflowIdsRef.current.get(workflow.filePath);
      if (knownWorkflowId) {
        return workflowHasActiveTerminal(knownWorkflowId);
      }

      // Case 3: workflow is the currently active workflow (retired/completed on load,
      // so it never entered loadedWorkflows). Match by full working file path —
      // fileName from workflowStore is the basename only and won't match.
      if (
        workflow.filePath === activeWorkflowWorkingFilePath ||
        workflow.filePath === fileName
      ) {
        return workflowHasActiveTerminal(activeWorkflowId);
      }

      return false;
    },
    [
      activeWorkflowId,
      activeWorkflowWorkingFilePath,
      fileName,
      loadedWorkflows,
      workflowHasActiveTerminal,
    ]
  );

  // Local state
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [recentWorkflows, setRecentWorkflows] = useState<RecentWorkflow[]>([]);
  // Pending workflow path waiting for delete confirmation
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(
    null
  );

  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Request recent workflows once on mount so the count badge is visible immediately
  useEffect(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.GET_RECENT_WORKFLOWS });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle message from extension with recent workflows
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === MESSAGE_TYPES.RECENT_WORKFLOWS) {
        const workflows = message.workflows || [];
        WebviewLog.debug(
          `[WorkflowStatus:RECENT_WORKFLOWS] received ${workflows.length} recent workflows`
        );
        setRecentWorkflows(workflows);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsDropdownOpen(false);
      }
    };

    if (isDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isDropdownOpen]);

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
    setEditValue(workflowName || getWorkflowNameFromPath(fileName));
    setIsEditing(true);
  }, [fileName, workflowName]);

  // Save edited workflow name
  const saveEdit = useCallback(() => {
    const newName = editValue.trim();
    if (!newName) {
      setIsEditing(false);
      return;
    }

    const currentName = workflowName || getWorkflowNameFromPath(fileName || "");
    if (newName !== currentName) {
      vscode.postMessage({
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
      WebviewLog.debug(
        `[WorkflowStatus:toggleDropdown] opening dropdown — requesting workflows list. ` +
          `Current loadedWorkflows: [${loadedWorkflows.map((w) => `inst:${w.id.slice(0, 8)}(name="${w.workflowName || "(empty)"}", state=${w.executionState})`).join(", ") || "(none)"}], ` +
          `activeWorkflowId=inst:${activeWorkflowId?.slice(0, 8) ?? "null"}, ` +
          `current fileName="${fileName || "(none)"}", workflowName="${workflowName || "(none)"}"`
      );
      // Request recent workflows and full loaded-workflows list from extension
      vscode.postMessage({ type: MESSAGE_TYPES.GET_RECENT_WORKFLOWS });
      vscode.postMessage({ type: MESSAGE_TYPES.GET_WORKFLOWS_LIST });
    }
    setIsDropdownOpen(!isDropdownOpen);
  }, [
    isDropdownOpen,
    vscode,
    loadedWorkflows,
    activeWorkflowId,
    fileName,
    workflowName,
  ]);

  // Switch to a loaded workflow
  const handleSwitchWorkflow = useCallback(
    (workflowId: string) => {
      const workflow = loadedWorkflows.find((w) => w.id === workflowId);
      setActiveWorkflowWorkingFilePath(workflow?.workingFilePath ?? null);
      if (workflow?.executionState === EXECUTION_STATES.RUNNING) {
        useWorkflowStore.getState().clearHistoryOutputs();
        useUiStore.getState().clearHistoryView();
      }
      vscode.postMessage({
        type: MESSAGE_TYPES.SWITCH_WORKFLOW,
        workflowId,
      });
      setIsDropdownOpen(false);
    },
    [loadedWorkflows, setActiveWorkflowWorkingFilePath, vscode]
  );

  // Load workflow from recent list
  const handleSelectWorkflow = useCallback(
    (filePath: string) => {
      setActiveWorkflowWorkingFilePath(filePath);
      vscode.postMessage({
        type: MESSAGE_TYPES.LOAD_WORKFLOW,
        filePath,
      });
      setIsDropdownOpen(false);
    },
    [setActiveWorkflowWorkingFilePath, vscode]
  );

  // Clear workflow history
  const handleClearHistory = useCallback(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW_HISTORY });
    setRecentWorkflows([]);
    setIsDropdownOpen(false);
  }, [vscode]);

  // Remove a single entry from recent workflow history — shows confirm modal or deletes directly
  const handleRemoveWorkflow = useCallback(
    (filePath: string) => {
      if (!globalSettings.confirmDeleteOperations) {
        // Skip modal — user opted out of delete confirmation
        vscode.postMessage({
          type: MESSAGE_TYPES.REMOVE_WORKFLOW_HISTORY,
          filePath,
        });
        setRecentWorkflows((prev) =>
          prev.filter((w) => w.filePath !== filePath)
        );
        return;
      }
      // Show confirmation modal
      setPendingDeletePath(filePath);
    },
    [globalSettings.confirmDeleteOperations, vscode]
  );

  // Confirmed: actually remove the workflow history entry
  const handleRemoveWorkflowConfirm = useCallback(() => {
    if (!pendingDeletePath) return;
    vscode.postMessage({
      type: MESSAGE_TYPES.REMOVE_WORKFLOW_HISTORY,
      filePath: pendingDeletePath,
    });
    setRecentWorkflows((prev) =>
      prev.filter((w) => w.filePath !== pendingDeletePath)
    );
    setPendingDeletePath(null);
  }, [pendingDeletePath, vscode]);

  const handleRemoveWorkflowCancel = useCallback(() => {
    setPendingDeletePath(null);
  }, []);

  // Pause a specific workflow by ID
  const handlePauseWorkflow = useCallback(
    (workflowId: string) => {
      vscode.postMessage({ type: MESSAGE_TYPES.PAUSE_WORKFLOW, workflowId });
    },
    [vscode]
  );

  // Resume a specific workflow by ID
  const handleResumeWorkflow = useCallback(
    (workflowId: string) => {
      vscode.postMessage({ type: MESSAGE_TYPES.RESUME_WORKFLOW, workflowId });
    },
    [vscode]
  );

  // Stop a specific workflow by ID
  const handleStopWorkflow = useCallback(
    (workflowId: string) => {
      vscode.postMessage({ type: MESSAGE_TYPES.STOP_WORKFLOW, workflowId });
    },
    [vscode]
  );

  const displayName = fileName
    ? workflowName || getWorkflowNameFromPath(fileName)
    : DEFAULT_WORKFLOW_NAME;

  return (
    <div
      ref={containerRef}
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
          className={`workflow-split-button flex border rounded overflow-hidden max-w-full sm:max-w-[500px] w-full sm:w-auto min-w-0 transition-colors ${isDropdownOpen ? "border-cmd-active-border" : "border-cmd-border"}`}
        >
          {/* Main Button - Workflow Name */}
          <button
            type="button"
            onClick={startEditing}
            className="workflow-button-main flex-1 min-w-0 sm:min-w-[250px] text-left overflow-hidden cursor-pointer transition-colors px-3 py-1 bg-cmd-bg text-cmd-fg hover:bg-cmd-active-bg hover:text-cmd-active-fg"
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
                  className="text-[11px] px-1.5 py-[1px] rounded uppercase font-semibold flex-shrink-0 bg-blue-800/50 text-blue-300 border border-blue-600/40"
                  title="Workflow is being managed by the FlightPath CLI"
                >
                  CLI
                </span>
              )}

              {currentWorkflowHasActiveTerminal && (
                <span
                  className="flex-shrink-0 w-4 flex items-center justify-center text-description-fg"
                  title="Terminal session is still running"
                  aria-label="Terminal session is still running"
                >
                  <i className="codicon codicon-terminal text-[13px]" />
                </span>
              )}

              {/* Execution State */}
              {executionState && executionState !== EXECUTION_STATES.IDLE && (
                <span
                  className={`text-[11px] px-1.5 py-[1px] rounded uppercase font-semibold flex-shrink-0 ${getExecutionStateBadgeClass(executionState)}`}
                >
                  {executionState}
                </span>
              )}
            </div>
          </button>

          {/* Separator — mirrors VS Code's monaco-button-dropdown-separator */}
          <div className="bg-cmd-bg text-cmd-fg py-1 flex-shrink-0">
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
            className={`workflow-button-dropdown px-2 py-1 bg-cmd-bg text-cmd-fg flex items-center justify-center gap-1 transition-colors hover:bg-cmd-active-bg hover:text-cmd-active-fg ${isDropdownOpen ? "bg-cmd-active-bg text-cmd-active-fg" : ""}`}
          >
            {/* Pulsing dot: another loaded workflow is running */}
            {loadedWorkflows.some(
              (w) =>
                w.executionState === EXECUTION_STATES.RUNNING &&
                w.id !== activeWorkflowId
            ) && (
              <span
                className="inline-block w-2 h-2 rounded-full bg-bash-status-success animate-pulse"
                title="Another workflow is running"
              />
            )}
            {recentWorkflows.length > 0 && (
              <span className="workflow-count-badge text-[10px] font-semibold bg-badge-bg text-badge-fg rounded-full px-1.5 py-0.5 min-w-[16px] text-center">
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
        className={`workflow-dropdown-menu fixed min-w-[300px] max-w-[min(500px,90vw)] bg-dropdown-bg border border-dropdown-border rounded shadow-lg z-[100] overflow-hidden flex flex-col transition-all duration-150 ${isDropdownOpen && !isEditing ? "opacity-100 visible" : "opacity-0 invisible pointer-events-none"}`}
        style={{
          top: containerRef.current
            ? containerRef.current.getBoundingClientRect().bottom + 4
            : "auto",
          left: "50%",
          transform: `translateX(-50%) translateY(${isDropdownOpen && !isEditing ? "0" : "-4px"})`,
          // allow dropdown to grow with the overall view; use viewport height
          maxHeight: "75vh",
          height: "75vh",
        }}
      >
        {/* Section 1: Running Workflows — only shown when any workflow is RUNNING or PAUSED */}
        {loadedWorkflows.length > 0 && (
          <div className="running-workflows-section flex-shrink-0">
            <div className="workflow-menu-header px-3 py-2 text-[11px] font-semibold text-description-fg uppercase tracking-wider border-b border-dropdown-border bg-editor-bg">
              Running Workflows
            </div>
            <div className="py-1">
              {loadedWorkflows.map((workflow) => (
                <RunningWorkflowItem
                  key={workflow.id}
                  workflow={workflow}
                  isCurrent={workflow.id === activeWorkflowId}
                  hasActiveTerminal={workflowHasActiveTerminal(workflow.id)}
                  onClick={() => handleSwitchWorkflow(workflow.id)}
                  onPause={() => handlePauseWorkflow(workflow.id)}
                  onResume={() => handleResumeWorkflow(workflow.id)}
                  onStop={() => handleStopWorkflow(workflow.id)}
                />
              ))}
            </div>
            <div className="border-t border-dropdown-border" />
          </div>
        )}

        {/* Recent workflows list — exclude any already shown in Running Workflows */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <RecentWorkflows
            workflows={recentWorkflows.filter(
              (rw) =>
                !loadedWorkflows.some(
                  (lw) => lw.workingFilePath === rw.filePath
                )
            )}
            currentFilePath={fileName}
            hasActiveTerminal={recentWorkflowHasActiveTerminal}
            onSelect={handleSelectWorkflow}
            onClearHistory={handleClearHistory}
            onRemove={handleRemoveWorkflow}
            onNewWorkflow={() => {
              setActiveWorkflowWorkingFilePath(null);
              vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW });
              setIsDropdownOpen(false);
            }}
          />
        </div>
      </div>

      {/* Delete workflow history confirmation modal */}
      <DeleteConfirmModal
        isOpen={pendingDeletePath !== null}
        onCancel={handleRemoveWorkflowCancel}
        onConfirm={handleRemoveWorkflowConfirm}
        title="Delete Workflow History"
        message={`Remove "${pendingDeletePath ? getWorkflowNameFromPath(pendingDeletePath) : ""}" from history?`}
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
  // Remove .working.yaml, .working.json, .flightpath.yaml, etc.
  return fileName
    .replace(/\.working\.(yaml|yml|json)$/i, "")
    .replace(/\.flightpath\.(yaml|yml|json)$/i, "")
    .replace(/\.(yaml|yml|json)$/i, "");
}
