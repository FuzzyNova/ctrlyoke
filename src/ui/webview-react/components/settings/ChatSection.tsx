import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { CustomSelect } from "../shared/CustomSelect";

interface Props {
  settings: FullGlobalSettings;
  onUpdate: (path: string, value: unknown, scope: "workspace" | "user") => void;
}

interface ToggleRowProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer group">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 accent-focus-border cursor-pointer shrink-0"
      />
      <span className="flex flex-col">
        <span className="text-sm text-foreground">{label}</span>
        {description && (
          <span className="text-xs text-description-fg mt-0.5">{description}</span>
        )}
      </span>
    </label>
  );
}

const WINDOW_LOCATION_OPTIONS = [
  { value: "chatPanel", label: "Chat Panel" },
  { value: "newTab", label: "New Tab" },
  { value: "newWindow", label: "New Window" },
];

export function ChatSection({ settings, onUpdate }: Props) {
  const chat = settings.settings.chat;
  const s = "user" as const;

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Chat (Copilot Chat Harness)
      </h3>
      <div>
        <label className="block text-xs text-description-fg mb-1">Chat window location</label>
        <CustomSelect
          value={chat.windowLocation}
          onChange={(v) => onUpdate("chat.windowLocation", v, s)}
          options={WINDOW_LOCATION_OPTIONS}
        />
      </div>
      <div>
        <label className="block text-xs text-description-fg mb-1">
          Inactivity timeout (seconds)
        </label>
        <input
          type="number"
          min={0}
          value={chat.inactivityTimeout}
          onChange={(e) =>
            onUpdate("chat.inactivityTimeout", parseInt(e.target.value, 10) || 300, s)
          }
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </div>
      <ToggleRow
        label="Treat timeout as success"
        description="If the inactivity timeout is reached, treat the prompt as successfully completed."
        checked={chat.treatTimeoutAsSuccess}
        onChange={(v) => onUpdate("chat.treatTimeoutAsSuccess", v, s)}
      />
      <ToggleRow
        label="Force agent mode"
        description="Always start the chat in agent mode."
        checked={chat.forceAgentMode}
        onChange={(v) => onUpdate("chat.forceAgentMode", v, s)}
      />
      <ToggleRow
        label="Use native attachments"
        description="Use VS Code's native file attachment API for context files."
        checked={chat.useNativeAttachments}
        onChange={(v) => onUpdate("chat.useNativeAttachments", v, s)}
      />
    </div>
  );
}
