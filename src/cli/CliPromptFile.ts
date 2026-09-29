import * as path from "node:path";
import { PromptFileParser } from "../core/PromptFileParser";
import {
  isScriptStep,
  type ParsedPromptFile,
  type WorkflowStep,
} from "../types/CtrlYokeTypes";
import type { PlatformAdapter } from "../platform/PlatformAdapter";
import type { UserFeedbackSink } from "../core/UserFeedbackSink";
import type { HarnessId } from "../types/DashboardConstants";

/** Parse a CLI-authored workflow source and preserve its useful failure reason. */
export async function parseCliPromptFile(
  file: string,
  platform?: PlatformAdapter,
  userFeedbackSink?: UserFeedbackSink
): Promise<ParsedPromptFile> {
  const parser = new PromptFileParser(platform, userFeedbackSink);
  const parsed = await parser.parsePromptFile(path.resolve(file));
  if (parsed) return parsed;
  throw new Error(
    parser.lastNewerSchemaError?.message ??
      parser.lastParseError?.message ??
      `Failed to load workflow file: ${file}`
  );
}

/** Apply append flags to prompt steps that do not declare their own value. */
export function applyCliAppendOverrides(
  steps: readonly WorkflowStep[],
  harness?: HarnessId,
  model?: string
): WorkflowStep[] {
  return steps.map((step) => {
    if (isScriptStep(step)) return step;
    return {
      ...step,
      ...(step.harness === undefined && harness ? { harness } : {}),
      ...(step.model === undefined && model ? { model } : {}),
    };
  });
}
