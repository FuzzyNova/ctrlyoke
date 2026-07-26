import type { IDashboardSink } from "../../types/IDashboardSink";
import type {
  ScriptProperties,
  ScriptRuntimeOutput,
  ScriptVerdict,
} from "../../types/CtrlYokeTypes";
import {
  FINAL_STEP_PHASES,
  SCRIPT_OUTPUT_SOURCES,
  STATUS_MESSAGE_SEVERITY,
  type CompareSource,
  type ConditionAction,
  type ExecutionPhase,
  type ScriptOutputSource,
  type StatusMessageSeverity,
} from "../../types/DashboardConstants";
import type { CliOutput } from "../../types/WebviewMessageTypes";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import { TIMELINE_ATTEMPT_KINDS } from "../../types/WorkflowTimelineTypes";
import type {
  EvaluationResult,
  EndConditionEvaluator,
} from "../EndConditionEvaluator";
import type {
  DefinitionRevisionContext,
  OutputHistoryManager,
  TimelineAttemptStartContext,
} from "./OutputHistoryManager";
import { sanitizeTerminalOutput } from "../../utils/TerminalOutputSanitizer";

export interface ScriptExecutionReporterContext {
  workspaceFolderPath?: string;
  historyFilePath?: string;
  dashboardProvider?: IDashboardSink;
  outputHistoryManager?: OutputHistoryManager;
  getDefinitionRevisionContext?: () => DefinitionRevisionContext | undefined;
  onStatusMessage?: (
    stepIndex: number,
    message: string,
    severity: string
  ) => void;
  onFinalStepStatusMessage?: (
    loopIndex: number,
    message: string,
    severity: string
  ) => void;
  captureCompletedOutput?: (stepIndex: number, output: CliOutput) => void;
  captureFinalStepCompletedOutput?: (
    loopIndex: number,
    output: CliOutput
  ) => void;
}

export interface ScriptExecutionReportRequest {
  context: ScriptExecutionReporterContext;
  source: ScriptOutputSource;
  properties: ScriptProperties & { compareSource: CompareSource };
  phase: ExecutionPhase;
  target: OutputExecutionTarget;
  signedStepIndex: number;
  runIndex: number;
  attemptIndex: number;
  timestampMs: number;
  onPass: ConditionAction;
  onFail: ConditionAction;
  actionDetail?: string | ((result: EvaluationResult) => string | undefined);
  statusLabel?: string;
  timeoutMs?: number;
  vars?: Record<string, string>;
  /** Conditions let their caller place the verdict summary beside the timeline row. */
  emitStatus?: boolean;
  evaluate?: (onOutput: (chunk: string) => void) => Promise<EvaluationResult>;
}

export function formatVerdictSummary(
  label: string,
  verdict: ScriptVerdict
): string {
  const comparison = verdict.error
    ? verdict.error
    : verdict.timedOut
      ? "timed out"
      : verdict.actualSource === "exitCode"
        ? `exit code ${verdict.actual}`
        : `${verdict.actualSource} ${
            verdict.outcome === "passed" ? "=" : "≠"
          } ${JSON.stringify(verdict.expected ?? "")}`;
  const action = verdict.actionDetail ?? verdict.action;
  return `${label} ${verdict.outcome} (${comparison}) → ${action}`;
}

export interface ScriptExecutionReport {
  evaluationResult: EvaluationResult;
  finalOutput: CliOutput;
  scriptRuntimeOutput: ScriptRuntimeOutput;
  verdict: ScriptVerdict;
  outputText: string;
}

/** Publishes every script execution through the ordered CLI output pipeline. */
export class ScriptExecutionReporter {
  constructor(private readonly evaluator: EndConditionEvaluator) {}

  async report(
    request: ScriptExecutionReportRequest
  ): Promise<ScriptExecutionReport> {
    const {
      context,
      source,
      properties,
      phase,
      target,
      signedStepIndex,
      runIndex,
      attemptIndex,
      timestampMs,
    } = request;
    const history = context.outputHistoryManager;
    const targetForHistory = target;
    const initOutput: CliOutput = {
      prompt: properties.script,
      response: "",
      elapsed: 0,
      isStreaming: true,
      source,
      timestampMs,
      cliCommand: properties.script,
      workingDirectory: context.workspaceFolderPath,
      attemptIndex,
      runIndex,
    };

    this.dispatchDashboardOutput(context, target, signedStepIndex, initOutput);
    if (context.historyFilePath && history) {
      await history.startStreamingExecutionOutput(
        context.historyFilePath,
        targetForHistory,
        initOutput,
        context.getDefinitionRevisionContext?.(),
        {
          kind: this.getAttemptKind(source),
          startReason: "initial",
          prompt: properties.script,
          phase,
        }
      );
    }

    const onOutput = (chunk: string): void => {
      const sanitizedChunk = sanitizeTerminalOutput(chunk);
      if (context.historyFilePath && history) {
        void history.appendStreamingChunk(
          context.historyFilePath,
          targetForHistory,
          runIndex,
          attemptIndex,
          sanitizedChunk,
          phase
        );
      }
      if (context.dashboardProvider) {
        if (target.kind === FINAL_STEP_PHASES.QUEUE && signedStepIndex >= 0) {
          context.dashboardProvider.updateCliStreamingChunk(
            signedStepIndex,
            chunk,
            phase
          );
        } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
          context.dashboardProvider.updateFinalStepStreamingChunk(
            target.loopIndex,
            chunk,
            phase
          );
        }
      }
    };

