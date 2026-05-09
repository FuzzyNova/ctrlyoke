import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { HARNESS_IDS, HARNESS_INFO } from "@root/types/DashboardConstants";
import type { HarnessId } from "@root/types/DashboardConstants";
import { useSettingsStore } from "@store/settingsStore";
import { CustomSelect } from "@components/shared";
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
  HARNESS_IDS.GEMINI_CLI,
  HARNESS_IDS.COPILOT_CHAT,
] as HarnessId[];

export function HarnessesSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const models = settings.settings.models;
  const additionalArgs = settings.settings.additionalArgs;
  const sources = settings.sources as Record<string, SettingSource>;
  const getModelsForHarness = useSettingsStore((s) => s.getModelsForHarness);
  const rowProps = { sources, onReset, activeScope };

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
        Default Harness
      </h3>
      <SettingInputRow
        label="Active harness"
        id="harness-active"
        path="harness"
        {...rowProps}
      >
        <select
          id="harness-active"
          value={settings.settings.harness}
          onChange={(e) => onUpdate("harness", e.target.value)}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        >
          {CLI_HARNESSES.map((id) => (
            <option key={id} value={id}>
              {HARNESS_INFO[id as keyof typeof HARNESS_INFO].name}
            </option>
          ))}
        </select>
      </SettingInputRow>
      <div className="border-t border-panel-border pt-4">
        <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Harness Defaults
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
                path={`models.${harnessId}`}
                {...rowProps}
              >
                {discoveredModels.length > 0 ? (
                  <CustomSelect
                    id={`model-${harnessId}`}
                    value={currentModel}
                    onChange={(v) =>
                      onUpdate(`models.${harnessId}`, v || undefined)
                    }
                    options={discoveredModels}
                  />
                ) : (
                  <input
                    id={`model-${harnessId}`}
                    type="text"
                    value={currentModel}
                    onChange={(e) =>
                      onUpdate(
                        `models.${harnessId}`,
                        e.target.value || undefined
                      )
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
                  path={`additionalArgs.${harnessId}`}
                  {...rowProps}
                >
                  <input
                    id={`extra-args-${harnessId}`}
                    type="text"
                    value={
                      (additionalArgs as Record<string, string | undefined>)[
                        harnessId
                      ] ?? ""
                    }
                    onChange={(e) =>
                      onUpdate(
                        `additionalArgs.${harnessId}`,
                        e.target.value || undefined
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
