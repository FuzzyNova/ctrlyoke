import React from "react";
import { useEditorStore } from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { DROPDOWN_NAMESPACES } from "../../types/dropdownNamespaces";
import { CustomSelect } from "../shared";
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

  const isOpen = footerOpenPicker === "agent";

  const resolvedAgent =
    workflowProperties.agent === undefined
      ? globalSettings.agent
      : workflowProperties.agent;
  const resolvedAgentName = !resolvedAgent
    ? "None"
    : (availableAgents.find(
        (a) => a.path === resolvedAgent || a.name === resolvedAgent
      )?.name ?? resolvedAgent);
  const defaultAgentLabel = `Inherit (${resolvedAgentName})`;

  const valueLabel =
    properties.agent === undefined
      ? resolvedAgentName
      : properties.agent === null
        ? "None"
        : (availableAgents.find(
            (a) => a.path === properties.agent || a.name === properties.agent
          )?.name ?? properties.agent);

  return (
    <FooterQuickPicker
      isNarrow={isNarrow}
      showLabel={showLabel && properties.agent !== undefined}
      icon={
        <i
          className={`codicon codicon-agent transition-opacity ${properties.agent !== undefined ? "text-focus-border" : "opacity-40"}`}
        />
      }
      valueLabel={valueLabel}
      isOverride={properties.agent !== undefined}
      isOpen={isOpen}
      onToggle={() => setFooterOpenPicker(isOpen ? null : "agent")}
      onClose={() => setFooterOpenPicker(null)}
      title="Agent override"
      popupMinWidth="220px"
      disabled={disabled}
    >
      <CustomSelect
        value={
          properties.agent === undefined
            ? "default"
            : properties.agent === null
              ? "none"
              : properties.agent
        }
        onChange={(v) => {
          if (v === "default") {
            setProperty("agent", undefined);
          } else if (v === "none") {
            setProperty("agent", null);
          } else {
            setProperty("agent", v);
          }
          setFooterOpenPicker(null);
        }}
        options={[
          { value: "default", label: defaultAgentLabel },
          { value: "none", label: "None" },
          ...availableAgents.map((agent) => ({
            value: agent.path,
            label: agent.name,
          })),
        ]}
        namespace={DROPDOWN_NAMESPACES.AGENT}
        hiddenValues={hiddenDropdownOptions[DROPDOWN_NAMESPACES.AGENT] ?? []}
        onHideOption={(v) => hideDropdownOption(DROPDOWN_NAMESPACES.AGENT, v)}
        onUnhideOption={(v) =>
          unhideDropdownOption(DROPDOWN_NAMESPACES.AGENT, v)
        }
        nonHideableValues={["default"]}
        dropdownMaxHeight="300px"
        inline={true}
      />
    </FooterQuickPicker>
  );
};
