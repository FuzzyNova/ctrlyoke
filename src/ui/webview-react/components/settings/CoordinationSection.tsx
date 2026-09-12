import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
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
        label="Read notes page size"
        description="Maximum entries returned by one read_notes call. Reads are always paged."
        id="coordination-read-notes-page-size"
        path="coordination.readNotesPageSize"
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
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        label="Maximum note length"
        description="Notes longer than this are rejected instead of being silently truncated."
        id="coordination-max-note-length"
        path="coordination.maxNoteLength"
        {...rowProps}
      >
        <LocalNumberInput
          id="coordination-max-note-length"
          min={1}
          value={coordination.maxNoteLength}
          onCommit={(value) => onUpdate("coordination.maxNoteLength", value)}
          parse={(value) => parseInt(value, 10) || 1}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        label="Maximum board entries"
        description="Target entry count after compaction. Held claims are protected."
        id="coordination-max-entries"
        path="coordination.maxEntries"
        {...rowProps}
      >
        <LocalNumberInput
          id="coordination-max-entries"
          min={1}
          value={coordination.maxEntries}
          onCommit={(value) => onUpdate("coordination.maxEntries", value)}
          parse={(value) => parseInt(value, 10) || 1}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        label="Maximum board size (bytes)"
        description="Hygiene ceiling for the persisted board."
        id="coordination-max-board-bytes"
        path="coordination.maxBoardBytes"
        {...rowProps}
      >
        <LocalNumberInput
          id="coordination-max-board-bytes"
          min={1}
          value={coordination.maxBoardBytes}
          onCommit={(value) => onUpdate("coordination.maxBoardBytes", value)}
          parse={(value) => parseInt(value, 10) || 1}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        label="Note retention (days)"
        description="Notes older than this are removed during compaction."
        id="coordination-max-entry-age-days"
        path="coordination.maxEntryAgeDays"
        {...rowProps}
      >
        <LocalNumberInput
          id="coordination-max-entry-age-days"
          min={1}
          value={coordination.maxEntryAgeDays}
          onCommit={(value) => onUpdate("coordination.maxEntryAgeDays", value)}
          parse={(value) => parseInt(value, 10) || 1}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        label="CLI participant TTL (minutes)"
        description="Lease lifetime for CLI and built-in skill participants."
        id="coordination-cli-participant-ttl-minutes"
        path="coordination.cliParticipantTtlMinutes"
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
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingToggleRow
        label="Allow external participants"
        description="Allow agents not launched by ctrlyoke to join this execution-root board."
        checked={coordination.allowExternalParticipants}
        onChange={(value) =>
          onUpdate("coordination.allowExternalParticipants", value)
        }
        path="coordination.allowExternalParticipants"
        {...rowProps}
      />
    </div>
  );
}
