import type { WorkflowStep, CliOutput } from "@store/workflowStore";
import { useSettingsStore } from "@store/settingsStore";
import { buildAttemptTokenTooltipLines } from "@root/utils/TokenFormatting";
import type { PriorContext } from "@root/types/CtrlYokeTypes";
import { formatPriorContextLabel } from "@utils/priorContext";
import { isScriptWorkflowStep } from "./stepClipboard";

/** Runtime metadata carried on a step (`step._runtime`), used before a full CliOutput exists. */
export interface StepRuntimeMetaSnapshot {
  sessionId?: string;
  harness?: string;
  elapsed?: number;
  contextWindowUsed?: number;
  contextWindowSize?: number;
}

export interface StepSessionDetails {
  sessionId?: string;
  harness?: string;
  model?: string;
}

/** Resolve the concrete session and the harness that owns that session. */
export function getStepSessionDetails(
  step: WorkflowStep,
  latestOutput: CliOutput | null | undefined,
  runtimeMeta: StepRuntimeMetaSnapshot | null | undefined
): StepSessionDetails {
  const outputSessionId = latestOutput?.structured?.metadata?.sessionId;
  if (typeof outputSessionId === "string" && outputSessionId.length > 0) {
    return {
      sessionId: outputSessionId,
      harness: latestOutput?.structured?.metadata?.harness,
      model: latestOutput?.structured?.metadata?.model,
    };
  }

  const runtimeSessionId = runtimeMeta?.sessionId;
  if (typeof runtimeSessionId === "string" && runtimeSessionId.length > 0) {
    return {
      sessionId: runtimeSessionId,
      harness: runtimeMeta?.harness ?? step._runtime?.harness,
    };
  }

  const stepSessionId = step._runtime?.sessionId;
  if (typeof stepSessionId === "string" && stepSessionId.length > 0) {
    return { sessionId: stepSessionId, harness: step._runtime?.harness };
  }

  return {};
}

/** Resolve the concrete session this step used, preferring its latest output. */
export function getStepSessionId(
  step: WorkflowStep,
  latestOutput: CliOutput | null | undefined,
  runtimeMeta: StepRuntimeMetaSnapshot | null | undefined
): string | undefined {
  return getStepSessionDetails(step, latestOutput, runtimeMeta).sessionId;
}

export interface StepMetadataClipboardInput {
  step: WorkflowStep;
  /** 1-based display position, used only for the header line (ignored when `isFinalStep`). */
  slotNumber?: number;
  /** True for the workflow's final step, which has no queue position. */
  isFinalStep?: boolean;
  latestOutput?: CliOutput | null;
  runtimeMeta?: StepRuntimeMetaSnapshot;
  /** Live context-window telemetry while this step is the one currently running. */
  liveContextWindow?: { used: number; size: number };
}

function fmtBool(v: unknown): string {
  return v ? "true" : "false";
}

function fmtString(v: unknown): string {
  return typeof v === "string" && v.length > 0 ? v : "(none)";
}

function fmtStringArray(v: unknown): string {
  return Array.isArray(v) && v.length > 0 ? v.join(", ") : "(none)";
}

function fmtMcpServers(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return "(none)";
  return v
    .map((s) =>
      typeof s === "string" ? s : ((s as { id?: string })?.id ?? "custom")
    )
    .join(", ");
}

function fmtHooks(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return "(none)";
  return `${v.length} hook${v.length === 1 ? "" : "s"}`;
}

function fmtToolPermissions(v: unknown): string {
  const tp = v as
    | { mode?: string; allowedTools?: string[]; deniedTools?: string[] }
    | undefined;
  if (!tp?.mode) return "(none)";
  const parts = [tp.mode];
  if (tp.allowedTools?.length)
    parts.push(`allow: ${tp.allowedTools.join(", ")}`);
  if (tp.deniedTools?.length) parts.push(`deny: ${tp.deniedTools.join(", ")}`);
  return parts.join(" | ");
}

function fmtScriptCondition(v: unknown): string {
  const c = v as { script?: string } | undefined;
  return c?.script ? c.script : "(none)";
}

function fmtErrorBehavior(v: unknown): string {
  const eb = v as
    | { onError?: string; maxRetries?: number; retryDelaySec?: number }
    | undefined;
  if (!eb?.onError) return "(none)";
  const parts = [eb.onError];
  if (eb.maxRetries !== undefined) parts.push(`maxRetries=${eb.maxRetries}`);
  if (eb.retryDelaySec !== undefined)
    parts.push(`retryDelaySec=${eb.retryDelaySec}`);
  return parts.join(", ");
}

/**
 * One `label: value` line for a tri-state execution property (undefined =
 * inherit, null = explicitly disabled, value = step-level override) —
 * mirrors the tri-state semantics documented in
 * webview-react-components.instructions.md.
 */
function resolvedLine(
  label: string,
  stepValue: unknown,
  effectiveValue: unknown,
  format: (v: unknown) => string
): string {
  if (stepValue === null) {
    return `${label}: (none) — explicitly disabled`;
  }
  if (stepValue !== undefined) {
    return `${label}: ${format(stepValue)}`;
  }
  return `${label}: ${format(effectiveValue)} (inherited)`;
}

