import {
  INHERIT_DEFAULT_OPTION,
  NONE_OPTION,
} from "@root/types/DashboardConstants";
import React from "react";
import { useEditorStore } from "../../store/editorStore";
import {
  getBulkDisplayValue,
  MIXED_VALUE,
  BULK_MIXED_OPTION,
} from "../../store/editorStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { DROPDOWN_NAMESPACES } from "../../types/dropdownNamespaces";
import { FOOTER_PICKERS } from "../../types/messages";
import {
  CustomSelect,
  getAgentDisplayName,
  toAgentSelectOption,
} from "../shared";
import { FooterQuickPicker } from "./FooterQuickPicker";
import { Icon } from "../shared/Icon";
import {
  AGENT_SELECTION_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";

interface AgentQuickPickerProps {
  isNarrow: boolean;
  showLabel: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export const AgentQuickPicker: React.FC<AgentQuickPickerProps> = ({
  isNarrow,
  showLabel,
  disabled = false,
  disabledReason,
}) => {
  const properties = useEditorStore((s) => s.properties);
  const setProperty = useEditorStore((s) => s.setProperty);
  const multiSelection = useEditorStore((s) => s.multiSelection);
  const bulkPatch = useEditorStore((s) => s.bulkPatch);
  const clearBulkPatchField = useEditorStore((s) => s.clearBulkPatchField);
  const steps = useWorkflowStore((s) => s.steps);
  const agentValue = multiSelection
    ? getBulkDisplayValue({ multiSelection, bulkPatch }, steps, "agent")
    : properties.agent;
  const globalSettings = useSettingsStore((s) => s.globalSettings);
  const workflowProperties = useSettingsStore((s) => s.workflowProperties);
  const availableAgents = useSettingsStore((s) => s.availableAgents);
  const footerOpenPicker = useUiStore((s) => s.footerOpenPicker);
  const setFooterOpenPicker = useUiStore((s) => s.setFooterOpenPicker);
  const hiddenDropdownOptions = useUiStore((s) => s.hiddenDropdownOptions);
  const hideDropdownOption = useUiStore((s) => s.hideDropdownOption);
  const unhideDropdownOption = useUiStore((s) => s.unhideDropdownOption);

  const isOpen = footerOpenPicker === FOOTER_PICKERS.AGENT;

  const resolvedAgent =
    workflowProperties.agent === undefined
      ? globalSettings.agent
      : workflowProperties.agent;
  const resolvedAgentOption = availableAgents.find(
    (agent) => agent.path === resolvedAgent || agent.name === resolvedAgent
  );
  const resolvedAgentName = !resolvedAgent
    ? "None"
    : resolvedAgentOption
      ? getAgentDisplayName(resolvedAgentOption)
      : resolvedAgent;
  const defaultAgentLabel = `Inherit (${resolvedAgentName})`;

  const valueLabel =
    agentValue === MIXED_VALUE
      ? "(mixed)"
      : agentValue === undefined
        ? resolvedAgentName
        : agentValue === null
          ? "None"
          : (() => {
              const agent = availableAgents.find(
                (a) => a.path === agentValue || a.name === agentValue
              );
              return agent ? getAgentDisplayName(agent) : agentValue;
            })();

  return (
    <FooterQuickPicker
      isNarrow={isNarrow}
      showLabel={showLabel && agentValue !== undefined}
      icon={
        <Icon
          name="agent"
          className={`codicon-sm transition-opacity ${agentValue !== undefined ? "text-focus-border" : "opacity-40"}`}
        />
      }
      valueLabel={valueLabel}
      isOverride={agentValue !== undefined}
      isOpen={isOpen}
      onToggle={() => setFooterOpenPicker(isOpen ? null : "agent")}
      onClose={() => setFooterOpenPicker(null)}
      title="Agent override"
      heading="Agent"
      popupMinWidth="220px"
      disabled={disabled}
      disabledReason={disabledReason}
    >
      <CustomSelect
        schemaPath="agent"
        value={
          agentValue === MIXED_VALUE
            ? BULK_MIXED_OPTION
            : agentValue === undefined
              ? INHERIT_DEFAULT_OPTION
              : agentValue === null
                ? NONE_OPTION
                : agentValue
        }
        onChange={(v) => {
          if (v === BULK_MIXED_OPTION) {
            clearBulkPatchField("agent");
          } else if (v === INHERIT_DEFAULT_OPTION) {
            setProperty("agent", undefined);
          } else if (v === NONE_OPTION) {
            setProperty("agent", null);
          } else {
            setProperty("agent", v);
          }
          setFooterOpenPicker(null);
        }}
        options={[
          ...(agentValue === MIXED_VALUE
            ? [{ value: BULK_MIXED_OPTION, label: "(mixed)" }]
            : []),
          ...toSelectOptions(AGENT_SELECTION_OPTIONS_META, "agent").map(
            (option) =>
              option.value === INHERIT_DEFAULT_OPTION
                ? { ...option, label: defaultAgentLabel }
                : option
          ),
          ...availableAgents.map((agent) =>
            toAgentSelectOption(agent, agent.name)
          ),
        ]}
        namespace={DROPDOWN_NAMESPACES.AGENT}
        hiddenValues={hiddenDropdownOptions[DROPDOWN_NAMESPACES.AGENT] ?? []}
        onHideOption={(v) => hideDropdownOption(DROPDOWN_NAMESPACES.AGENT, v)}
        onUnhideOption={(v) =>
          unhideDropdownOption(DROPDOWN_NAMESPACES.AGENT, v)
        }
        nonHideableValues={[INHERIT_DEFAULT_OPTION]}
        dropdownMaxHeight="300px"
        inline={true}
      />
    </FooterQuickPicker>
  );
};
