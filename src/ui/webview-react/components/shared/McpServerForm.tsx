import { useId } from "react";
import type { McpServerConfig } from "@root/types/CtrlYokeTypes";
import { CustomSelect } from "./CustomSelect";
import { KeyValueMapEditor } from "./KeyValueMapEditor";

export { findLiteralCredentialEnvKeys } from "./KeyValueMapEditor";

export type McpServerFormTab = "stdio" | "remote";
export type McpServerTransport = "streamable-http" | "sse";

const MCP_TRANSPORT_OPTIONS = [
  { label: "streamable-http", value: "streamable-http" },
  { label: "sse", value: "sse" },
] as const;

export interface McpServerFormState {
  id: string;
  description: string;
  activeTab: McpServerFormTab;
  command: string;
  args: string;
  env: Record<string, string>;
  autoApprove: boolean | string[];
  autoApproveTouched: boolean;
  url: string;
  transport: McpServerTransport;
  headers: Record<string, string>;
  originalServer?: McpServerConfig;
}

export const EMPTY_MCP_SERVER_FORM_STATE: McpServerFormState = {
  id: "",
  description: "",
  activeTab: "stdio",
  command: "",
  args: "",
  env: {},
  autoApprove: false,
  autoApproveTouched: false,
  url: "",
  transport: "streamable-http",
  headers: {},
};

function cloneMcpServerConfig(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
    ...(Array.isArray(server.autoApprove)
      ? { autoApprove: [...server.autoApprove] }
      : {}),
    ...(server.headers ? { headers: { ...server.headers } } : {}),
    ...(server.deniedTools ? { deniedTools: [...server.deniedTools] } : {}),
  };
}

export function serverToMcpServerFormState(
  server: McpServerConfig
): McpServerFormState {
  return {
    id: server.id,
    description: server.description ?? "",
    activeTab: server.url ? "remote" : "stdio",
    command: server.command ?? "",
    args: server.args ? server.args.join(" ") : "",
    env: server.env ? { ...server.env } : {},
    autoApprove: Array.isArray(server.autoApprove)
      ? [...server.autoApprove]
      : typeof server.autoApprove === "boolean"
        ? server.autoApprove
        : false,
    autoApproveTouched: false,
    url: server.url ?? "",
    transport: server.transport ?? "streamable-http",
    headers: server.headers ? { ...server.headers } : {},
    originalServer: cloneMcpServerConfig(server),
  };
}

export function getAutoApproveValue(
  form: McpServerFormState
): boolean | string[] | undefined {
  const original = form.originalServer?.autoApprove;

  if (!form.autoApproveTouched) {
    if (Array.isArray(original)) return [...original];
    if (typeof original === "boolean" && form.autoApprove === original) {
      return original;
    }
  }

  if (Array.isArray(form.autoApprove)) {
    return form.autoApprove.length > 0 ? [...form.autoApprove] : undefined;
  }
  if (form.autoApprove) return true;
  return undefined;
}

function applyCommonMcpServerFormFields(
  server: McpServerConfig,
  form: McpServerFormState
): void {
  server.id = form.id.trim();

  delete server.description;
  if (form.description.trim()) {
    server.description = form.description.trim();
  }

  delete server.autoApprove;
  const autoApprove = getAutoApproveValue(form);
  if (autoApprove !== undefined) {
    server.autoApprove = autoApprove;
  }
}

export function mcpServerFormStateToServer(
  form: McpServerFormState
): McpServerConfig {
  const server: McpServerConfig = form.originalServer
    ? cloneMcpServerConfig(form.originalServer)
    : { id: form.id.trim() };

  applyCommonMcpServerFormFields(server, form);

  if (form.activeTab === "remote") {
    delete server.command;
    delete server.args;
    delete server.env;
    delete server.headers;
    server.url = form.url.trim();
    server.transport = form.transport;
    if (Object.keys(form.headers).length > 0) {
      server.headers = { ...form.headers };
    }
    return server;
  }

  delete server.url;
  delete server.transport;
  delete server.headers;
  server.command = form.command.trim();

  delete server.args;
  if (form.args.trim()) {
    server.args = form.args.trim().split(/\s+/);
  }

  delete server.env;
  if (Object.keys(form.env).length > 0) {
    server.env = { ...form.env };
  }

  return server;
}

export function isMcpServerFormValid(form: McpServerFormState): boolean {
  const id = form.id.trim();
  if (!id) return false;
  return form.activeTab === "stdio"
    ? form.command.trim().length > 0
    : form.url.trim().length > 0;
}

