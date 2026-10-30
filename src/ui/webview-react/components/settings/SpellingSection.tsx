import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { SETTING_PATHS, SETTING_SCOPES } from "@root/types/DashboardConstants";
import { getSpellingWordError } from "@root/utils/SpellingWords";
import { SettingToggleRow } from "../shared/SettingToggleRow";
import { SettingInputRow } from "../shared/SettingInputRow";
import {
  ChipListEditor,
  type ChipListParseResult,
} from "../shared/ChipListEditor";

/** Long custom-word lists get a filter box. */
const CUSTOM_WORDS_FILTER_THRESHOLD = 12;

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

function parseSpellingWord(trimmed: string): ChipListParseResult<string> {
  const error = getSpellingWordError(trimmed);
  return error ? { error } : { value: trimmed };
}

/**
 * The prompt editor's spell check: the on/off toggle and the active scope's
 * own custom-word list. The merged `spelling.words` is the union of both
 * scopes, so the editor works on `spellingWordsByScope`, not the merged value.
 */
export function SpellingSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const spelling = settings.settings.spelling;
  const sources = settings.sources as Record<string, SettingSource>;
  const rowProps = { sources, onReset, activeScope };
  const scopedWords =
    settings.spellingWordsByScope?.[activeScope] ??
    (activeScope === SETTING_SCOPES.USER ? spelling.words : []);

  return (
    <div className="pt-3 border-t border-panel-border mt-3">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Spelling
      </h3>
      <SettingToggleRow
        settingKey="spelling.enabled"
        checked={spelling.enabled}
        onChange={(v) => onUpdate(SETTING_PATHS.SPELLING_ENABLED, v)}
        {...rowProps}
      />
      <SettingInputRow
        settingKey="spelling.words"
        id="spelling-words-input"
        {...rowProps}
      >
        <ChipListEditor
          items={scopedWords}
          onAdd={(word) =>
            onUpdate(SETTING_PATHS.SPELLING_WORDS, [...scopedWords, word])
          }
          onRemove={(word) =>
            onUpdate(
              SETTING_PATHS.SPELLING_WORDS,
              scopedWords.filter((existing) => existing !== word)
            )
          }
          parse={parseSpellingWord}
          inputId="spelling-words-input"
          inputLabel="Custom word"
          placeholder="e.g. ctrlyoke"
          emptyText={
            activeScope === SETTING_SCOPES.WORKSPACE
              ? "No workspace words. Words added here are shared with everyone who opens this workspace."
              : "No custom words."
          }
          emptyInputError="Word cannot be empty."
          duplicateError={(word) => `"${word}" is already in the list.`}
          removeLabel={(word) => `Remove word ${word}`}
          testIdPrefix="spelling-word"
          filterThreshold={CUSTOM_WORDS_FILTER_THRESHOLD}
          filterLabel="Filter words"
        />
      </SettingInputRow>
    </div>
  );
}
