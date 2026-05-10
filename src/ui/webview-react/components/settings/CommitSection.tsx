import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { HARNESS_IDS, HARNESS_INFO } from "@root/types/DashboardConstants";
import type { HarnessId } from "@root/types/DashboardConstants";
import { FLIGHTPATH_SETTINGS_DEFAULTS } from "@root/types/FlightPathSettings";
import { useSettingsStore } from "@store/settingsStore";
import { CustomSelect } from "@components/shared";
import { SettingInputRow } from "../shared/SettingInputRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

const ALL_HARNESSES: HarnessId[] = [
  HARNESS_IDS.COPILOT_CLI,
  HARNESS_IDS.CLAUDE_CLI,
  HARNESS_IDS.CODEX_CLI,
  HARNESS_IDS.OPENCODE_CLI,
  HARNESS_IDS.QWEN_CLI,
  HARNESS_IDS.GEMINI_CLI,
  HARNESS_IDS.COPILOT_CHAT,
] as HarnessId[];

const DEFAULT_PROMPT = FLIGHTPATH_SETTINGS_DEFAULTS.commit.prompt;

export function CommitSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const commit = settings.settings.commit;
  const sources = settings.sources as Record<string, SettingSource>;
  const getModelsForHarness = useSettingsStore((s) => s.getModelsForHarness);
  const rowProps = { sources, onReset, activeScope };

  // Resolve the effective harness for model discovery: explicit override or active global harness
  const effectiveHarness =
    (commit.harness as string) || settings.settings.harness;
  const discoveredModels = getModelsForHarness(effectiveHarness as HarnessId);
  const currentModel = (commit.model as string) ?? "";

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
        Commit Message Generation
      </h3>
      <p className="text-xs text-description-fg -mt-2">
        Configure the AI harness, model, and system prompt used when generating
        commit messages via the sparkle button (SCM panel, hosted dashboard) or
        the <code className="font-mono">flightpath commit</code> CLI command.
      </p>

      <SettingInputRow
        label="Harness"
        id="commit-harness"
        path="commit.harness"
        description="AI harness for commit message generation. Leave empty to use the active global harness."
        {...rowProps}
      >
        <select
          id="commit-harness"
          value={commit.harness as string}
          onChange={(e) => onUpdate("commit.harness", e.target.value || "")}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        >
          <option value="">Inherit active harness</option>
          {ALL_HARNESSES.map((id) => (
            <option key={id} value={id}>
              {HARNESS_INFO[id as keyof typeof HARNESS_INFO].name}
            </option>
          ))}
        </select>
      </SettingInputRow>

      <SettingInputRow
        label="Model"
        id="commit-model"
        path="commit.model"
        description="Model override for commit message generation. Leave empty to use the harness default."
        {...rowProps}
      >
        {discoveredModels.length > 0 ? (
          <CustomSelect
            id="commit-model"
            value={currentModel}
            onChange={(v) => onUpdate("commit.model", v || "")}
            options={discoveredModels}
          />
        ) : (
          <input
            id="commit-model"
            type="text"
            value={currentModel}
            onChange={(e) => onUpdate("commit.model", e.target.value)}
            placeholder="Harness default"
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
          />
        )}
      </SettingInputRow>

      <SettingInputRow
        label="System prompt"
        id="commit-prompt"
        path="commit.prompt"
        description="Prompt sent to the AI along with the git diff. The AI should return only the commit message text."
        {...rowProps}
      >
        <textarea
          id="commit-prompt"
          rows={5}
          value={commit.prompt as string}
          onChange={(e) => onUpdate("commit.prompt", e.target.value)}
          placeholder={DEFAULT_PROMPT}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border resize-y font-mono"
        />
      </SettingInputRow>
    </div>
  );
}
