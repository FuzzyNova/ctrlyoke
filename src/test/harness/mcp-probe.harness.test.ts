/**
 * Live MCP event pipeline probe. Run only through the explicitly requested
 * harness suite; each case incurs a real model call.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import type { CliEvent } from "../../types/CliOutputTypes";
import type { PromptFile } from "../../types/CtrlYokeTypes";
import {
  CLI_EVENT_TYPES,
  HARNESS_IDS,
  MCP_SERVER_IDS,
} from "../../types/DashboardConstants";
import { TIMELINE_EVENT_TYPES } from "../../types/WorkflowTimelineTypes";
import { projectStateRoot } from "../../utils/ProjectStatePaths";
import { runsRootForProjectState } from "../../utils/WorkflowPaths";
import { normalizeCliEvents } from "../../utils/CliEventNormalizer";
import { MCP_PROBE_CALLS } from "./mcpProbeContract";
import {
  HARNESS_MODELS,
  HARNESS_TIMEOUT_MS,
  logAndMaybeSkip,
  runWorkflowFile,
  type HarnessId,
} from "./helpers/harnessRunner";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

function findEventsJsonl(directory: string): string {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      try {
        const found = findEventsJsonl(fullPath);
        if (found) return found;
      } catch {
        // Continue through the run storage tree.
      }
    } else if (entry.name === "events.jsonl") {
      return fullPath;
    }
  }
  throw new Error(`No events.jsonl found under ${directory}`);
}

function readRecordedCliEvents(eventsPath: string): CliEvent[] {
  const timelineEvents = fs
    .readFileSync(eventsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          eventType?: string;
          payload?: {
            cliOutput?: { events?: CliEvent[] };
            events?: CliEvent[];
          };
        }
    );
  const cliEvents: CliEvent[] = [];
  for (const event of timelineEvents) {
    if (event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED) {
      cliEvents.push(...(event.payload?.cliOutput?.events ?? []));
    } else if (
      event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED
    ) {
      cliEvents.push(...(event.payload?.events ?? []));
    }
  }
  return cliEvents;
}

function assertProbeCalls(
  harness: HarnessId,
  events: readonly CliEvent[]
): void {
  const normalized = normalizeCliEvents(events);
  const mcpCalls = normalized.filter(
    (event) => event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL
  );
  assert.strictEqual(
    mcpCalls.length,
    MCP_PROBE_CALLS.length,
    `${harness}: expected exactly four MCP call rows; got ${JSON.stringify(normalized)}`
  );
  for (const expected of MCP_PROBE_CALLS) {
    const matches = mcpCalls.filter(
      (event) =>
        (event.data as { server?: string; tool?: string }).server ===
          MCP_SERVER_IDS.CTRLYOKE &&
        (event.data as { tool?: string }).tool === expected.tool
    );
    assert.strictEqual(
      matches.length,
      1,
      `${harness}: ${expected.tool} call count`
    );
    const data = matches[0].data as {
      server: string;
      tool: string;
      parameters?: Record<string, unknown>;
      result?: unknown;
      toolCallId?: string;
    };
    assert.strictEqual(
      data.server,
      MCP_SERVER_IDS.CTRLYOKE,
      `${harness}: ${expected.tool} server`
    );
    if ("parameters" in expected) {
      assert.ok(
        data.parameters && Object.keys(data.parameters).length > 0,
        `${harness}: ${expected.tool} parameters missing`
      );
    }
    assert.ok(data.result, `${harness}: ${expected.tool} result missing`);
    assert.ok(data.toolCallId, `${harness}: ${expected.tool} call id missing`);
  }
  assert.ok(
    !normalized.some(
      (event) =>
        event.type === CLI_EVENT_TYPES.TOOL_CALL &&
        MCP_PROBE_CALLS.some((call) => {
          const data = event.data as {
            name?: unknown;
            parameters?: Record<string, unknown>;
          };
          const nestedName = data.parameters?.name;
          return [data.name, nestedName].some(
            (name) =>
              typeof name === "string" &&
              (name === call.tool ||
                name === `mcp__${MCP_SERVER_IDS.CTRLYOKE}__${call.tool}` ||
                name === `${MCP_SERVER_IDS.CTRLYOKE}-${call.tool}`)
          );
        })
    ),
    `${harness}: generic TOOL_CALL row contains a ctrlyoke tool name`
  );
}

suite("MCP event pipeline harness probe", function () {
  this.timeout(HARNESS_TIMEOUT_MS);
  let tmpDir: string;
  let priorCtrlyokeHome: string | undefined;

  setup(function () {
    tmpDir = makeTempDir("cy-mcp-probe-");
    priorCtrlyokeHome = process.env.CTRLYOKE_HOME;
    process.env.CTRLYOKE_HOME = path.join(tmpDir, "state");
  });

  teardown(function () {
    if (priorCtrlyokeHome === undefined) delete process.env.CTRLYOKE_HOME;
    else process.env.CTRLYOKE_HOME = priorCtrlyokeHome;
    removeTempDir(tmpDir, (dir) =>
      console.log(`  ⚠  Could not clean up ${dir} (may still be in use)`)
    );
  });

  for (const harness of Object.values(HARNESS_IDS)) {
    test(`${harness}: records each ctrlyoke MCP call once`, function () {
      this.timeout(HARNESS_TIMEOUT_MS);
      const workflow: PromptFile = {
        harness,
        ...(HARNESS_MODELS[harness] ? { model: HARNESS_MODELS[harness] } : {}),
        mcpServers: ["ctrlyoke"],
        steps: [
          {
            name: "mcp-event-probe",
            prompt: [
              "/mcp:ctrlyoke",
              "Call each ctrlyoke MCP tool exactly once, in this order:",
              "1. workflow_status with no arguments.",
              '2. post_note with {"text":"mcp probe note"}.',
              '3. claim_paths with {"paths":["probe.txt"],"reason":"mcp probe"}.',
              '4. release_paths with {"paths":["probe.txt"]}.',
              "Do not call any other tools. After all four calls, respond DONE.",
            ].join("\n"),
          },
        ],
      };
      const result = runWorkflowFile(workflow, tmpDir, `mcp-probe-${harness}`);
      if (logAndMaybeSkip(`${harness} (MCP probe)`, result)) return;
      assert.strictEqual(
        result.exitCode,
        0,
        `${harness}: CLI exited with code ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      );

      const projectRoot = projectStateRoot(tmpDir, "user");
      const eventsPath = findEventsJsonl(runsRootForProjectState(projectRoot));
      const events = readRecordedCliEvents(eventsPath);
      assertProbeCalls(harness, events);
    });
  }
});
