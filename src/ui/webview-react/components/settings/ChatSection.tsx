import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { CustomSelect } from "../shared/CustomSelect";
import { SettingInputRow } from "../shared/SettingInputRow";
import { SettingToggleRow } from "../shared/SettingToggleRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

const WINDOW_LOCATION_OPTIONS = [
  { value: "chatPanel", label: "Chat Panel" },
  { value: "newTab", label: "New Tab" },
  { value: "newWindow", label: "New Window" },
];

export function ChatSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const chat = settings.settings.chat;
  const sources = settings.sources as Record<string, SettingSource>;

  const rowProps = { sources, onReset, activeScope };

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Chat (Copilot Chat Harness)
      </h3>
      <SettingInputRow
        label="Chat window location"
        id="chat-window-location"
        path="chat.windowLocation"
        {...rowProps}
      >
        <CustomSelect
          id="chat-window-location"
          value={chat.windowLocation}
          onChange={(v) => onUpdate("chat.windowLocation", v)}
          options={WINDOW_LOCATION_OPTIONS}
        />
      </SettingInputRow>
      <SettingInputRow
        label="Inactivity timeout (seconds)"
        id="chat-inactivity-timeout"
        path="chat.inactivityTimeout"
        {...rowProps}
      >
        <input
          id="chat-inactivity-timeout"
          type="number"
          min={0}
          value={chat.inactivityTimeout}
          onChange={(e) =>
            onUpdate(
              "chat.inactivityTimeout",
              parseInt(e.target.value, 10) || 300
            )
          }
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingToggleRow
        label="Treat timeout as success"
        description="If the inactivity timeout is reached, treat the prompt as successfully completed."
        checked={chat.treatTimeoutAsSuccess}
        onChange={(v) => onUpdate("chat.treatTimeoutAsSuccess", v)}
        path="chat.treatTimeoutAsSuccess"
        {...rowProps}
      />
      <SettingToggleRow
        label="Force agent mode"
        description="Always start the chat in agent mode."
        checked={chat.forceAgentMode}
        onChange={(v) => onUpdate("chat.forceAgentMode", v)}
        path="chat.forceAgentMode"
        {...rowProps}
      />
      <SettingToggleRow
        label="Use native attachments"
        description="Use VS Code's native file attachment API for context files."
        checked={chat.useNativeAttachments}
        onChange={(v) => onUpdate("chat.useNativeAttachments", v)}
        path="chat.useNativeAttachments"
        {...rowProps}
      />
    </div>
  );
}
