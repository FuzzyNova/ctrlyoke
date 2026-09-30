import { useEffect, useState } from "react";
import {
  MESSAGE_TYPES,
  MIN_TRASH_RETENTION_DAYS,
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
import { Icon } from "../shared/Icon";
import { LocalNumberInput } from "../shared/LocalInputs";
import { ClearHistoryModal } from "./ClearHistoryModal";
import { RecentlyDeletedModal } from "./RecentlyDeletedModal";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useHistoryTrashStore } from "@store/historyTrashStore";
import { formatBytes } from "@utils/number";
import {
  RUN_HISTORY_LOCATION_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
  onReload: () => void;
}

export function RunHistorySection({
  settings,
  activeScope,
  onUpdate,
  onReset,
  onReload,
}: Props) {
  const [reloadPending, setReloadPending] = useState(false);
  const [recentlyDeletedOpen, setRecentlyDeletedOpen] = useState(false);
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false);
  const vscode = useVsCodeApi();
  const trashListing = useHistoryTrashStore((state) => state.listing);
  const sources = settings.sources as Record<string, SettingSource>;
  const isUserScope = activeScope === SETTING_SCOPES.USER;
  const location = settings.settings.storage.runHistoryLocation;
  const retentionDays = settings.settings.storage.trashRetentionDays;

  useEffect(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.HISTORY_TRASH_LIST_REQUEST });
  }, [vscode]);

  const trashCount = trashListing?.entries.length;

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
        settingKey="storage.runHistoryLocation"
        id="storage-run-history-location"
        sources={sources}
        activeScope={activeScope}
        onReset={onReset}
      >
        <CustomSelect
          id="storage-run-history-location"
          value={location}
          onChange={handleLocationChange}
          schemaPath="storage.runHistoryLocation"
          options={toSelectOptions(
            RUN_HISTORY_LOCATION_OPTIONS_META,
            "storage.runHistoryLocation"
          )}
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
          <Icon name="warning" />
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
      <h4 className="mt-4 mb-2 text-xs font-semibold text-description-fg">
        Manage history
      </h4>
      <SettingInputRow
        settingKey="history.recentlyDeleted"
        id="history-recently-deleted"
      >
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-foreground">
            {trashCount === undefined
              ? "…"
              : trashCount === 0
                ? "Empty"
                : `${trashCount} ${trashCount === 1 ? "item" : "items"} · ${formatBytes(trashListing?.totalBytes ?? 0)}`}
          </span>
          <button
            id="history-recently-deleted"
            type="button"
            aria-label="View Recently deleted"
            onClick={() => setRecentlyDeletedOpen(true)}
            className="shrink-0 px-2 py-1 rounded bg-btn-secondary-bg text-btn-secondary-fg border border-btn-border hover:bg-btn-secondary-hover"
          >
            View
          </button>
        </div>
      </SettingInputRow>
      <SettingInputRow
        settingKey="storage.trashRetentionDays"
        id="storage-trash-retention-days"
        sources={sources}
        activeScope={activeScope}
        onReset={onReset}
      >
        <LocalNumberInput
          id="storage-trash-retention-days"
          min={MIN_TRASH_RETENTION_DAYS}
          step={1}
          value={retentionDays}
          disabled={!isUserScope}
          onCommit={(value) => {
            if (value === undefined || !Number.isFinite(value)) return;
            onUpdate(
              "storage.trashRetentionDays",
              Math.max(MIN_TRASH_RETENTION_DAYS, Math.floor(value))
            );
          }}
          className="w-24 bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border disabled:opacity-60"
        />
      </SettingInputRow>

      <div className="mt-4 pt-3 border-t border-panel-border">
        <SettingInputRow settingKey="history.clearAll" id="history-clear-all">
          <div className="flex justify-end">
            <button
              id="history-clear-all"
              type="button"
              aria-label="Clear all history"
              onClick={() => setClearHistoryOpen(true)}
              className="px-2 py-1 text-xs rounded border border-btn-border text-error-fg bg-transparent hover:bg-list-hover-bg"
            >
              Clear all history…
            </button>
          </div>
        </SettingInputRow>
      </div>

      <RecentlyDeletedModal
        isOpen={recentlyDeletedOpen}
        onClose={() => setRecentlyDeletedOpen(false)}
      />
      <ClearHistoryModal
        isOpen={clearHistoryOpen}
        retentionDays={retentionDays}
        onClose={() => setClearHistoryOpen(false)}
      />
    </div>
  );
}