    const evaluationResult = request.evaluate
      ? await request.evaluate(onOutput)
      : await this.evaluator.evaluateCondition(
          properties,
          context.workspaceFolderPath,
          request.vars,
          onOutput
        );
    const outputText = sanitizeTerminalOutput(
      [evaluationResult.stdout, evaluationResult.stderr]
        .filter(Boolean)
        .join("\n")
        .trim()
    );
    const verdict = this.createVerdict(request, evaluationResult);
    const finalOutput: CliOutput = {
      ...initOutput,
      response: outputText,
      elapsed: evaluationResult.duration / 1000,
      isStreaming: false,
      exitCode: evaluationResult.exitCode ?? (evaluationResult.passed ? 0 : 1),
      scriptVerdict: verdict,
    };

    this.dispatchCompletedOutput(context, target, signedStepIndex, finalOutput);
    if (context.historyFilePath && history) {
      await history.saveExecutionOutput(
        context.historyFilePath,
        targetForHistory,
        [finalOutput],
        context.getDefinitionRevisionContext?.(),
        phase
      );
      await history.recordScriptExecution(
        context.historyFilePath,
        targetForHistory,
        runIndex,
        attemptIndex,
        {
          command: properties.script,
          stdout: evaluationResult.stdout,
          stderr: evaluationResult.stderr,
          exitCode: evaluationResult.exitCode,
        },
        context.getDefinitionRevisionContext?.(),
        phase
      );
    }

    if (request.emitStatus !== false) {
      await this.emitStatus(request, verdict);
    }

    return {
      evaluationResult,
      finalOutput,
      scriptRuntimeOutput: {
        command: properties.script,
        stdout: evaluationResult.stdout,
        stderr: evaluationResult.stderr,
        exitCode: evaluationResult.exitCode,
      },
      verdict,
      outputText,
    };
  }

  private createVerdict(
    request: ScriptExecutionReportRequest,
    result: EvaluationResult
  ): ScriptVerdict {
    return {
      compareSource: request.properties.compareSource,
      expected: request.properties.returns,
      actual: result.actual,
      actualSource: result.actualSource,
      exitCode: result.exitCode,
      outcome: result.errored ? "errored" : result.passed ? "passed" : "failed",
      matchRule: result.matchRule,
      action:
        result.errored || !result.passed ? request.onFail : request.onPass,
      actionDetail:
        typeof request.actionDetail === "function"
          ? request.actionDetail(result)
          : request.actionDetail,
      durationMs: result.duration,
      timedOut: result.timeout,
      error: result.error,
    };
  }

  private getAttemptKind(
    source: ScriptOutputSource
  ): TimelineAttemptStartContext["kind"] {
    return source === SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP
      ? TIMELINE_ATTEMPT_KINDS.SCRIPT
      : TIMELINE_ATTEMPT_KINDS.CONDITION;
  }

  private dispatchDashboardOutput(
    context: ScriptExecutionReporterContext,
    target: OutputExecutionTarget,
    signedStepIndex: number,
    output: CliOutput
  ): void {
    if (target.kind === FINAL_STEP_PHASES.QUEUE && signedStepIndex >= 0) {
      context.dashboardProvider?.updateCliOutput(signedStepIndex, output);
    } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      context.dashboardProvider?.updateFinalStepOutput(
        target.loopIndex,
        output
      );
    }
  }

  private dispatchCompletedOutput(
    context: ScriptExecutionReporterContext,
    target: OutputExecutionTarget,
    signedStepIndex: number,
    output: CliOutput
  ): void {
    this.dispatchDashboardOutput(context, target, signedStepIndex, output);
    if (target.kind === FINAL_STEP_PHASES.QUEUE && signedStepIndex >= 0) {
      context.captureCompletedOutput?.(signedStepIndex, output);
    } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      context.captureFinalStepCompletedOutput?.(target.loopIndex, output);
    }
  }

  private async emitStatus(
    request: ScriptExecutionReportRequest,
    verdict: ScriptVerdict
  ): Promise<void> {
    const { context, target } = request;
    const label = request.statusLabel ?? "Script";
    const outcome = verdict.outcome;
    const message = formatVerdictSummary(label, verdict);
    const severity: StatusMessageSeverity =
      outcome === "passed"
        ? STATUS_MESSAGE_SEVERITY.INFO
        : STATUS_MESSAGE_SEVERITY.ERROR;
    const signedStepIndex = request.signedStepIndex;

    context.dashboardProvider?.updateStatusMessage(
      signedStepIndex,
      message,
      severity
    );
    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      context.onStatusMessage?.(target.stepIndex, message, severity);
    } else {
      context.onFinalStepStatusMessage?.(target.loopIndex, message, severity);
    }

    if (context.historyFilePath && context.outputHistoryManager) {
      await context.outputHistoryManager
        .appendStatusMessage(context.historyFilePath, target, {
          message,
          severity,
          timestamp: Date.now(),
        })
        .catch(() => undefined);
    }
  }
}
