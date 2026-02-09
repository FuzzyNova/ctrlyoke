import React, { useState, useRef, useEffect, useCallback } from "react";
import { useWorkflowStore } from "../../store/workflowStore";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { MESSAGE_TYPES, EXECUTION_STATES } from "../../types/messages";
import { RecentWorkflows } from "./RecentWorkflows";
import { getExecutionStateBadgeClass } from "../../utils/status";

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

  // Local state
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [recentWorkflows, setRecentWorkflows] = useState<RecentWorkflow[]>([]);

  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const isRunning = executionState === EXECUTION_STATES.RUNNING;

  // Handle message from extension with recent workflows
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === MESSAGE_TYPES.RECENT_WORKFLOWS) {
        setRecentWorkflows(message.workflows || []);
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
    if (isRunning) return;

    if (!isDropdownOpen) {
      // Request recent workflows from extension
      vscode.postMessage({ type: MESSAGE_TYPES.GET_RECENT_WORKFLOWS });
    }
    setIsDropdownOpen(!isDropdownOpen);
  }, [isDropdownOpen, isRunning, vscode]);

  // Load workflow from recent list
  const handleSelectWorkflow = useCallback(
    (filePath: string) => {
      vscode.postMessage({
        type: MESSAGE_TYPES.LOAD_WORKFLOW,
        filePath,
      });
      setIsDropdownOpen(false);
    },
    [vscode]
  );

  // Clear workflow history
  const handleClearHistory = useCallback(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW_HISTORY });
    setRecentWorkflows([]);
    setIsDropdownOpen(false);
  }, [vscode]);

  // No workflow loaded - show empty state
  if (!fileName) {
    return (
      <div className={`workflow-status ${className}`}>
        <span className="text-[var(--vscode-descriptionForeground)] italic text-sm">
          No workflow loaded
        </span>
      </div>
    );
  }

  const displayName = workflowName || getWorkflowNameFromPath(fileName);

  return (
    <div ref={containerRef} className={`workflow-status relative ${className}`}>
      {/* Editing Mode */}
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={saveEdit}
          className="workflow-name-edit-input px-2 py-1 text-sm font-semibold min-w-[200px] max-w-[400px] bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-focusBorder)] rounded outline-none"
          style={{
            boxShadow: "0 0 0 1px var(--vscode-focusBorder)",
          }}
        />
      ) : (
        /* Display Mode - Split Button Style */
        <div className="workflow-split-button inline-flex rounded overflow-visible max-w-[500px] flex-1 min-w-0">
          {/* Main Button - Workflow Name */}
          <button
            type="button"
            onClick={startEditing}
            className="workflow-button-main flex-1 min-w-[250px] text-left overflow-hidden cursor-pointer transition-colors px-3 py-1.5 rounded-l rounded-r-none border-r-0 bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
            title="Click to edit workflow name"
          >
            <div className="flex items-center justify-between gap-2 overflow-hidden">
              {/* Workflow Name */}
              <span className="font-semibold text-sm truncate flex-1">
                {displayName}
              </span>

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

          {/* Dropdown Trigger */}
          <button
            type="button"
            onClick={toggleDropdown}
            disabled={isRunning}
            aria-label="Show recent workflows"
            aria-haspopup="listbox"
            aria-expanded={isDropdownOpen}
            title={
              isRunning
                ? "Cannot switch workflows while running"
                : "Show recent workflows"
            }
            className={`workflow-button-dropdown px-2 py-1.5 rounded-r rounded-l-none border-l border-[var(--vscode-button-border,rgba(255,255,255,0.1))] bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] flex items-center justify-center gap-1 transition-colors ${
              isRunning
                ? "opacity-50 cursor-not-allowed"
                : "hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
            } ${isDropdownOpen ? "bg-[var(--vscode-button-secondaryHoverBackground)]" : ""}`}
          >
            {recentWorkflows.length > 0 && (
              <span className="workflow-count-badge text-[10px] font-semibold bg-[var(--vscode-badge-background)] text-[var(--vscode-badge-foreground)] rounded-full px-1.5 py-0.5 min-w-[16px] text-center">
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
      {isDropdownOpen && !isEditing && (
        <div
          ref={dropdownRef}
          className="workflow-dropdown-menu fixed min-w-[300px] max-w-[min(500px,90vw)] bg-[var(--vscode-dropdown-background)] border border-[var(--vscode-dropdown-border)] rounded shadow-lg z-[9999] overflow-hidden flex flex-col"
          style={{
            top: containerRef.current
              ? containerRef.current.getBoundingClientRect().bottom + 4
              : "auto",
            left: "50%",
            transform: "translateX(-50%)",
            maxHeight: "min(400px, 70vh)",
            height: "min(400px, 70vh)",
          }}
        >
          <RecentWorkflows
            workflows={recentWorkflows}
            currentFilePath={fileName}
            onSelect={handleSelectWorkflow}
            onClearHistory={handleClearHistory}
          />
        </div>
      )}
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
