import { INHERIT_DEFAULT_OPTION } from "@root/types/DashboardConstants";
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
  const { properties, setProperty } = useEditorStore();
  const { globalSettings, workflowProperties, availableAgents } =
    useSettingsStore();
  const {
    footerOpenPicker,
    setFooterOpenPicker,
    hiddenDropdownOptions,
    hideDropdownOption,
    unhideDropdownOption,
  } = useUiStore();

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
        <i
          className={`codicon codicon-agent codicon-sm transition-opacity ${properties.agent !== undefined ? "text-focus-border" : "opacity-40"}`}
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
              ? "none"
              : properties.agent
        }
        onChange={(v) => {
          if (v === INHERIT_DEFAULT_OPTION) {
            setProperty("agent", undefined);
          } else if (v === "none") {
            setProperty("agent", null);
          } else {
            setProperty("agent", v);
          }
          setFooterOpenPicker(null);
        }}
        options={[
          { value: INHERIT_DEFAULT_OPTION, label: defaultAgentLabel },
          { value: "none", label: "None" },
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
