import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import type { UserHookConfig } from "@root/types/FlightPathTypes";
import { HooksEditor } from "../editor/HooksEditor";
import {
  McpServersEditor,
  type McpServersValue,
} from "../shared/McpServersEditor";

interface Props {
  settings: FullGlobalSettings;
  activeScope: "workspace" | "user";
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function McpHooksSection({ settings, onUpdate }: Props) {
  const mcpServers = settings.settings.mcp.defaultServers as McpServersValue;
  const hooks = settings.settings.hooks as UserHookConfig[];

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
        <p className="text-xs text-description-fg mb-3">
          MCP servers added here are available to all workflows by default.
        </p>
        <McpServersEditor
          value={mcpServers}
          onChange={handleMcpChange}
          showDefault={false}
        />
      </div>
      <div className="border-t border-panel-border pt-4">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Default Hooks
        </h3>
        <p className="text-xs text-description-fg mb-3">
          Hooks defined here run for all workflows by default.
        </p>
        <HooksEditor
          value={hooks.length > 0 ? (hooks as object[]) : null}
          onChange={handleHooksChange}
          showDefault={false}
        />
      </div>
    </div>
  );
}
