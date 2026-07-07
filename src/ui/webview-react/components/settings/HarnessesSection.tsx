import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { HARNESS_IDS, HARNESS_INFO } from "@root/types/DashboardConstants";
import type { HarnessId } from "@root/types/DashboardConstants";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { CustomSelect, HarnessDropdown } from "@components/shared";
import { DROPDOWN_NAMESPACES } from "../../types/dropdownNamespaces";
import { LocalTextInput } from "../shared/LocalInputs";
import { SettingInputRow } from "../shared/SettingInputRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

const CLI_HARNESSES: HarnessId[] = [
  HARNESS_IDS.COPILOT_CLI,
  HARNESS_IDS.CLAUDE_CLI,
  HARNESS_IDS.CODEX_CLI,
  HARNESS_IDS.OPENCODE_CLI,
  HARNESS_IDS.QWEN_CLI,
  HARNESS_IDS.ANTIGRAVITY_CLI,
  HARNESS_IDS.COPILOT_CHAT,
] as HarnessId[];

const EMPTY_HIDDEN_VALUES: string[] = [];

export function HarnessesSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const models = settings.settings.defaults.models;
  const additionalArgs = settings.settings.defaults.additionalArgs;
  const sources = settings.sources as Record<string, SettingSource>;
  const getModelsForHarness = useSettingsStore((s) => s.getModelsForHarness);
  const hiddenDropdownOptions = useUiStore((s) => s.hiddenDropdownOptions);
  const hideHarness = useUiStore((s) => s.hideDropdownOption);
  const unhideHarness = useUiStore((s) => s.unhideDropdownOption);
  const rowProps = { sources, onReset, activeScope };
  const hiddenHarnesses =
    hiddenDropdownOptions[DROPDOWN_NAMESPACES.HARNESS] ?? EMPTY_HIDDEN_VALUES;

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
        Harness Defaults
      </h3>
      <SettingInputRow
        label="default harness"
        id="harness-active"
        path="defaults.harness"
        {...rowProps}
      >
        <HarnessDropdown
          id="harness-active"
          value={settings.settings.defaults.harness}
          onChange={(value) => onUpdate("defaults.harness", value)}
          showStatus={false}
          hiddenValues={hiddenHarnesses}
          onHideOption={(value) =>
            hideHarness(DROPDOWN_NAMESPACES.HARNESS, value)
          }
          onUnhideOption={(value) =>
            unhideHarness(DROPDOWN_NAMESPACES.HARNESS, value)
          }
          triggerAriaLabel="Choose active harness"
          triggerTitle="Choose the default active harness"
        />
      </SettingInputRow>
      <div className="border-t border-panel-border pt-4">
        <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Model & Extra Args Defaults
        </h3>
      </div>
      <p className="text-xs text-description-fg -mt-2">
        Configure the default model and additional CLI args for each harness.
        These are used when no workflow-level override is set.
      </p>
      <div className="space-y-4">
        {CLI_HARNESSES.map((harnessId) => {
          const info = HARNESS_INFO[harnessId as keyof typeof HARNESS_INFO];
          const isChat = harnessId === HARNESS_IDS.COPILOT_CHAT;
          const currentModel =
            (models as Record<string, string | undefined>)[harnessId] ?? "";
          const discoveredModels = getModelsForHarness(harnessId);

          return (
            <div
              key={harnessId}
              className="border border-panel-border rounded p-3 space-y-2"
            >
              <div className="text-sm font-medium text-foreground">
                {info.name}
              </div>
              <SettingInputRow
                label="Model"
                id={`model-${harnessId}`}
                path={`defaults.models.${harnessId}`}
                {...rowProps}
              >
                {discoveredModels.length > 0 ? (
                  <CustomSelect
                    id={`model-${harnessId}`}
                    value={currentModel}
                    onChange={(v) =>
                      onUpdate(`defaults.models.${harnessId}`, v || undefined)
                    }
                    options={discoveredModels}
                  />
                ) : (
                  <LocalTextInput
                    id={`model-${harnessId}`}
                    value={currentModel}
                    onCommit={(v) =>
                      onUpdate(`defaults.models.${harnessId}`, v || undefined)
                    }
                    placeholder="Enter model ID"
                    className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                  />
                )}
              </SettingInputRow>
              {!isChat && (
                <SettingInputRow
                  label="Extra args"
                  id={`extra-args-${harnessId}`}
                  path={`defaults.additionalArgs.${harnessId}`}
                  {...rowProps}
                >
                  <LocalTextInput
                    id={`extra-args-${harnessId}`}
                    value={
                      (additionalArgs as Record<string, string | undefined>)[
                        harnessId
                      ] ?? ""
                    }
                    onCommit={(v) =>
                      onUpdate(
                        `defaults.additionalArgs.${harnessId}`,
                        v || undefined
                      )
                    }
                    placeholder="None"
                    className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                  />
                </SettingInputRow>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
