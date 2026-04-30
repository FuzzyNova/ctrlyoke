import type {
  FullGlobalSettings,
  SettingSource,
} from "@root/types/WebviewMessageTypes";
import type { UserHookConfig } from "@root/types/FlightPathTypes";
import { HooksEditor } from "../editor/HooksEditor";
import {
  McpServersEditor,
  type McpServersValue,
} from "../shared/McpServersEditor";
import { SettingInputRow } from "../shared/SettingInputRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: "workspace" | "user";
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function McpHooksSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const mcpServers = settings.settings.mcp.defaultServers as McpServersValue;
  const hooks = settings.settings.hooks as UserHookConfig[];
  const sources = settings.sources as Record<string, SettingSource>;
  const rowProps = { sources, onReset, activeScope };

  function handleMcpChange(value: McpServersValue) {
    onUpdate("mcp.defaultServers", value ?? []);
  }

  function handleHooksChange(value: object[] | null | undefined) {
    onUpdate("hooks", value ?? []);
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Default MCP Servers
        </h3>
        <SettingInputRow
          label="Default MCP servers"
          description="MCP servers added here are available to all workflows by default."
          path="mcp.defaultServers"
          {...rowProps}
        >
          <McpServersEditor
            value={mcpServers}
            onChange={handleMcpChange}
            showDefault={false}
          />
        </SettingInputRow>
      </div>
      <div className="border-t border-panel-border pt-4">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Default Hooks
        </h3>
        <SettingInputRow
          label="Default hooks"
          description="Hooks defined here run for all workflows by default."
          path="hooks"
          {...rowProps}
        >
          <HooksEditor
            value={hooks.length > 0 ? (hooks as object[]) : null}
            onChange={handleHooksChange}
            showDefault={false}
          />
        </SettingInputRow>
      </div>
    </div>
  );
}
