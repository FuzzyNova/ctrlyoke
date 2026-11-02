import React, { useCallback, useEffect } from "react";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { DASHBOARD_HOST_CAPABILITIES } from "@root/types/DashboardConstants";
import { MESSAGE_TYPES } from "../../types/messages";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { toWorkspaceRelative } from "../workspace-viewer/fileBrowserShared";
import { Button } from "../shared";

interface WorkflowLocationNameFieldsProps {
  location: string;
  name: string;
  nameError?: string | null;
  locationLabel?: string;
  nameLabel?: string;
  placeholder?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onLocationChange: (value: string) => void;
  onNameChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onNameKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

/** Location, name and host-aware browse controls shared by Save and Export. */
export const WorkflowLocationNameFields: React.FC<
  WorkflowLocationNameFieldsProps
> = ({
  location,
  name,
  nameError,
  locationLabel = "Location",
  nameLabel = "Name",
  placeholder = "my-workflow",
  inputRef,
  onLocationChange,
  onNameChange,
  onNameKeyDown,
}) => {
  const vscode = useVsCodeApi();
  const canSelectWorkspacePath = useUiStore((state) =>
    state.hostCapabilities.includes(
      DASHBOARD_HOST_CAPABILITIES.selectWorkspacePath
    )
  );
  const openFileBrowser = useUiStore((state) => state.openFileBrowser);
  const selection = useUiStore((state) => state.saveLocationSelection);
  const setSelection = useUiStore((state) => state.setSaveLocationSelection);
  const workspaceRoot = useSettingsStore(
    (state) => state.globalSettings.workspaceRoot
  );

  useEffect(() => {
    if (!selection) return;
    onLocationChange(selection.path);
    setSelection(null);
  }, [onLocationChange, selection, setSelection]);

  const browse = useCallback(() => {
    if (!canSelectWorkspacePath) {
      openFileBrowser({
        mode: "directory",
        initialPath: toWorkspaceRelative(location, workspaceRoot),
        onSelect: onLocationChange,
      });
      return;
    }
    vscode.postMessage({
      type: MESSAGE_TYPES.BROWSE_SAVE_LOCATION,
      defaultDir: location,
    });
  }, [
    canSelectWorkspacePath,
    location,
    onLocationChange,
    openFileBrowser,
    vscode,
    workspaceRoot,
  ]);

  return (
    <>
      <div className="form-group">
        <span className="block mb-1 text-sm font-medium text-foreground">
          {locationLabel}
        </span>
        <div className="flex items-center gap-1.5">
          <span
            className="flex-1 min-w-0 truncate px-2 py-1.5 rounded-sm bg-input-bg text-input-fg border border-input-border font-mono text-xs"
            title={location || "(workspace root)"}
          >
            {location || "(workspace root)"}
          </span>
          <Button
            variant="secondary"
            onClick={browse}
            title={`Browse for ${locationLabel.toLowerCase()}`}
          >
            Browse…
          </Button>
        </div>
        <p className="mt-1 text-xs text-description-fg">
          Absolute path or path relative to the workspace root.
        </p>
      </div>
      <div className="form-group">
        <label className="block text-sm font-medium text-foreground">
          <span className="block mb-1">{nameLabel}</span>
          <input
            ref={inputRef}
            type="text"
            aria-label={nameLabel}
            value={name}
            onChange={onNameChange}
            onKeyDown={onNameKeyDown}
            spellCheck={false}
            placeholder={placeholder}
            className={`w-full px-2 py-1.5 rounded-sm bg-input-bg text-input-fg border focus:outline-hidden font-mono text-xs ${nameError ? "border-input-error-border" : "border-input-border focus:border-focus-border"}`}
          />
        </label>
        {nameError && <p className="mt-1 text-xs text-error-fg">{nameError}</p>}
      </div>
    </>
  );
};
