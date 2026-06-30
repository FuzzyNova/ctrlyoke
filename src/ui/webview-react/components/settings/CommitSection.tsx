import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import type { HarnessId } from "@root/types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { CustomSelect } from "@components/shared/CustomSelect";
import { HarnessDropdown } from "@components/shared/HarnessDropdown";
import { DROPDOWN_NAMESPACES } from "../../types/dropdownNamespaces";
import { LocalTextInput, LocalTextarea } from "@components/shared/LocalInputs";
import { SettingInputRow } from "../shared/SettingInputRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

const MAX_PROMPT_LINES = 500;

function PromptPreview({ text }: { text: string }) {
  const lines = text.split("\n");
  const truncated = lines.length > MAX_PROMPT_LINES;
  const display = truncated
    ? lines.slice(0, MAX_PROMPT_LINES).join("\n") + "\n... (truncated)"
    : text;
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border border-input-border bg-input-bg p-2 text-xs text-foreground">
      {display}
    </pre>
  );
}

const DEFAULT_PROMPT = CTRLYOKE_SETTINGS_DEFAULTS.commit.prompt;
const EMPTY_HIDDEN_VALUES: string[] = [];

export function CommitSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const commit = settings.settings.commit;
  const sources = settings.sources as Record<string, SettingSource>;
  const getModelsForHarness = useSettingsStore((s) => s.getModelsForHarness);
  const hiddenDropdownOptions = useUiStore((s) => s.hiddenDropdownOptions);
  const hideHarness = useUiStore((s) => s.hideDropdownOption);
  const unhideHarness = useUiStore((s) => s.unhideDropdownOption);
  const lastCommitMessageGeneration = useSettingsStore(
    (s) => s.lastCommitMessageGeneration
  );
  const rowProps = { sources, onReset, activeScope };
  const hiddenHarnesses =
    hiddenDropdownOptions[DROPDOWN_NAMESPACES.HARNESS] ?? EMPTY_HIDDEN_VALUES;

  // Resolve the effective harness for model discovery: explicit override or active global harness
  const effectiveHarness =
    (commit.harness as string) || settings.settings.defaults.harness;
  const discoveredModels = getModelsForHarness(effectiveHarness as HarnessId);
  const currentModel = (commit.model as string) ?? "";
  const generationStatus = lastCommitMessageGeneration
    ? lastCommitMessageGeneration.staged
      ? "Used staged diff from git."
      : lastCommitMessageGeneration.includesUntrackedFiles
        ? "Used working tree diff plus generated hunks for untracked files."
        : "Used working tree diff because no staged diff was found."
    : null;
  const generationSource = lastCommitMessageGeneration
    ? lastCommitMessageGeneration.source === "scm"
      ? "VS Code SCM button"
      : "Workspace viewer"
    : null;
  const generatedAt = lastCommitMessageGeneration
    ? new Date(lastCommitMessageGeneration.generatedAt).toLocaleString()
    : null;

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
        Commit Message Generation
      </h3>
      <p className="text-xs text-description-fg -mt-2">
        Configure the AI harness, model, and system prompt used when generating
        commit messages via the generate button (SCM panel, hosted dashboard) or
        the <code className="font-mono">ctrlyoke commit</code> CLI command.
      </p>

      <SettingInputRow
        label="Harness"
        id="commit-harness"
        path="commit.harness"
        description="AI harness for commit message generation. Leave empty to use the active global harness."
        {...rowProps}
      >
        <HarnessDropdown
          id="commit-harness"
          value={(commit.harness as string) || "default"}
          onChange={(value) =>
            onUpdate("commit.harness", value === "default" ? "" : value)
          }
          showDefault={true}
          defaultLabel="Inherit active harness"
          showStatus={false}
          hiddenValues={hiddenHarnesses}
          onHideOption={(value) =>
            hideHarness(DROPDOWN_NAMESPACES.HARNESS, value)
          }
          onUnhideOption={(value) =>
            unhideHarness(DROPDOWN_NAMESPACES.HARNESS, value)
          }
          triggerAriaLabel="Choose commit message harness"
          triggerTitle="Choose the harness used for commit message generation"
        />
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
          <LocalTextInput
            id="commit-model"
            value={currentModel}
            onCommit={(v) => onUpdate("commit.model", v)}
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
        <LocalTextarea
          id="commit-prompt"
          rows={5}
          value={commit.prompt as string}
          onCommit={(v) => onUpdate("commit.prompt", v)}
          placeholder={DEFAULT_PROMPT}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border resize-y font-mono"
        />
      </SettingInputRow>

      <div className="border-t border-panel-border pt-3 space-y-2">
        <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Last Generation Input
        </h3>

        <p className="text-xs text-description-fg">
          Shows the most recent real git diff text appended to the commit prompt
          before ctrlyoke asked the selected harness to generate a commit
          message. Opening this section does not run git or generate a new
          preview.
        </p>

        {generationSource ? (
          <div className="text-xs text-description-fg">
            Last triggered from: {generationSource}
          </div>
        ) : null}

        {generatedAt ? (
          <div className="text-xs text-description-fg">
            Generated at: {generatedAt}
          </div>
        ) : null}

        {lastCommitMessageGeneration?.commands.length ? (
          <div className="text-xs text-description-fg">
            Git commands:
            <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap rounded border border-input-border bg-input-bg p-2 text-xs text-foreground">
              {lastCommitMessageGeneration.commands.join("\n")}
            </pre>
          </div>
        ) : null}

        {lastCommitMessageGeneration?.workingDirectory ? (
          <div className="text-xs text-description-fg">
            Working directory:{" "}
            <code className="font-mono">
              {lastCommitMessageGeneration.workingDirectory}
            </code>
          </div>
        ) : null}

        {generationStatus ? (
          <div className="text-xs text-description-fg">{generationStatus}</div>
        ) : null}

        {lastCommitMessageGeneration?.truncated ? (
          <div className="text-xs text-warning-fg">
            The diff was truncated before being sent to the AI.
          </div>
        ) : null}

        {lastCommitMessageGeneration ? (
          <>
            {lastCommitMessageGeneration.cliCommand ? (
              <div className="space-y-1">
                <div className="text-xs font-semibold text-description-fg">
                  Harness command:
                </div>
                <pre className="overflow-auto whitespace-pre-wrap rounded border border-input-border bg-input-bg p-2 text-xs text-foreground">
                  {lastCommitMessageGeneration.cliCommand}
                </pre>
              </div>
            ) : null}

            <div className="space-y-1">
              <div className="text-xs font-semibold text-description-fg">
                Prompt sent to harness:
              </div>
              <PromptPreview
                text={
                  lastCommitMessageGeneration.prompt ??
                  lastCommitMessageGeneration.output
                }
              />
            </div>

            {lastCommitMessageGeneration.generatedMessage ? (
              <div className="space-y-1">
                <div className="text-xs font-semibold text-description-fg">
                  Generated message:
                </div>
                <pre className="overflow-auto whitespace-pre-wrap rounded border border-input-border bg-input-bg p-2 text-xs text-foreground">
                  {lastCommitMessageGeneration.generatedMessage}
                </pre>
              </div>
            ) : null}
          </>
        ) : (
          <pre className="min-h-20 overflow-auto whitespace-pre-wrap rounded border border-input-border bg-input-bg p-2 text-xs text-foreground">
            No commit message generation has run yet.
          </pre>
        )}
      </div>
    </div>
  );
}
