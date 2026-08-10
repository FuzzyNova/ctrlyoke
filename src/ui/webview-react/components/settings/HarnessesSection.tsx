import { useEffect } from "react";
import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import {
  HARNESS_IDS,
  HARNESS_INFO,
  HARNESS_QUOTA_SOURCES,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import type { HarnessId } from "@root/types/DashboardConstants";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { CustomSelect, HarnessDropdown } from "@components/shared";
import { DROPDOWN_NAMESPACES } from "../../types/dropdownNamespaces";
import { LocalTextInput } from "../shared/LocalInputs";
import { SettingInputRow } from "../shared/SettingInputRow";
import { sendMessage } from "@hooks/useMessageHandler";
import { useHarnessUsageStore } from "@store/harnessUsageStore";
import { isHarnessQuotaStale } from "@root/types/UsageTypes";
import type { HarnessUsageSnapshot } from "@root/types/UsageTypes";
import {
  formatCostLabel,
  formatCostSourcePhrase,
} from "@root/utils/TokenFormatting";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

const CLI_HARNESSES: HarnessId[] = [
  HARNESS_IDS.COPILOT_CLI,
  HARNESS_IDS.CLAUDE_CLI,
  HARNESS_IDS.CODEX_CLI,
  HARNESS_IDS.OPENCODE_CLI,
  HARNESS_IDS.QWEN_CLI,
  HARNESS_IDS.ANTIGRAVITY_CLI,
] as HarnessId[];

const EMPTY_HIDDEN_VALUES: string[] = [];

function formatTimestamp(value: number | undefined): string {
  return value === undefined
    ? "Not available"
    : new Date(value).toLocaleString();
}

function quotaSourceLabel(
  source: HarnessUsageSnapshot["quota"]["source"]
): string {
  switch (source) {
    case HARNESS_QUOTA_SOURCES.PROVIDER_LIVE:
      return "provider-live";
    case HARNESS_QUOTA_SOURCES.PROVIDER_LOG:
      return "provider-log";
    case HARNESS_QUOTA_SOURCES.ENTERPRISE_API:
      return "enterprise-api";
    case HARNESS_QUOTA_SOURCES.UNAVAILABLE:
      return "observed only";
  }
}

function UsageCard({
  snapshot,
  harnessId,
  hideCost,
}: {
  snapshot: HarnessUsageSnapshot | undefined;
  harnessId: HarnessId;
  hideCost: boolean;
}) {
  if (!snapshot) {
    return (
      <div className="rounded border border-panel-border bg-panel-bg p-2 text-xs text-description-fg">
        Usage: loading…
        {harnessId === HARNESS_IDS.COPILOT_CLI && (
          <div className="mt-1">
            <a
              className="text-link-fg hover:underline"
              href="https://github.com/settings/copilot"
              target="_blank"
              rel="noreferrer"
            >
              Open GitHub usage dashboard
            </a>
          </div>
        )}
      </div>
    );
  }

  const stale = isHarnessQuotaStale(snapshot.quota);
  const observed = snapshot.observed;
  return (
    <div className="rounded border border-panel-border bg-panel-bg p-2 text-xs space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">Usage</span>
        <span className="text-description-fg">
          Quota source: {quotaSourceLabel(snapshot.quota.source)}
          {stale ? " · stale" : ""}
        </span>
      </div>
      <div className="text-description-fg">
        Quota freshness: {formatTimestamp(snapshot.quota.fetchedAt)}
      </div>
      <div className="text-description-fg">
        Observed source:{" "}
        <span className="text-foreground">ctrlyoke-observed</span>
      </div>
      {harnessId === HARNESS_IDS.COPILOT_CLI && (
        <div className="space-y-1 text-foreground">
          <div>AI credits: not reported by the local usage feed</div>
          <div className="text-description-fg">
            Tokens are secondary context for Copilot; billing uses AI credits or
            premium requests.
          </div>
          <a
            className="text-link-fg hover:underline"
            href="https://github.com/settings/copilot"
            target="_blank"
            rel="noreferrer"
          >
            Open GitHub usage dashboard
          </a>
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 text-foreground">
        {(["daily", "weekly", "monthly"] as const).map((period) => (
          <div key={period} className="rounded bg-input-bg px-2 py-1">
            <div className="text-description-fg capitalize">{period}</div>
            <div>{observed[period]?.total ?? 0} tokens</div>
          </div>
        ))}
      </div>
      {!hideCost &&
        harnessId !== HARNESS_IDS.COPILOT_CLI &&
        observed.monthly?.costUsd !== undefined && (
          <div className="text-description-fg">
            Observed token value:{" "}
            {formatCostLabel(
              observed.monthly.costUsd,
              observed.monthly.costPartial === true
            )}{" "}
            {formatCostSourcePhrase(observed.monthly.costSources)}
          </div>
        )}
      {snapshot.quota.windows.length > 0 && (
        <div className="space-y-1">
          {snapshot.quota.windows.map((window) => (
            <div key={window.id} className="text-description-fg">
              {window.label}: {window.used ?? "—"}
              {window.limit !== undefined ? ` / ${window.limit}` : ""}
              {window.resetAt !== undefined
                ? ` · resets ${formatTimestamp(window.resetAt)}`
                : ""}
            </div>
          ))}
        </div>
      )}
      <div className="text-description-fg">
        Last safe error: {snapshot.quota.errorCode ?? "none"}
      </div>
    </div>
  );
}

export function HarnessesSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  useEffect(() => {
    sendMessage(MESSAGE_TYPES.REQUEST_HARNESS_USAGE);
  }, []);
  const models = settings.settings.defaults.models;
  const additionalArgs = settings.settings.defaults.additionalArgs;
  const sources = settings.sources as Record<string, SettingSource>;
  const getModelsForHarness = useSettingsStore((s) => s.getModelsForHarness);
  const hiddenDropdownOptions = useUiStore((s) => s.hiddenDropdownOptions);
  const hideHarness = useUiStore((s) => s.hideDropdownOption);
  const unhideHarness = useUiStore((s) => s.unhideDropdownOption);
  const rowProps = { sources, onReset, activeScope };
  const hiddenHarnesses =
    hiddenDropdownOptions[DROPDOWN_NAMESPACES.HARNESS] ?? EMPTY_HIDDEN_VALUES;
  const snapshotsByHarness = useHarnessUsageStore(
    (state) => state.snapshotsByHarness
  );

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
        Harness Defaults
      </h3>
      <button
        type="button"
        className="text-xs text-link-fg hover:underline"
        onClick={() => sendMessage(MESSAGE_TYPES.REFRESH_HARNESS_USAGE)}
      >
        Refresh harness usage
      </button>
      <SettingInputRow
        label="default harness"
        id="harness-active"
        path="defaults.harness"
        {...rowProps}
      >
        <HarnessDropdown
          id="harness-active"
          value={settings.settings.defaults.harness}
          onChange={(value) => onUpdate("defaults.harness", value)}
          showStatus={false}
          hiddenValues={hiddenHarnesses}
          onHideOption={(value) =>
            hideHarness(DROPDOWN_NAMESPACES.HARNESS, value)
          }
          onUnhideOption={(value) =>
            unhideHarness(DROPDOWN_NAMESPACES.HARNESS, value)
          }
          triggerAriaLabel="Choose active harness"
          triggerTitle="Choose the default active harness"
        />
      </SettingInputRow>
      <div className="border-t border-panel-border pt-4">
        <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Model & Extra Args Defaults
        </h3>
      </div>
      <p className="text-xs text-description-fg -mt-2">
        Configure the default model and additional CLI args for each harness.
        These are used when no workflow-level override is set.
      </p>
      <div className="space-y-4">
        {CLI_HARNESSES.map((harnessId) => {
          const info = HARNESS_INFO[harnessId as keyof typeof HARNESS_INFO];
          const currentModel =
            (models as Record<string, string | undefined>)[harnessId] ?? "";
          const discoveredModels = getModelsForHarness(harnessId);

          return (
            <div
              key={harnessId}
              className="border border-panel-border rounded p-3 space-y-2"
            >
              <div className="text-sm font-medium text-foreground">
                {info.name}
              </div>
              <SettingInputRow
                label="Model"
                id={`model-${harnessId}`}
                path={`defaults.models.${harnessId}`}
                {...rowProps}
              >
                {discoveredModels.length > 0 ? (
                  <CustomSelect
                    id={`model-${harnessId}`}
                    value={currentModel}
                    onChange={(v) =>
                      onUpdate(`defaults.models.${harnessId}`, v || undefined)
                    }
                    options={discoveredModels}
                  />
                ) : (
                  <LocalTextInput
                    id={`model-${harnessId}`}
                    value={currentModel}
                    onCommit={(v) =>
                      onUpdate(`defaults.models.${harnessId}`, v || undefined)
                    }
                    placeholder="Enter model ID"
                    className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                  />
                )}
              </SettingInputRow>
              <SettingInputRow
                label="Extra args"
                id={`extra-args-${harnessId}`}
                path={`defaults.additionalArgs.${harnessId}`}
                {...rowProps}
              >
                <LocalTextInput
                  id={`extra-args-${harnessId}`}
                  value={
                    (additionalArgs as Record<string, string | undefined>)[
                      harnessId
                    ] ?? ""
                  }
                  onCommit={(v) =>
                    onUpdate(
                      `defaults.additionalArgs.${harnessId}`,
                      v || undefined
                    )
                  }
                  placeholder="None"
                  className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                />
              </SettingInputRow>
              <UsageCard
                harnessId={harnessId}
                snapshot={snapshotsByHarness[harnessId]}
                hideCost={settings.settings.ui.hideCost}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