export interface McpServerFormProps {
  value: McpServerFormState;
  onChange: (value: McpServerFormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  cancelLabel?: string;
  title?: string;
  subtitle?: string;
  autoFocus?: boolean;
  className?: string;
}

export function McpServerForm({
  value,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  cancelLabel = "Cancel",
  title,
  subtitle,
  autoFocus = false,
  className = "",
}: McpServerFormProps) {
  const isValid = isMcpServerFormValid(value);
  const autoApproveId = useId();

  return (
    <div
      className={`flex flex-col gap-1.5 rounded border border-focus-border bg-editor-bg p-2 ${className}`.trim()}
    >
      {(title || subtitle) && (
        <div className="flex flex-col gap-0.5">
          {title && (
            <div className="text-xs font-semibold text-foreground">{title}</div>
          )}
          {subtitle && (
            <div className="text-xxs text-description-fg">{subtitle}</div>
          )}
        </div>
      )}

      <input
        type="text"
        placeholder="id (required)"
        aria-label="Server ID"
        value={value.id}
        onChange={(event) => onChange({ ...value, id: event.target.value })}
        className="w-full rounded border border-input-border bg-input-bg px-2 py-1 font-mono text-xs text-input-fg focus:border-focus-border focus:outline-none"
        autoFocus={autoFocus}
      />

      <input
        type="text"
        placeholder="description (optional)"
        aria-label="Description"
        value={value.description}
        onChange={(event) =>
          onChange({ ...value, description: event.target.value })
        }
        className="w-full rounded border border-input-border bg-input-bg px-2 py-1 text-xs text-input-fg focus:border-focus-border focus:outline-none"
      />

      <div className="flex gap-1">
        {(["stdio", "remote"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => onChange({ ...value, activeTab: tab })}
            className={`rounded border px-2 py-0.5 text-xs transition-colors ${
              value.activeTab === tab
                ? "border-btn-bg bg-btn-bg text-btn-fg"
                : "border-panel-border text-description-fg hover:border-focus-border hover:text-foreground"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {value.activeTab === "stdio" ? (
        <>
          <input
            type="text"
            placeholder="command (e.g. node or npx)"
            aria-label="Command"
            value={value.command}
            onChange={(event) =>
              onChange({ ...value, command: event.target.value })
            }
            className="w-full rounded border border-input-border bg-input-bg px-2 py-1 font-mono text-xs text-input-fg focus:border-focus-border focus:outline-none"
          />
          <input
            type="text"
            placeholder="args (space-separated)"
            aria-label="Arguments"
            value={value.args}
            onChange={(event) =>
              onChange({ ...value, args: event.target.value })
            }
            className="w-full rounded border border-input-border bg-input-bg px-2 py-1 font-mono text-xs text-input-fg focus:border-focus-border focus:outline-none"
          />
          <KeyValueMapEditor
            id="mcp-server-env"
            label="env (KEY=VALUE, one per line)"
            ariaLabel="Environment variables (KEY=VALUE, one per line)"
            value={value.env}
            onChange={(env) => onChange({ ...value, env })}
            allowSecretReferences
          />
        </>
      ) : (
        <>
          <input
            type="text"
            placeholder="url (e.g. https://mcp.example.com)"
            aria-label="Server URL"
            value={value.url}
            onChange={(event) =>
              onChange({ ...value, url: event.target.value })
            }
            className="w-full rounded border border-input-border bg-input-bg px-2 py-1 font-mono text-xs text-input-fg focus:border-focus-border focus:outline-none"
          />
          <CustomSelect
            value={value.transport}
            onChange={(transport) =>
              onChange({
                ...value,
                transport: transport as McpServerTransport,
              })
            }
            options={[...MCP_TRANSPORT_OPTIONS]}
            triggerAriaLabel="Choose remote transport"
            triggerTitle="Choose the transport used by the remote MCP server"
          />
          <KeyValueMapEditor
            id="mcp-server-headers"
            label="headers (KEY=VALUE, one per line)"
            value={value.headers}
            onChange={(headers) => onChange({ ...value, headers })}
            allowSecretReferences
          />
        </>
      )}

      <label
        htmlFor={`${autoApproveId}-tools`}
        className="flex flex-col gap-0.5"
      >
        <span className="text-xxs text-description-fg">
          Auto-approve tools (one per line)
        </span>
        <textarea
          id={`${autoApproveId}-tools`}
          aria-label="Auto-approve tools"
          placeholder="tool_name"
          value={
            Array.isArray(value.autoApprove) ? value.autoApprove.join("\n") : ""
          }
          onChange={(event) =>
            onChange({
              ...value,
              autoApprove: event.target.value
                .split("\n")
                .map((tool) => tool.trim())
                .filter(Boolean),
              autoApproveTouched: true,
            })
          }
          rows={2}
          className="w-full resize-none rounded border border-input-border bg-input-bg px-2 py-1 font-mono text-xs text-input-fg focus:border-focus-border focus:outline-none"
        />
      </label>

      <label
        htmlFor={autoApproveId}
        className="flex cursor-pointer items-center gap-1.5"
      >
        <input
          id={autoApproveId}
          type="checkbox"
          aria-label="Auto-approve all tools"
          checked={value.autoApprove === true}
          onChange={(event) =>
            onChange({
              ...value,
              autoApprove: event.target.checked,
              autoApproveTouched: true,
            })
          }
          className="h-3 w-3 accent-focus-border"
        />
        <span className="text-xs text-description-fg">
          Auto-approve all tools
        </span>
      </label>

      <div className="mt-0.5 flex gap-1">
        <button
          type="button"
          onClick={onSubmit}
          disabled={!isValid}
          className="rounded bg-btn-bg px-2 py-0.5 text-xs text-btn-fg hover:bg-btn-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-panel-border px-2 py-0.5 text-xs text-description-fg hover:border-focus-border hover:text-foreground"
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
