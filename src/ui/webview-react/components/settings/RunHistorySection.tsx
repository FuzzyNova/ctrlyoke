import { useState } from "react";
import {
  RUN_HISTORY_LOCATIONS,
  SETTING_SCOPES,
  type SettingWriteScope,
} from "@root/types/DashboardConstants";
import type {
  FullGlobalSettings,
  SettingSource,
} from "@root/types/WebviewMessageTypes";
import type { RunHistoryLocation } from "@root/types/CtrlYokeSettings";
import { CustomSelect } from "../shared/CustomSelect";
import { SettingInputRow } from "../shared/SettingInputRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
  onReload: () => void;
}

const RUN_HISTORY_OPTIONS = [
  {
    value: RUN_HISTORY_LOCATIONS.USER,
    label: "User — under your home directory",
  },
  {
    value: RUN_HISTORY_LOCATIONS.WORKSPACE,
    label: "Workspace — beside this repo",
  },
];

export function RunHistorySection({
  settings,
  activeScope,
  onUpdate,
  onReset,
  onReload,
}: Props) {
  const [reloadPending, setReloadPending] = useState(false);
  const sources = settings.sources as Record<string, SettingSource>;
  const isUserScope = activeScope === SETTING_SCOPES.USER;
  const location = settings.settings.storage.runHistoryLocation;

  function handleLocationChange(value: string) {
    if (!isUserScope) return;
    onUpdate("storage.runHistoryLocation", value as RunHistoryLocation);
    setReloadPending(true);
  }

  return (
    <div className="pt-3 border-t border-panel-border mt-3">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Run History
      </h3>
      <SettingInputRow
        label="Run history location"
        description="Choose where ctrlyoke keeps run history. Workspace mode keeps it beside the repo, still ignores .runs/, and does not make runs shareable."
        id="storage-run-history-location"
        path="storage.runHistoryLocation"
        sources={sources}
        activeScope={activeScope}
        onReset={onReset}
      >
        <CustomSelect
          id="storage-run-history-location"
          value={location}
          onChange={handleLocationChange}
          options={RUN_HISTORY_OPTIONS}
          disabled={!isUserScope}
          triggerAriaLabel="Run history location"
          triggerTitle={
            isUserScope
              ? "Choose where run history is stored"
              : "Run history location is user-scoped"
          }
        />
      </SettingInputRow>

      <div className="mt-2 space-y-1 text-xs text-description-fg">
        <p className="flex items-center gap-1.5">
          <i className="codicon codicon-warning" aria-hidden="true" />
          <span className="font-medium text-foreground">Requires reload</span>
          <span>to apply a changed location.</span>
        </p>
        <p>
          Changing this setting does not migrate data. After reload, the other
          location appears as a different history; you can switch back without
          data loss.
        </p>
      </div>

      <div className="mt-2 rounded border border-panel-border bg-input-bg p-2 text-xs">
        <div className="text-description-fg">Resolved run-history location</div>
        <code className="block mt-1 break-all text-foreground" role="status">
          {settings.runHistoryPath ?? "Unavailable until a workspace is open"}
        </code>
      </div>

      {!isUserScope && (
        <p className="mt-2 text-xs italic text-description-fg" role="note">
          Run history location is user-scoped and cannot be changed from
          workspace scope.
        </p>
      )}

      {reloadPending && (
        <div className="mt-2 flex items-center justify-between gap-3 rounded border border-focus-border bg-input-bg p-2 text-xs">
          <span>
            Reload the window now to use the new run-history location.
          </span>
          <button
            type="button"
            onClick={onReload}
            className="shrink-0 px-2 py-1 rounded bg-btn-secondary-bg text-btn-secondary-fg border border-btn-border hover:bg-btn-secondary-hover"
          >
            Reload window
          </button>
        </div>
      )}
    </div>
  );
}
