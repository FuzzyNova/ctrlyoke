/**
 * Real-harness contract for foreground subagent output attribution.
 * Run only with `npm run test:harness` and authenticated harness CLIs.
 */

import * as assert from "assert";
import type { PromptFile } from "../../types/CtrlYokeTypes";
import type { ToolCall } from "../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import {
  HARNESS_MODELS,
  HARNESS_TIMEOUT_MS,
  findRunFiles,
  isolateRunState,
  logAndMaybeSkip,
  readRecordedCliEvents,
  runWorkflowFile,
  runsRootFor,
  type HarnessId,
} from "./helpers/harnessRunner";

const HARNESSES: HarnessId[] = [
  "copilot-cli",
  "claude-cli",
  "codex-cli",
  "opencode-cli",
  "qwen-cli",
  "antigravity-cli",
];

suite("Foreground subagent attribution harness tests", function () {
  this.timeout(HARNESS_TIMEOUT_MS);

  let tmpDir: string;
  let restoreState: (() => void) | undefined;

  setup(function () {
    tmpDir = makeTempDir("cy-subagent-test-");
    restoreState = isolateRunState(tmpDir);
  });

  teardown(function () {
    restoreState?.();
    removeTempDir(tmpDir, (dir) =>
      console.log(`  ⚠  Could not clean up ${dir} (may still be in use)`)
    );
  });

  for (const harness of HARNESSES) {
    test(`${harness}: attributes parallel foreground subagent commands`, function () {
      this.timeout(HARNESS_TIMEOUT_MS);
      const markers = ["subagent-marker-alpha", "subagent-marker-beta"];
      const workflow: PromptFile = {
        harness,
        model: HARNESS_MODELS[harness],
        steps: [
          {
            name: "parallel-subagents",
            prompt: `Launch TWO foreground subagents in parallel. The first must run exactly \`echo ${markers[0]}\`; the second must run exactly \`echo ${markers[1]}\`. Wait for both to finish. Do not run either command yourself.`,
          },
        ],
      };

      const result = runWorkflowFile(workflow, tmpDir, `${harness}-subagents`);
      if (logAndMaybeSkip(harness, result)) return;
      assert.strictEqual(
        result.exitCode,
        0,
        `${harness}: CLI exited with code ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      );

      const eventsPath = findRunFiles(runsRootFor(tmpDir), "events.jsonl")[0];
      assert.ok(eventsPath, `${harness}: no events.jsonl was recorded`);
      const events = readRecordedCliEvents(eventsPath);
      const spawnEvents = events.filter(
        (event) =>
          event.type === CLI_EVENT_TYPES.TOOL_CALL &&
          "subagentSpawn" in event.data
      );
      assert.ok(
        spawnEvents.length >= 2,
        `${harness}: expected two foreground subagent spawn cards, but the model may have skipped the requested subagents. Recorded ${spawnEvents.length}.`
      );

      const markerEvents = markers.map((marker) => {
        const found = events.filter(
          (event) =>
            event.type === CLI_EVENT_TYPES.TOOL_CALL &&
            JSON.stringify(event.data).includes(marker)
        );
        assert.ok(found.length > 0, `${harness}: no tool call ran ${marker}`);
        const attributed = found.find((event) => event.subagent);
        assert.ok(
          attributed?.subagent?.parentToolCallId,
          `${harness}: ${marker} command has no subagent spawn attribution`
        );
        return attributed;
      });

      assert.notStrictEqual(
        markerEvents[0].subagent?.parentToolCallId,
        markerEvents[1].subagent?.parentToolCallId,
        `${harness}: both marker commands were attributed to the same spawn`
      );
      const completedSpawnIds = new Set(
        spawnEvents
          .filter((event) =>
            ["completed", "complete"].includes(
              (event.data as { subagentSpawn?: { state?: string } })
                .subagentSpawn?.state ?? ""
            )
          )
          .map((event) => (event.data as ToolCall).id)
          .filter((id): id is string => Boolean(id))
      );
      for (const markerEvent of markerEvents) {
        const spawnId = markerEvent.subagent?.parentToolCallId;
        assert.ok(
          spawnId && completedSpawnIds.has(spawnId),
          `${harness}: spawn ${spawnId ?? "<unknown>"} for its marker command did not complete`
        );
      }
    });
  }
});
