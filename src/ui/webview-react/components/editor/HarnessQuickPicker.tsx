import React, { useEffect } from "react";
import { useEditorStore } from "../../store/editorStore";
import {
  getBulkDisplayValue,
  MIXED_VALUE,
  BULK_MIXED_OPTION,
} from "../../store/editorStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { type HarnessId } from "../../types/messages";
import { FOOTER_PICKERS } from "../../types/messages";
import { DROPDOWN_NAMESPACES } from "../../types/dropdownNamespaces";
import { HarnessDropdown, HarnessIcon, HARNESS_DISPLAY_NAMES } from "../shared";
import { FooterQuickPicker } from "./FooterQuickPicker";
import { useHarnessUsageStore } from "@store/harnessUsageStore";
import {
  INHERIT_DEFAULT_OPTION,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import { sendMessage } from "@hooks/useMessageHandler";
import { buildHarnessChangeCascade } from "@utils/harnessChangeCascade";
import { useUsagePercentDirection } from "@hooks/useUsagePercentDirection";
import {
  formatHarnessUsageTooltip,
  getHarnessAvailabilityPhrase,
  getHarnessUsageDisplay,
} from "@utils/harnessUsageDisplay";

interface HarnessQuickPickerProps {
  isNarrow: boolean;
  showLabel: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export const HarnessQuickPicker: React.FC<HarnessQuickPickerProps> = ({
  isNarrow,
  showLabel,
  disabled = false,
  disabledReason,
}) => {
  const properties = useEditorStore((s) => s.properties);
  const setHarnessCascade = useEditorStore((s) => s.setHarnessCascade);
  const clearBulkPatchField = useEditorStore((s) => s.clearBulkPatchField);
  const clearBulkCascadeCompanions = useEditorStore(
    (s) => s.clearBulkCascadeCompanions
  );
  const multiSelection = useEditorStore((s) => s.multiSelection);
  const bulkPatch = useEditorStore((s) => s.bulkPatch);
  const steps = useWorkflowStore((s) => s.steps);
  const harnessValue = multiSelection
    ? getBulkDisplayValue({ multiSelection, bulkPatch }, steps, "harness")
    : properties.harness;
  const globalSettings = useSettingsStore((s) => s.globalSettings);
  const workflowProperties = useSettingsStore((s) => s.workflowProperties);
  const harnessStatus = useSettingsStore((s) => s.harnessStatus);
  const footerOpenPicker = useUiStore((s) => s.footerOpenPicker);
  const setFooterOpenPicker = useUiStore((s) => s.setFooterOpenPicker);
  const hiddenDropdownOptions = useUiStore((s) => s.hiddenDropdownOptions);
  const hideDropdownOption = useUiStore((s) => s.hideDropdownOption);
  const unhideDropdownOption = useUiStore((s) => s.unhideDropdownOption);

  const isOpen = footerOpenPicker === FOOTER_PICKERS.HARNESS;

  const resolvedHarness = (workflowProperties.harness ??
    globalSettings.harness) as HarnessId;
  const defaultHarnessLabel = `Inherit (${HARNESS_DISPLAY_NAMES[resolvedHarness] ?? resolvedHarness})`;

  const valueLabel =
    harnessValue === MIXED_VALUE
      ? "(mixed)"
      : harnessValue
        ? (HARNESS_DISPLAY_NAMES[harnessValue as HarnessId] ?? harnessValue)
        : (HARNESS_DISPLAY_NAMES[resolvedHarness] ?? resolvedHarness);

  const handleHarnessChange = (newHarness: string) => {
    if (newHarness === BULK_MIXED_OPTION) {
      clearBulkPatchField("harness");
      clearBulkCascadeCompanions();
    } else {
      setHarnessCascade(buildHarnessChangeCascade(newHarness, globalSettings));
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
  const usageSnapshot = useHarnessUsageStore(
    (state) => state.snapshotsByHarness[activeHarnessId]
  );
  const percentDirection = useUsagePercentDirection();
  const usageDisplay = getHarnessUsageDisplay(
    usageSnapshot,
    percentDirection
  );
  const availabilityPhrase = getHarnessAvailabilityPhrase(
    harnessStatus[activeHarnessId]
  );

  const overrideLabel = isOverride
    ? `Harness override: ${valueLabel}`
    : `Harness: ${defaultHarnessLabel}`;
  const tooltip = formatHarnessUsageTooltip(
    usageDisplay,
    availabilityPhrase,
    overrideLabel
  );

  return (
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
      badgeLabel={usageDisplay.percentOnly}
      isOverride={isOverride}
      isOpen={isOpen}
      onToggle={() => setFooterOpenPicker(isOpen ? null : "harness")}
      onClose={() => setFooterOpenPicker(null)}
      title={tooltip}
      heading="Harness"
      popupMinWidth="220px"
      disabled={disabled}
      disabledReason={disabledReason}
    >
      <HarnessDropdown
        schemaPath="harness"
        value={
          harnessValue === MIXED_VALUE
            ? BULK_MIXED_OPTION
            : (harnessValue ?? INHERIT_DEFAULT_OPTION)
        }
        onChange={handleHarnessChange}
        showDefault={true}
        defaultLabel={defaultHarnessLabel}
        defaultHarnessId={resolvedHarness}
        showStatus={true}
        harnessStatus={harnessStatus}
        hiddenValues={hiddenDropdownOptions[DROPDOWN_NAMESPACES.HARNESS] ?? []}
        onHideOption={(v) => hideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)}
        onUnhideOption={(v) =>
          unhideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)
        }
        dropdownMaxHeight="300px"
        inline={true}
      />
    </FooterQuickPicker>
  );
};