/**
 * Builds plain-text "Copy Metadata" clipboard content for a step: its
 * resolved execution properties (step → workflow → global precedence, same
 * as the properties drawer), the actual runtime session ID, and the same
 * context-window/token/cost figures shown in the step's hover tooltip
 * (`WorkflowStep.tsx`'s `tokenTooltip`) — that tooltip has no way to be
 * copied on its own, which is the main reason this action exists. Reads
 * settings via `getState()` since it only needs a point-in-time snapshot at
 * the moment the menu item is invoked.
 */
export function buildStepMetadataClipboardText({
  step,
  slotNumber,
  isFinalStep = false,
  latestOutput,
  runtimeMeta,
  liveContextWindow,
}: StepMetadataClipboardInput): string {
  const {
    workflowProperties,
    globalSettings,
    fullGlobalSettings,
    getEffectiveHarness,
    getEffectiveModel,
    getEffectiveExecutionMode,
    getEffectiveAgent,
    getEffectiveResumeSession,
    getEffectiveMcpServers,
    getEffectiveHooks,
    getEffectivePriorContext,
    getEffectiveAdditionalArgs,
    getEffectiveToolPermissions,
    getEffectiveSkills,
    getEffectiveSecrets,
  } = useSettingsStore.getState();

  const isScript = isScriptWorkflowStep(step);
  const stepKind = isScript ? "Script" : "Prompt";
  const headerLabel = isFinalStep
    ? `Final ${stepKind.toLowerCase()} step`
    : `${stepKind} step ${slotNumber}`;
  const lines: string[] = [
    `${headerLabel}${step.name ? `: ${step.name}` : ""}`,
    "",
    "Execution properties:",
    resolvedLine(
      "executionMode",
      step.executionMode,
      getEffectiveExecutionMode(),
      fmtString
    ),
  ];

  if (!isScript) {
    lines.push(
      resolvedLine("harness", step.harness, getEffectiveHarness(), fmtString),
      resolvedLine("model", step.model, getEffectiveModel(), fmtString),
      resolvedLine("agent", step.agent, getEffectiveAgent(), fmtString),
      resolvedLine("skills", step.skills, getEffectiveSkills(), fmtStringArray),
      resolvedLine(
        "secrets",
        step.secrets,
        getEffectiveSecrets(),
        fmtStringArray
      ),
      resolvedLine(
        "resumeSession",
        step.resumeSession,
        getEffectiveResumeSession(),
        fmtBool
      )
    );
    if (
      step.sessionId !== undefined ||
      workflowProperties.sessionId !== undefined
    ) {
      lines.push(
        resolvedLine(
          "sessionId (resume target)",
          step.sessionId,
          workflowProperties.sessionId,
          (v) => String(v)
        )
      );
    }
    lines.push(
      resolvedLine(
        "mcpServers",
        step.mcpServers,
        getEffectiveMcpServers(),
        fmtMcpServers
      ),
      resolvedLine("hooks", step.hooks, getEffectiveHooks(), fmtHooks),
      resolvedLine(
        "priorContext",
        step.priorContext,
        getEffectivePriorContext(),
        (value) => {
          if (value === null || value === undefined) return "(none)";
          return typeof value === "string" && value.length === 0
            ? "(none)"
            : formatPriorContextLabel(value as PriorContext);
        }
      ),
      resolvedLine(
        "additionalArgs",
        step.additionalArgs,
        getEffectiveAdditionalArgs(),
        fmtString
      ),
      resolvedLine(
        "toolPermissions",
        step.toolPermissions,
        getEffectiveToolPermissions(),
        fmtToolPermissions
      ),
      resolvedLine(
        "endCondition",
        step.endCondition,
        workflowProperties.endCondition ?? globalSettings.defaultEndCondition,
        fmtScriptCondition
      ),
      resolvedLine(
        "preCondition",
        step.preCondition,
        workflowProperties.preCondition ?? globalSettings.defaultPreCondition,
        fmtScriptCondition
      )
    );
  }

  lines.push(
    resolvedLine(
      "errorBehavior",
      step.errorBehavior,
      workflowProperties.errorBehavior ?? globalSettings.defaultErrorBehavior,
      fmtErrorBehavior
    )
  );

  const sessionId = getStepSessionId(step, latestOutput, runtimeMeta);
  const elapsed = latestOutput?.elapsed ?? runtimeMeta?.elapsed;
  const runtimeLines: string[] = [];
  if (sessionId) runtimeLines.push(`Session ID: ${sessionId}`);
  if (elapsed !== undefined)
    runtimeLines.push(`Duration: ${elapsed.toFixed(1)}s`);

  const completedContext = latestOutput?.tokens?.contextWindowSize
    ? {
        used: latestOutput.tokens.contextWindowUsed ?? 0,
        size: latestOutput.tokens.contextWindowSize,
      }
    : runtimeMeta?.contextWindowSize
      ? {
          used: runtimeMeta.contextWindowUsed ?? 0,
          size: runtimeMeta.contextWindowSize,
        }
      : undefined;
  const contextWindow = completedContext ?? liveContextWindow;
  const showCostEstimates =
    fullGlobalSettings?.settings.ui.showCostEstimates !== false;
  runtimeLines.push(
    ...buildAttemptTokenTooltipLines({
      contextWindow,
      harness: latestOutput?.structured?.metadata.harness,
      attemptTokens: latestOutput?.tokens,
      showCostEstimates,
    })
  );

  if (runtimeLines.length > 0) {
    lines.push("", "Runtime:", ...runtimeLines);
  }

  return lines.join("\n");
}
