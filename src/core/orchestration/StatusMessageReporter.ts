import type { IDashboardSink } from "../../types/IDashboardSink";
import {
  FINAL_STEP_PHASES,
  type StatusMessageSeverity,
} from "../../types/DashboardConstants";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import type { StatusMessage } from "../../types/WebviewMessageTypes";
import type { OutputHistoryManager } from "./OutputHistoryManager";
import { Log } from "../../utils/Log";

export interface WorkflowEventTarget {
  kind: typeof FINAL_STEP_PHASES.QUEUE | typeof FINAL_STEP_PHASES.FINAL_STEP;
  stepIndex?: number;
  loopIndex?: number;
}

export interface StatusMessageReportOptions {
  timestampMs?: number;
  /** Live push fires at most once per key until resetDedupeState(). */
  liveDedupeKey?: string;
  /** Persisted write fires at most once per key while a history sink is active. */
  persistDedupeKey?: string;
}

export function toOutputExecutionTarget(
  target: WorkflowEventTarget
): OutputExecutionTarget {
  if (
    target.kind === FINAL_STEP_PHASES.QUEUE &&
    target.stepIndex !== undefined
  ) {
    return {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: target.stepIndex,
    };
  }

  if (
    target.kind === FINAL_STEP_PHASES.FINAL_STEP &&
    target.loopIndex !== undefined
  ) {
    return {
      kind: FINAL_STEP_PHASES.FINAL_STEP,
      loopIndex: target.loopIndex,
    };
  }

  throw new Error(`Invalid workflow event target: ${target.kind}`);
}

export function getSignedStepIndex(target: WorkflowEventTarget): number {
  if (
    target.kind === FINAL_STEP_PHASES.QUEUE &&
    target.stepIndex !== undefined
  ) {
    return target.stepIndex;
  }

  if (
    target.kind === FINAL_STEP_PHASES.FINAL_STEP &&
    target.loopIndex !== undefined
  ) {
    return -(target.loopIndex + 1);
  }

  throw new Error(`Invalid workflow event target: ${target.kind}`);
}

export class StatusMessageReporter {
  private readonly liveDedupeKeys = new Set<string>();
  private readonly persistDedupeKeys = new Set<string>();

  constructor(
    private readonly getDashboard: () => IDashboardSink | undefined,
    private readonly getActiveHistorySink: () =>
      { filePath: string; manager: OutputHistoryManager } | undefined,
    private readonly notifyStatusMessage?: (
      target: WorkflowEventTarget,
      message: string,
      severity: StatusMessageSeverity
    ) => void,
    private readonly getWorkflowId?: () => string | undefined
  ) {}

  report(
    target: WorkflowEventTarget,
    message: string,
    severity: StatusMessageSeverity,
    options?: StatusMessageReportOptions
  ): void {
    const timestampMs = options?.timestampMs ?? Date.now();
    const signedStepIndex = getSignedStepIndex(target);
    const liveShouldFire = this.shouldFire(
      this.liveDedupeKeys,
      options?.liveDedupeKey
    );

    if (liveShouldFire) {
      this.getDashboard()?.updateStatusMessage(
        signedStepIndex,
        message,
        severity,
        this.getWorkflowId?.(),
        timestampMs
      );
      this.notifyStatusMessage?.(target, message, severity);
    }

    const historySink = this.getActiveHistorySink();
    if (
      historySink &&
      this.shouldFire(this.persistDedupeKeys, options?.persistDedupeKey)
    ) {
      const statusMessage: StatusMessage = {
        message,
        severity,
        timestamp: timestampMs,
      };

      try {
        void historySink.manager
          .appendStatusMessage(
            historySink.filePath,
            toOutputExecutionTarget(target),
            statusMessage
          )
          .catch((error: unknown) =>
            Log.warn(
              "[StatusMessageReporter] Failed to append status message to history:",
              error
            )
          );
      } catch (error) {
        Log.warn(
          "[StatusMessageReporter] Failed to append status message to history:",
          error
        );
      }
    }
  }

  resetDedupeState(preserveLiveDedupeKeys: readonly string[] = []): void {
    this.liveDedupeKeys.clear();
    this.persistDedupeKeys.clear();
    for (const key of preserveLiveDedupeKeys) {
      this.liveDedupeKeys.add(key);
    }
  }

  private shouldFire(
    dedupeKeys: Set<string>,
    dedupeKey: string | undefined
  ): boolean {
    if (dedupeKey === undefined) {
      return true;
    }
    if (dedupeKeys.has(dedupeKey)) {
      return false;
    }
    dedupeKeys.add(dedupeKey);
    return true;
  }
}
