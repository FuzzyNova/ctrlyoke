import * as assert from "assert";
import {
  isExecutionStep,
  isPromptStep,
  isScriptStep,
  type PromptRuntimeMetadata,
  type PromptStep,
  type ScriptStep,
  type WorkflowStep,
} from "../../types/CtrlYokeTypes";

/** Assert the authored kind before a test reads prompt-only properties. */
export function asPromptStep(step: WorkflowStep): PromptStep {
  assert.ok(isPromptStep(step), "expected a prompt step");
  return step;
}

/** Assert the authored kind before a test reads script-only properties. */
export function asScriptStep(step: WorkflowStep): ScriptStep {
  assert.ok(isScriptStep(step), "expected a script step");
  return step;
}

/** Assert that the step has the shared prompt/script execution contract. */
export function asExecutionStep(step: WorkflowStep): PromptStep | ScriptStep {
  if (isPromptStep(step)) return step;
  assert.ok(isExecutionStep(step), "expected an execution step");
  return step;
}

/** Read execution metadata when present, preserving optional-step semantics. */
export function executionRuntime(
  step: WorkflowStep | undefined
): PromptRuntimeMetadata | undefined {
  if (!step) return undefined;
  return asExecutionStep(step)._runtime;
}

/** Read the displayed command/prompt after proving this is an execution step. */
export function executionStepText(step: WorkflowStep): string {
  if (isPromptStep(step)) return step.prompt;
  return asScriptStep(step).script;
}
