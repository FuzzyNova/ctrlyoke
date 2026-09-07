import {
  INHERIT_DEFAULT_OPTION,
  NONE_OPTION,
} from "@root/types/DashboardConstants";
import React from "react";
import { useEditorStore } from "../../store/editorStore";
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

interface AgentQuickPickerProps {
  isNarrow: boolean;
  showLabel: boolean;
  disabled?: boolean;
}

export const AgentQuickPicker: React.FC<AgentQuickPickerProps> = ({
  isNarrow,
  showLabel,
  disabled = false,
}) => {
  const properties = useEditorStore((s) => s.properties);
  const setProperty = useEditorStore((s) => s.setProperty);
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
    properties.agent === undefined
      ? resolvedAgentName
      : properties.agent === null
        ? "None"
        : (() => {
            const agent = availableAgents.find(
              (a) => a.path === properties.agent || a.name === properties.agent
            );
            return agent ? getAgentDisplayName(agent) : properties.agent;
          })();

  return (
    <FooterQuickPicker
      isNarrow={isNarrow}
      showLabel={showLabel && properties.agent !== undefined}
      icon={
        <Icon
          name="agent"
          className={`codicon-sm transition-opacity ${properties.agent !== undefined ? "text-focus-border" : "opacity-40"}`}
        />
      }
      valueLabel={valueLabel}
      isOverride={properties.agent !== undefined}
      isOpen={isOpen}
      onToggle={() => setFooterOpenPicker(isOpen ? null : "agent")}
      onClose={() => setFooterOpenPicker(null)}
      title="Agent override"
      heading="Agent"
      popupMinWidth="220px"
      disabled={disabled}
    >
      <CustomSelect
        value={
          properties.agent === undefined
            ? INHERIT_DEFAULT_OPTION
            : properties.agent === null
              ? NONE_OPTION
              : properties.agent
        }
        onChange={(v) => {
          if (v === INHERIT_DEFAULT_OPTION) {
            setProperty("agent", undefined);
          } else if (v === NONE_OPTION) {
            setProperty("agent", null);
          } else {
            setProperty("agent", v);
          }
          setFooterOpenPicker(null);
        }}
        options={[
          { value: INHERIT_DEFAULT_OPTION, label: defaultAgentLabel },
          { value: NONE_OPTION, label: "None" },
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
