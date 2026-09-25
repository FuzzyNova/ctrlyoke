import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { SETTING_PATHS } from "@root/types/DashboardConstants";
import { LocalNumberInput } from "../shared/LocalInputs";
import { SettingInputRow } from "../shared/SettingInputRow";
import { SettingToggleRow } from "../shared/SettingToggleRow";
import { CustomSelect } from "../shared/CustomSelect";
import {
  CONTEXT_RESOLUTION_FAILURE_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function ExecutionSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const exec = settings.settings.execution;
  const sources = settings.sources as Record<string, SettingSource>;

  const rowProps = { sources, onReset, activeScope };

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Execution
      </h3>
      <SettingInputRow
        label="Context resolution failures"
        description="How to handle a declared reference that fails to resolve: a missing/invalid secret (!NAME), an unknown skill (/skill:) or MCP server (/mcp:), an unresolved @file/#selection/#sym reference, or an unresolved ~diff/~staged/~stash/~<hash> git reference. 'warn' (default) reports a diagnostic and lets the step run anyway. 'fail' stops the step before the harness spawns, naming the unresolved reference."
        id="exec-strict-context-resolution"
        path={SETTING_PATHS.EXECUTION_CONTEXT_RESOLUTION_FAILURE}
        {...rowProps}
      >
        <CustomSelect
          id="exec-strict-context-resolution"
          value={exec.contextResolutionFailure}
          onChange={(value) =>
            onUpdate(SETTING_PATHS.EXECUTION_CONTEXT_RESOLUTION_FAILURE, value)
          }
          schemaPath="execution.contextResolutionFailure"
          options={toSelectOptions(
            CONTEXT_RESOLUTION_FAILURE_OPTIONS_META,
            "execution.contextResolutionFailure"
          )}
        />
      </SettingInputRow>
      <SettingInputRow
        label="Max prompt timeout (seconds, -1 = unlimited)"
        id="exec-max-prompt-timeout"
        path="execution.maxPromptTimeout"
        {...rowProps}
      >
        <LocalNumberInput
          id="exec-max-prompt-timeout"
          min={-1}
          value={exec.maxPromptTimeout}
          onCommit={(v) => onUpdate("execution.maxPromptTimeout", v)}
          parse={(v) => parseInt(v, 10) || -1}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        label="Script timeout (seconds)"
        id="exec-script-timeout"
        path="execution.scriptTimeout"
        {...rowProps}
      >
        <LocalNumberInput
          id="exec-script-timeout"
          min={1}
          value={exec.scriptTimeout}
          onCommit={(v) => onUpdate("execution.scriptTimeout", v)}
          parse={(v) => parseInt(v, 10) || 30}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingToggleRow
        label="Close terminal on completion"
        description="Automatically close the terminal when a workflow completes."
        checked={exec.closeTerminalOnComplete}
        onChange={(v) => onUpdate("execution.closeTerminalOnComplete", v)}
        path="execution.closeTerminalOnComplete"
        {...rowProps}
      />
      <SettingToggleRow
        label="Inject mode (interactive)"
        description={
          exec.closeTerminalOnComplete
            ? "Unavailable — inject mode requires keeping the terminal open. Disable 'Close terminal on completion' to enable this."
            : "Keep the TUI alive between prompts — faster and avoids the Claude Code resume cache bug."
        }
        checked={exec.injectMode ?? false}
        onChange={(v) => onUpdate("execution.injectMode", v)}
        disabled={exec.closeTerminalOnComplete}
        path="execution.injectMode"
        {...rowProps}
      />
    </div>
  );
}
