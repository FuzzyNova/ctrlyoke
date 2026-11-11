import { MCP_TRANSPORTS } from "@root/types/DashboardConstants";
import type { McpServerConfig } from "@root/types/CtrlYokeTypes";

export type McpServerDetailRow = { label: string; value: string | null };

export function getMcpServerDetailRows(
  config: McpServerConfig
): McpServerDetailRow[] {
  return [
    { label: "id", value: config.id },
    { label: "command", value: config.command ?? null },
    { label: "args", value: config.args?.join(" ") ?? null },
    { label: "url", value: config.url ?? null },
    {
      label: "transport",
      value:
        config.transport && config.transport !== MCP_TRANSPORTS.STREAMABLE_HTTP
          ? config.transport
          : null,
    },
    {
      label: "env",
      value: config.env ? Object.keys(config.env).join(", ") : null,
    },
    {
      label: "headers",
      value: config.headers ? Object.keys(config.headers).join(", ") : null,
    },
    {
      label: "autoApprove",
      value:
        typeof config.autoApprove === "boolean"
          ? String(config.autoApprove)
          : (config.autoApprove?.join(", ") ?? null),
    },
  ];
}

export function getMcpServerSummary(
  config: McpServerConfig
): string | undefined {
  if (config.url) return config.url;
  if (!config.command) return undefined;
  return `${config.command}${config.args ? ` ${config.args.join(" ")}` : ""}`;
}
