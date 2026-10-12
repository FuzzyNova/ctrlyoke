import {
  CTRLYOKE_SETTINGS_DEFAULTS,
  FONT_SIZE_LIMITS,
  clampFontSize,
} from "@root/types/CtrlYokeSettings";
import {
  EDITOR_FONT_SIZE_VSCODE,
  LIMIT_SELECTION_VALUES,
  type EditorFontSize,
} from "@root/types/DashboardConstants";
import {
  EDITOR_FONT_SIZE_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import type {
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { CustomSelect } from "../shared/CustomSelect";
import { SettingInputRow } from "../shared/SettingInputRow";
import { FontSizeStepper } from "./FontSizeStepper";

const SETTING_PATH = "ui.editorFontSize";
const SELECT_ID = "ui-editor-font-size";
/** VS Code's default editor size, and the hosted theme's fixed value. */
const FALLBACK_EDITOR_FONT_SIZE = 14;

interface Props {
  value: EditorFontSize;
  onUpdate: (path: string, value: unknown) => void;
  sources: Record<string, SettingSource>;
  onReset: (path: string) => void;
  activeScope: SettingWriteScope;
}

/**
 * The size editors render at right now while following VS Code, so choosing
 * Custom starts from what is already on screen instead of jumping.
 */
function currentHostEditorFontSize(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(
    "--vscode-editor-font-size"
  );
  return clampFontSize(
    Number.parseFloat(raw),
    FONT_SIZE_LIMITS.editor,
    FALLBACK_EDITOR_FONT_SIZE
  );
}

/** `ui.editorFontSize`: Match VS Code, or Custom with a pixel-size stepper. */
export function EditorFontSizeSetting({
  value,
  onUpdate,
  sources,
  onReset,
  activeScope,
}: Props) {
  const isCustom = value !== EDITOR_FONT_SIZE_VSCODE;

  return (
    <SettingInputRow
      settingKey="ui.editorFontSize"
      id={SELECT_ID}
      sources={sources}
      onReset={onReset}
      activeScope={activeScope}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <CustomSelect
            id={SELECT_ID}
            value={isCustom ? LIMIT_SELECTION_VALUES.CUSTOM : value}
            onChange={(next) => {
              if (next === EDITOR_FONT_SIZE_VSCODE) {
                onUpdate(
                  SETTING_PATH,
                  CTRLYOKE_SETTINGS_DEFAULTS.ui.editorFontSize
                );
              } else if (!isCustom) {
                onUpdate(SETTING_PATH, currentHostEditorFontSize());
              }
            }}
            schemaPath={SETTING_PATH}
            options={toSelectOptions(
              EDITOR_FONT_SIZE_OPTIONS_META,
              SETTING_PATH
            )}
          />
        </div>
        {isCustom && (
          <FontSizeStepper
            value={value}
            limits={FONT_SIZE_LIMITS.editor}
            subject="editor font size"
            onChange={(next) => onUpdate(SETTING_PATH, next)}
          />
        )}
      </div>
    </SettingInputRow>
  );
}
