import {
  HARNESS_IDS,
  WORKFLOW_TOKEN_COVERAGE,
  type HarnessId,
} from "../../types/DashboardConstants";
import type { CliOutput, TokenStats } from "../../types/WebviewMessageTypes";
import type {
  WorkflowHarnessTokenTotals,
  WorkflowTokenTotals,
} from "../../types/CtrlYokeTypes";
import { getCliEntryKey } from "./OutputHistoryTimelineAdapter";
import {
  TIMELINE_ATTEMPT_KINDS,
  TIMELINE_EVENT_TYPES,
  type AttemptStartedEvent,
  type CliOutputRecordedEvent,
  type WorkflowTimelineEvent,
} from "../../types/WorkflowTimelineTypes";

export interface WorkflowTokenTotalsReducerOptions {
  workflowId?: string;
  runId?: number;
  isFinal?: boolean;
}

interface AttemptRecord {
  start: AttemptStartedEvent;
  output?: CliOutputRecordedEvent;
}

interface MutableHarnessTotals {
  input: number;
  output: number;
  cachedInput?: number;
  cacheCreated?: number;
  reasoningOutput?: number;
  total: number;
  reportedAttemptCount: number;
  attemptCount: number;
  incomplete: boolean;
}

interface ReducerScope {
  workflowId?: string;
  runId?: number;
}

const HARNESS_ID_SET = new Set<HarnessId>(Object.values(HARNESS_IDS));

/**
 * Pure, run-scoped aggregation of normalized timeline events.
 *
 * The reducer retains only the attempt start and the newest output snapshot
 * for each canonical CLI entry key. That makes it safe to hydrate from a
 * complete timeline and then append the same aggregate output events that are
 * written during normal execution.
 */
export class WorkflowTokenTotalsReducer {
  private readonly scope: ReducerScope;
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly outputSnapshots = new Map<string, CliOutputRecordedEvent>();
  private isFinal: boolean;

  constructor(options: WorkflowTokenTotalsReducerOptions | number = {}) {
    this.scope =
      typeof options === "number" ? { runId: options } : { ...options };
    this.isFinal =
      typeof options === "number" ? false : (options.isFinal ?? false);
  }

  /** Replace all reducer state with a fresh reduction of the supplied events. */
  reduce(
    events: readonly WorkflowTimelineEvent[],
    options: Pick<WorkflowTokenTotalsReducerOptions, "isFinal"> = {}
  ): WorkflowTokenTotals | undefined {
    this.attempts.clear();
    this.outputSnapshots.clear();
    this.isFinal = options.isFinal ?? false;
    this.appendEvents(events);
    if (options.isFinal !== undefined) {
      this.isFinal = options.isFinal;
    }
    return this.snapshot();
  }

  /** Apply an incremental timeline batch and return the current projection. */
  appendEvents(
    events: readonly WorkflowTimelineEvent[],
    options: Pick<WorkflowTokenTotalsReducerOptions, "isFinal"> = {}
  ): WorkflowTokenTotals | undefined {
    for (const event of events) {
      if (!this.belongsToScope(event)) {
        continue;
      }

      if (event.eventType === TIMELINE_EVENT_TYPES.ATTEMPT_STARTED) {
        this.recordAttemptStart(event);
      } else if (event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED) {
        this.recordOutputSnapshot(event);
      } else if (event.eventType === TIMELINE_EVENT_TYPES.RUN_TERMINATED) {
        this.isFinal = true;
      }
    }
    if (options.isFinal !== undefined) {
      this.isFinal = options.isFinal;
    }
    return this.snapshot();
  }

  /** Change terminality without changing any accumulated attempt data. */
  setFinal(isFinal: boolean): WorkflowTokenTotals | undefined {
    this.isFinal = isFinal;
    return this.snapshot();
  }

