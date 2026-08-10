import React, { useEffect } from "react";
import { useEditorStore } from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { type HarnessId } from "../../types/messages";
import { FOOTER_PICKERS } from "../../types/messages";
import { DROPDOWN_NAMESPACES } from "../../types/dropdownNamespaces";
import { HarnessDropdown, HarnessIcon, HARNESS_DISPLAY_NAMES } from "../shared";
import { FooterQuickPicker } from "./FooterQuickPicker";
import { useHarnessUsageStore } from "@store/harnessUsageStore";
import {
  HARNESS_USAGE_STATUS_CODES,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import {
  isHarnessQuotaStale,
  type HarnessUsageSnapshot,
} from "@root/types/UsageTypes";
import { sendMessage } from "@hooks/useMessageHandler";

interface HarnessQuickPickerProps {
  isNarrow: boolean;
  showLabel: boolean;
  disabled?: boolean;
}

function usageChip(snapshot: HarnessUsageSnapshot | undefined): {
  label: string;
  title: string;
  warning: boolean;
} {
  if (!snapshot) {
    return {
      label: "observed only",
      title: "Harness usage is not loaded yet",
      warning: false,
    };
  }
  if (snapshot.quota.errorCode === HARNESS_USAGE_STATUS_CODES.AUTH_REQUIRED) {
    return {
      label: "needs auth",
      title: "Codex ChatGPT authentication is required",
      warning: true,
    };
  }
  if (isHarnessQuotaStale(snapshot.quota)) {
    return {
      label: "stale",
      title: "Provider usage is stale",
      warning: true,
    };
  }
  const windows = snapshot.quota.windows.filter(
    (window) => window.percentUsed !== undefined
  );
  if (windows.length > 0) {
    return {
      label: `${Math.round(windows[0].percentUsed ?? 0)}% ${windows[0].label}`,
      title: windows
        .map((window) => `${window.percentUsed}% ${window.label}`)
        .join(" · "),
      warning: false,
    };
  }
  return {
    label: "observed only",
    title: "Only ctrlyoke-observed usage is available",
    warning: false,
  };
}

export const HarnessQuickPicker: React.FC<HarnessQuickPickerProps> = ({
  isNarrow,
  showLabel,
  disabled = false,
}) => {
  const { properties, setProperty } = useEditorStore();
  const { globalSettings, workflowProperties, harnessStatus } =
    useSettingsStore();
  const {
    footerOpenPicker,
    setFooterOpenPicker,
    hiddenDropdownOptions,
    hideDropdownOption,
    unhideDropdownOption,
  } = useUiStore();

  const isOpen = footerOpenPicker === FOOTER_PICKERS.HARNESS;

  const resolvedHarness = (workflowProperties.harness ??
    globalSettings.harness) as HarnessId;
  const defaultHarnessLabel = `Inherit (${HARNESS_DISPLAY_NAMES[resolvedHarness] ?? resolvedHarness})`;

  const valueLabel = properties.harness
    ? (HARNESS_DISPLAY_NAMES[properties.harness as HarnessId] ??
      properties.harness)
    : (HARNESS_DISPLAY_NAMES[resolvedHarness] ?? resolvedHarness);

  const handleHarnessChange = (newHarness: string) => {
    if (newHarness === "default") {
      setProperty("harness", undefined);
      setProperty("model", undefined);
      setProperty("additionalArgs", undefined);
    } else {
      setProperty("harness", newHarness);
      const defaultModel = globalSettings.harnessDefaultModels[newHarness];
      setProperty("model", defaultModel || undefined);
      const defaultArgs =
        globalSettings.harnessDefaultAdditionalArgs[newHarness];
      setProperty("additionalArgs", defaultArgs || null);
    }
    setFooterOpenPicker(null);
  };

  const activeHarnessId = (properties.harness ?? resolvedHarness) as HarnessId;
  const isOverride = properties.harness !== undefined;
  useEffect(() => {
    // Cache delivery is synchronous from the extension side; the provider
    // refresh is deliberately scheduled in the background and never gates a run.
    sendMessage(MESSAGE_TYPES.REQUEST_HARNESS_USAGE);
  }, [activeHarnessId]);
  const usage = useHarnessUsageStore(
    (state) => state.snapshotsByHarness[activeHarnessId]
  );
  const chip = usageChip(usage);

  return (
    <div className="flex items-center gap-1 min-w-0">
      <FooterQuickPicker
        isNarrow={isNarrow}
        showLabel={showLabel}
        icon={
          <HarnessIcon
            harnessId={activeHarnessId}
            size={16}
            dimmed={!isOverride}
          />
        }
        valueLabel={valueLabel}
        isOverride={isOverride}
        isOpen={isOpen}
        onToggle={() => setFooterOpenPicker(isOpen ? null : "harness")}
        onClose={() => setFooterOpenPicker(null)}
        title="Harness override"
        heading="Harness"
        popupMinWidth="220px"
        disabled={disabled}
      >
        <HarnessDropdown
          value={properties.harness ?? "default"}
          onChange={handleHarnessChange}
          showDefault={true}
          defaultLabel={defaultHarnessLabel}
          showStatus={true}
          harnessStatus={harnessStatus}
          hiddenValues={
            hiddenDropdownOptions[DROPDOWN_NAMESPACES.HARNESS] ?? []
          }
          onHideOption={(v) =>
            hideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)
          }
          onUnhideOption={(v) =>
            unhideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)
          }
          dropdownMaxHeight="300px"
          inline={true}
        />
      </FooterQuickPicker>
      <span
        className={`max-w-[100px] truncate rounded px-1 py-0.5 text-[10px] text-description-fg ${
          chip.warning ? "bg-btn-secondary-bg" : "bg-input-bg"
        }`}
        title={chip.title}
        aria-label={`Harness usage: ${chip.label}`}
      >
        {chip.label}
      </span>
    </div>
  );
};
