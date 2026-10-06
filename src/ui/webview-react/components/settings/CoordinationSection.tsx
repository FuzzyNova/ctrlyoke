import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { CoordinationActivityPanel } from "../coordination/CoordinationActivityPanel";
import { LocalNumberInput } from "../shared/LocalInputs";
import { SettingInputRow } from "../shared/SettingInputRow";
import { SettingToggleRow } from "../shared/SettingToggleRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function CoordinationSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const coordination = settings.settings.coordination;
  const sources = settings.sources as Record<string, SettingSource>;
  const rowProps = { sources, onReset, activeScope };

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Coordination
      </h3>
      <SettingInputRow
        settingKey="coordination.readNotesPageSize"
        id="coordination-read-notes-page-size"
        {...rowProps}
      >
        <LocalNumberInput
          id="coordination-read-notes-page-size"
          min={1}
          value={coordination.readNotesPageSize}
          onCommit={(value) =>
            onUpdate("coordination.readNotesPageSize", value)
          }
          parse={(value) => parseInt(value, 10) || 1}
          className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground focus:outline-hidden focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey="coordination.maxNoteLength"
        id="coordination-max-note-length"
        {...rowProps}
      >
        <LocalNumberInput
          id="coordination-max-note-length"
          min={1}
          value={coordination.maxNoteLength}
          onCommit={(value) => onUpdate("coordination.maxNoteLength", value)}
          parse={(value) => parseInt(value, 10) || 1}
          className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground focus:outline-hidden focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey="coordination.maxEntries"
        id="coordination-max-entries"
        {...rowProps}
      >
        <LocalNumberInput
          id="coordination-max-entries"
          min={1}
          value={coordination.maxEntries}
          onCommit={(value) => onUpdate("coordination.maxEntries", value)}
          parse={(value) => parseInt(value, 10) || 1}
          className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground focus:outline-hidden focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey="coordination.maxBoardBytes"
        id="coordination-max-board-bytes"
        {...rowProps}
      >
        <LocalNumberInput
          id="coordination-max-board-bytes"
          min={1}
          value={coordination.maxBoardBytes}
          onCommit={(value) => onUpdate("coordination.maxBoardBytes", value)}
          parse={(value) => parseInt(value, 10) || 1}
          className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground focus:outline-hidden focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey="coordination.maxEntryAgeDays"
        id="coordination-max-entry-age-days"
        {...rowProps}
      >
        <LocalNumberInput
          id="coordination-max-entry-age-days"
          min={1}
          value={coordination.maxEntryAgeDays}
          onCommit={(value) => onUpdate("coordination.maxEntryAgeDays", value)}
          parse={(value) => parseInt(value, 10) || 1}
          className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground focus:outline-hidden focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey="coordination.cliParticipantTtlMinutes"
        id="coordination-cli-participant-ttl-minutes"
        {...rowProps}
      >
        <LocalNumberInput
          id="coordination-cli-participant-ttl-minutes"
          min={1}
          value={coordination.cliParticipantTtlMinutes}
          onCommit={(value) =>
            onUpdate("coordination.cliParticipantTtlMinutes", value)
          }
          parse={(value) => parseInt(value, 10) || 1}
          className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground focus:outline-hidden focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingToggleRow
        settingKey="coordination.allowExternalParticipants"
        checked={coordination.allowExternalParticipants}
        onChange={(value) =>
          onUpdate("coordination.allowExternalParticipants", value)
        }
        {...rowProps}
      />
      <CoordinationActivityPanel />
    </div>
  );
}