  snapshot(): WorkflowTokenTotals | undefined {
    const aiAttempts = [...this.attempts.values()].filter(
      ({ start }) => start.payload.kind === TIMELINE_ATTEMPT_KINDS.AI
    );
    const byHarness = new Map<HarnessId, MutableHarnessTotals>();
    const byLocalDay = new Map<string, Map<HarnessId, MutableHarnessTotals>>();
    let total = 0;
    let reportedAttemptCount = 0;
    let incomplete = false;

    for (const attempt of aiAttempts) {
      const output = attempt.output?.payload.cliOutput;
      const tokens = output?.tokens;
      const observedTotal = tokens?.total;
      const hasUsableTotal = isUsableTotal(observedTotal);
      if (hasUsableTotal) {
        total += observedTotal;
        reportedAttemptCount += 1;
      } else {
        incomplete = true;
      }

      const harness = getHarness(output);
      if (!harness) {
        // Attribution is deliberately never inferred from workflow settings.
        incomplete = true;
        continue;
      }

      const harnessTotals = getOrCreateHarnessTotals(byHarness, harness);
      addAttempt(harnessTotals, tokens, hasUsableTotal);

      const localDay = getLocalDay(
        attempt.start.timestampMs,
        output?.timestampMs
      );
      if (localDay) {
        const dayTotals = byLocalDay.get(localDay) ?? new Map();
        byLocalDay.set(localDay, dayTotals);
        addAttempt(
          getOrCreateHarnessTotals(dayTotals, harness),
          tokens,
          hasUsableTotal
        );
      }
    }

    if (reportedAttemptCount === 0) {
      return undefined;
    }

    return {
      total,
      coverage: incomplete
        ? WORKFLOW_TOKEN_COVERAGE.PARTIAL
        : WORKFLOW_TOKEN_COVERAGE.COMPLETE,
      reportedAttemptCount,
      attemptCount: aiAttempts.length,
      isFinal: this.isFinal,
      byHarness: materializeHarnessTotals(byHarness),
      byLocalDay: materializeLocalDayTotals(byLocalDay),
    };
  }

  private belongsToScope(event: WorkflowTimelineEvent): boolean {
    // A reducer normally receives a manifest scope in its constructor. When a
    // caller omits it, the first event establishes the scope so a mixed-run
    // recovery batch cannot silently bleed into the aggregate.
    this.scope.workflowId ??= event.workflowId;
    this.scope.runId ??= event.runId;
    if (
      this.scope.workflowId !== undefined &&
      event.workflowId !== this.scope.workflowId
    ) {
      return false;
    }
    if (this.scope.runId !== undefined && event.runId !== this.scope.runId) {
      return false;
    }
    return true;
  }

  private recordAttemptStart(event: AttemptStartedEvent): void {
    const key = getCliEntryKey(
      event.target,
      event.runIndex,
      event.attemptIndex,
      event.phase
    );
    const existing = this.attempts.get(key);
    if (!existing || event.sequence < existing.start.sequence) {
      this.attempts.set(key, {
        start: event,
        output: this.outputSnapshots.get(key),
      });
    }
  }

  private recordOutputSnapshot(event: CliOutputRecordedEvent): void {
    const key = getCliEntryKey(
      event.target,
      event.runIndex ?? 0,
      event.attemptIndex,
      event.phase
    );
    const existing = this.outputSnapshots.get(key);
    if (!existing || event.sequence >= existing.sequence) {
      this.outputSnapshots.set(key, event);
      const attempt = this.attempts.get(key);
      if (attempt) {
        attempt.output = event;
      }
    }
  }
}

function isUsableTotal(total: number | undefined): total is number {
  return total !== undefined && Number.isFinite(total) && total >= 0;
}

function getHarness(output: CliOutput | undefined): HarnessId | undefined {
  const harness = output?.structured?.metadata.harness;
  return typeof harness === "string" && HARNESS_ID_SET.has(harness as HarnessId)
    ? (harness as HarnessId)
    : undefined;
}

