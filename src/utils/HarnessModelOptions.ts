import { HARNESS_IDS, MODEL_OPTION_VALUES } from "../types/DashboardConstants";
import type { CapabilitiesModel } from "../types/CapabilitiesTypes";
import {
  getCliSupportedModelIdsSync,
  getOpenCodeModelIdsSync,
  getQwenModelIdsSync,
  getAntigravityModelIdsSync,
  getAntigravityModelLabelSync,
} from "./ModelRegistry";
import {
  getModelDisplayName,
  CLAUDE_CLI_MODEL_LABELS,
  CODEX_CLI_MODEL_LABELS,
  ANTIGRAVITY_CLI_MODEL_LABELS,
} from "./ModelConstants";

/**
 * Model options for every harness, `None` first. The dashboard's model
 * pickers and VS Code's workflow-file `model` completions read this one list.
 */
export function buildHarnessModelOptions(): Record<string, CapabilitiesModel[]> {
  const cliModelIds = getCliSupportedModelIdsSync();
  const hiddenModels = new Set(["copilot-fast"]);

  const noneOption = { value: MODEL_OPTION_VALUES.NONE, label: "None" };

  const copilotCliOptions = [
    noneOption,
    ...cliModelIds
      .filter((id) => !hiddenModels.has(id))
      .map((id) => ({
        value: id,
        label: getModelDisplayName(id),
      })),
  ];

  const claudeCliOptions = [
    noneOption,
    ...Object.entries(CLAUDE_CLI_MODEL_LABELS).map(([value, label]) => ({
      value,
      label,
    })),
  ];

  const codexCliOptions = [
    noneOption,
    ...Object.entries(CODEX_CLI_MODEL_LABELS).map(([value, label]) => ({
      value,
      label,
    })),
  ];

  const openCodeCliOptions = [
    noneOption,
    ...getOpenCodeModelIdsSync().map((id) => ({
      value: id,
      label: id,
    })),
  ];

  const qwenCliOptions = [
    noneOption,
    ...getQwenModelIdsSync().map((id) => ({
      value: id,
      label: id,
    })),
  ];

  const antigravityCliOptions = [
    noneOption,
    ...getAntigravityModelIdsSync().map((id) => ({
      value: id,
      label:
        getAntigravityModelLabelSync(id) ??
        ANTIGRAVITY_CLI_MODEL_LABELS[id] ??
        id,
    })),
  ];

  return {
    [HARNESS_IDS.COPILOT_CLI]: copilotCliOptions,
    [HARNESS_IDS.CLAUDE_CLI]: claudeCliOptions,
    [HARNESS_IDS.CODEX_CLI]: codexCliOptions,
    [HARNESS_IDS.OPENCODE_CLI]: openCodeCliOptions,
    [HARNESS_IDS.QWEN_CLI]: qwenCliOptions,
    [HARNESS_IDS.ANTIGRAVITY_CLI]: antigravityCliOptions,
  };
}
