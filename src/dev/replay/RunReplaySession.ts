import * as fs from "fs";
import * as path from "path";
import {
  CTRLYOKE_DIR,
  EXECUTION_MODES,
  FINAL_STEP_PHASES,
  PROMPT_PROPERTIES,
} from "../../types/DashboardConstants";
import {
  readRunBundle,
  type LoadedRunBundle,
} from "../../core/orchestration/RunBundleReader";
import { Log } from "../../utils/Log";
import {
  buildReplayScript,
  capIdleGaps,
  replayTargetKey,
  type RecordedAiAttempt,
  type RecordedScript,
  type ReplayScript,
} from "./ReplayScript";

export interface RunReplayOptions {
  bundleDir: string;
  workspaceRoot: string;
  /** Multiplies recorded timing; 0 plays everything at once (the end state). */
  speed: number;
  /** Plays any recorded idle gap longer than this as this, before `speed` applies. */
  maxGapMs?: number;
  /** Holds playback before the recorded event with this sequence number. */
  pauseAtSequence?: number;
}

/** The authored workflow a replay runs is written here, under the workspace. */
const REPLAY_WORKFLOW_DIR = path.join(CTRLYOKE_DIR, "workflows");

/**
 * One replay: the bundle, the attempts and scripts not yet played, and the
 * workflow file materialized for it. Every integration and script runner the
 * engine creates while replay is armed draws from this one session, in order.
 */
export class RunReplaySession {
  readonly ready: Promise<void>;
  private script: ReplayScript = { attempts: new Map(), scripts: [] };
  private readonly played = new Map<string, number>();
  private workflowFilePath?: string;

  constructor(readonly options: RunReplayOptions) {
    this.ready = this.load();
    this.ready.catch((error: unknown) =>
      Log.error(`[RunReplay] cannot replay ${options.bundleDir}:`, error)
    );
  }

  get workspaceRoot(): string {
    return this.options.workspaceRoot;
  }

  get speed(): number {
    return this.options.speed;
  }

  /** The materialized workflow file, once `ready`. */
  get workflowFile(): string | undefined {
    return this.workflowFilePath;
  }

  isPausedAt(sequence: number): boolean {
    return (
      this.options.pauseAtSequence !== undefined &&
      sequence >= this.options.pauseAtSequence
    );
  }

  /**
   * The next unplayed attempt for the step at `promptIndex`; a final-step pass
   * has no queue recording of its own index, so it falls back to the final step's.
   */
  async takeAiAttempt(
    promptIndex: number
  ): Promise<RecordedAiAttempt | undefined> {
    await this.ready;
    const queueKey = replayTargetKey({
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: promptIndex,
    });
    const key = this.script.attempts.has(queueKey)
      ? queueKey
      : FINAL_STEP_PHASES.FINAL_STEP;
    const next = this.played.get(key) ?? 0;
    const attempt = this.script.attempts.get(key)?.[next];
    if (attempt) this.played.set(key, next + 1);
    return attempt;
  }

  /**
   * The next unplayed script whose recorded command appears in `argv`, or
   * failing that the next one in recorded order: a shell wraps the command
   * differently per platform.
   */
  async takeScript(
    argv: readonly string[]
  ): Promise<RecordedScript | undefined> {
    await this.ready;
    const invoked = normalizeCommand(argv.join(" "));
    const index = this.script.scripts.findIndex((script) =>
      invoked.includes(normalizeCommand(script.command))
    );
    return this.script.scripts.splice(Math.max(index, 0), 1)[0];
  }

  private async load(): Promise<void> {
    const bundle = await readRunBundle(
      this.options.bundleDir,
      this.options.workspaceRoot
    );
    const recorded = buildReplayScript(bundle.events);
    const { maxGapMs } = this.options;
    this.script =
      maxGapMs !== undefined ? capIdleGaps(recorded, maxGapMs) : recorded;
    this.workflowFilePath = await materializeWorkflow(
      bundle,
      this.options.workspaceRoot
    );
    Log.info(
      `[RunReplay] armed ${bundle.manifest.lineage.workflowName} from ${bundle.bundleDir} ` +
        `at speed ${this.options.speed}` +
        (maxGapMs !== undefined ? `, idle gaps capped at ${maxGapMs} ms` : "") +
        `; run ${this.workflowFilePath}`
    );
  }
}

function normalizeCommand(command: string): string {
  return command.replace(/["']/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Writes the bundle's workflow into the workspace with the recorded
 * workflow's name as its root `name` (and file name), so the dashboard shows
 * that name; bundles exported before workflow files had a `name` carry it
 * only in the lineage. Every step runs headless: a replay has output events
 * to show, not a terminal to attach.
 */
async function materializeWorkflow(
  bundle: LoadedRunBundle,
  workspaceRoot: string
): Promise<string> {
  const headless = (step: unknown): unknown =>
    step && typeof step === "object" && PROMPT_PROPERTIES.EXECUTION_MODE in step
      ? {
          ...step,
          [PROMPT_PROPERTIES.EXECUTION_MODE]: EXECUTION_MODES.HEADLESS,
        }
      : step;
  const definition = bundle.definition;
  const steps = Array.isArray(definition.steps)
    ? definition.steps.map((step: unknown) => {
        const group = step as { parallel?: unknown[] };
        return Array.isArray(group.parallel)
          ? { ...group, parallel: group.parallel.map(headless) }
          : headless(step);
      })
    : definition.steps;
  const workflow = {
    ...definition,
    [PROMPT_PROPERTIES.NAME]: bundle.manifest.lineage.workflowName,
    [PROMPT_PROPERTIES.EXECUTION_MODE]: EXECUTION_MODES.HEADLESS,
    ...(steps !== undefined ? { steps } : {}),
    ...(definition.finalStep
      ? { finalStep: headless(definition.finalStep) }
      : {}),
  };
  const slug =
    bundle.manifest.lineage.workflowName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "replay";
  const filePath = path.join(
    workspaceRoot,
    REPLAY_WORKFLOW_DIR,
    `${slug}.ctrlyoke.json`
  );
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(
    filePath,
    `${JSON.stringify(workflow, null, 2)}\n`,
    "utf8"
  );
  return filePath;
}