function getLocalDay(
  startTimestampMs: number,
  outputTimestampMs: number | undefined
): string | undefined {
  const timestampMs = Number.isFinite(startTimestampMs)
    ? startTimestampMs
    : outputTimestampMs;
  if (timestampMs === undefined || !Number.isFinite(timestampMs)) {
    return undefined;
  }
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join("-");
}

function getOrCreateHarnessTotals(
  totals: Map<HarnessId, MutableHarnessTotals>,
  harness: HarnessId
): MutableHarnessTotals {
  const existing = totals.get(harness);
  if (existing) {
    return existing;
  }
  const created: MutableHarnessTotals = {
    input: 0,
    output: 0,
    total: 0,
    reportedAttemptCount: 0,
    attemptCount: 0,
    incomplete: false,
  };
  totals.set(harness, created);
  return created;
}

function addAttempt(
  aggregate: MutableHarnessTotals,
  tokens: TokenStats | undefined,
  hasUsableTotal: boolean
): void {
  aggregate.attemptCount += 1;
  if (!hasUsableTotal || !tokens) {
    aggregate.incomplete = true;
    return;
  }

  const total = tokens.total;
  if (!isUsableTotal(total)) {
    aggregate.incomplete = true;
    return;
  }

  aggregate.reportedAttemptCount += 1;
  aggregate.total += total;
  aggregate.input += finiteOrZero(tokens.prompt);
  aggregate.output += finiteOrZero(tokens.completion);
  addOptional(aggregate, "cachedInput", tokens.cached);
  addOptional(aggregate, "cacheCreated", tokens.cacheCreated);
  addOptional(aggregate, "reasoningOutput", tokens.reasoning);
}

function finiteOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function addOptional(
  aggregate: MutableHarnessTotals,
  field: "cachedInput" | "cacheCreated" | "reasoningOutput",
  value: number | undefined
): void {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return;
  }
  aggregate[field] = (aggregate[field] ?? 0) + value;
}

function materializeHarnessTotals(
  totals: Map<HarnessId, MutableHarnessTotals>
): Partial<Record<HarnessId, WorkflowHarnessTokenTotals>> {
  const result: Partial<Record<HarnessId, WorkflowHarnessTokenTotals>> = {};
  for (const [harness, aggregate] of totals) {
    if (aggregate.reportedAttemptCount === 0) {
      continue;
    }
    result[harness] = materializeHarnessTotal(aggregate);
  }
  return result;
}

function materializeLocalDayTotals(
  totals: Map<string, Map<HarnessId, MutableHarnessTotals>>
): Record<string, Partial<Record<HarnessId, WorkflowHarnessTokenTotals>>> {
  const result: Record<
    string,
    Partial<Record<HarnessId, WorkflowHarnessTokenTotals>>
  > = {};
  for (const day of [...totals.keys()].sort()) {
    const dayTotals = materializeHarnessTotals(
      totals.get(day) as Map<HarnessId, MutableHarnessTotals>
    );
    if (Object.keys(dayTotals).length > 0) {
      result[day] = dayTotals;
    }
  }
  return result;
}

function materializeHarnessTotal(
  aggregate: MutableHarnessTotals
): WorkflowHarnessTokenTotals {
  return {
    input: aggregate.input,
    output: aggregate.output,
    ...(aggregate.cachedInput === undefined
      ? {}
      : { cachedInput: aggregate.cachedInput }),
    ...(aggregate.cacheCreated === undefined
      ? {}
      : { cacheCreated: aggregate.cacheCreated }),
    ...(aggregate.reasoningOutput === undefined
      ? {}
      : { reasoningOutput: aggregate.reasoningOutput }),
    total: aggregate.total,
    coverage: aggregate.incomplete
      ? WORKFLOW_TOKEN_COVERAGE.PARTIAL
      : WORKFLOW_TOKEN_COVERAGE.COMPLETE,
    reportedAttemptCount: aggregate.reportedAttemptCount,
    attemptCount: aggregate.attemptCount,
  };
}
