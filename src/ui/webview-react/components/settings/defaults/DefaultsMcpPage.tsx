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
        />
      </SettingInputRow>
    </div>
  );
}
