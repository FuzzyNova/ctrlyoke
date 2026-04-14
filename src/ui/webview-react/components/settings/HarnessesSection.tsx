import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { HARNESS_IDS, HARNESS_INFO } from "@root/types/DashboardConstants";
import type { HarnessId } from "@root/types/DashboardConstants";
import { useSettingsStore } from "@store/settingsStore";
import { CustomSelect } from "@components/shared";

interface Props {
  settings: FullGlobalSettings;
  onUpdate: (path: string, value: unknown, scope: "workspace" | "user") => void;
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

export function HarnessesSection({ settings, onUpdate }: Props) {
  const models = settings.settings.models;
  const additionalArgs = settings.settings.additionalArgs;
  const getModelsForHarness = useSettingsStore((s) => s.getModelsForHarness);
  const s = "user" as const;

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
        Default Harness
      </h3>
      <div className="grid grid-cols-[120px_1fr] items-center gap-2">
        <label htmlFor="harness-active" className="text-xs text-description-fg">
          Active harness
        </label>
        <select
          id="harness-active"
          value={settings.settings.harness}
          onChange={(e) => onUpdate("harness", e.target.value, s)}
          className="bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        >
          {CLI_HARNESSES.map((id) => (
            <option key={id} value={id}>
              {HARNESS_INFO[id as keyof typeof HARNESS_INFO].name}
            </option>
          ))}
        </select>
      </div>
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
              <div className="grid grid-cols-[80px_1fr] items-center gap-2">
                <label
                  htmlFor={`model-${harnessId}`}
                  className="text-xs text-description-fg"
                >
                  Model
                </label>
                {discoveredModels.length > 0 ? (
                  <CustomSelect
                    id={`model-${harnessId}`}
                    value={currentModel}
                    onChange={(v) =>
                      onUpdate(`models.${harnessId}`, v || undefined, s)
                    }
                    options={[
                      { value: "", label: "Default" },
                      ...discoveredModels,
                    ]}
                  />
                ) : (
                  <input
                    id={`model-${harnessId}`}
                    type="text"
                    value={currentModel}
                    onChange={(e) =>
                      onUpdate(
                        `models.${harnessId}`,
                        e.target.value || undefined,
                        s
                      )
                    }
                    placeholder="Default"
                    className="bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                  />
                )}
              </div>
              {!isChat && (
                <div className="grid grid-cols-[80px_1fr] items-center gap-2">
                  <label
                    htmlFor={`extra-args-${harnessId}`}
                    className="text-xs text-description-fg"
                  >
                    Extra args
                  </label>
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
                        e.target.value || undefined,
                        s
                      )
                    }
                    placeholder="None"
                    className="bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
