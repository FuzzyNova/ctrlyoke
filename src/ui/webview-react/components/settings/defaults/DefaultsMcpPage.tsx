import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import {
  McpServersEditor,
  type McpServersValue,
} from "../../shared/McpServersEditor";
import { SettingInputRow } from "../../shared/SettingInputRow";
import { useUiStore } from "../../../store/uiStore";
import { useMcpServerActions } from "../../../hooks/useMcpServerActions";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function DefaultsMcpPage({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const sources = settings.sources as Record<string, SettingSource>;
  const mcpServers = settings.settings.defaults.mcpServers as McpServersValue;
  const rowProps = { sources, onReset, activeScope };

  const {
    mcpLocalServers,
    mcpLocalServersLoading,
    mcpLocalServersError,
    mcpRegistryServers,
    mcpRegistryLoading,
    mcpRegistryError,
    mcpWorkspaceServers,
    mcpWorkspaceServersLoading,
  } = useUiStore();

  const {
    handleRequestLocalServers,
    handleSearchRegistry,
    handleRequestWorkspaceServers,
    handleWorkspaceServersChange,
  } = useMcpServerActions();

  return (
    <div className="space-y-4">
      <SettingInputRow
        label="Default MCP servers"
        description="MCP servers added here are available to all workflows by default."
        path="defaults.mcpServers"
        {...rowProps}
      >
        <McpServersEditor
          value={mcpServers}
          onChange={(value) => onUpdate("defaults.mcpServers", value ?? [])}
          showDefault={false}
          onRequestLocalServers={handleRequestLocalServers}
          onSearchRegistry={handleSearchRegistry}
          localServers={mcpLocalServers}
          isLoadingLocal={mcpLocalServersLoading}
          localServersError={mcpLocalServersError}
          registryServers={mcpRegistryServers}
          isLoadingRegistry={mcpRegistryLoading}
          registryError={mcpRegistryError}
          workspaceServers={mcpWorkspaceServers}
          isLoadingWorkspaceServers={mcpWorkspaceServersLoading}
          onRequestWorkspaceServers={handleRequestWorkspaceServers}
          onWorkspaceServersChange={handleWorkspaceServersChange}
        />
      </SettingInputRow>
    </div>
  );
}
