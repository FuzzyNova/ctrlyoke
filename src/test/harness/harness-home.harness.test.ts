/**
 * Moved harness home regression tests.
 *
 * Claude (`CLAUDE_CONFIG_DIR`), Qwen (`QWEN_HOME`) and Copilot (`COPILOT_HOME`)
 * let the user move their global config and state directory. The CLI inherits
 * the variable from ctrlyoke's environment and writes its session transcript
 * under the moved home, so ctrlyoke's log reader has to look there too, or a
 * step streams no output and never resolves its session ID.
 *
 * These are real-harness tests and are intentionally not part of `npm test`.
 * Run with `npm run test:harness` only when authenticated CLIs are installed.
 * Exit code 3 means that the target CLI is absent and skips the case.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import type { PromptFile } from "../../types/CtrlYokeTypes";
import {
  EXECUTION_MODES,
  HARNESS_IDS,
  type ExecutionMode,
} from "../../types/DashboardConstants";
import { removeTempDir } from "../helpers/tempWorkspace";
import {
  HARNESS_MODELS,
  HARNESS_TIMEOUT_MS,
  claudeHomeCopy,
  copilotHomeCopy,
  findRunFiles,
  initGitRepo,
  isolateRunState,
  logAndMaybeSkip,
  makeHarnessWorkspaceDir,
  qwenHomeCopy,
  readResponseText,
  runInteractiveWorkflowFile,
  runWorkflowFile,
  withMovedHarnessHome,
  type HarnessId,
  type MovedHarnessHomeOptions,
  type RunResult,
} from "./helpers/harnessRunner";

interface MovedHomeCase {
  readonly harness: HarnessId;
  readonly home: () => MovedHarnessHomeOptions;
  /** Folder inside the moved home where the CLI writes session transcripts. */
  readonly transcriptDir: string;
}

const CASES: readonly MovedHomeCase[] = [
  {
    harness: HARNESS_IDS.CLAUDE_CLI,
    home: claudeHomeCopy,
    transcriptDir: "projects",
  },
  {
    harness: HARNESS_IDS.QWEN_CLI,
    home: qwenHomeCopy,
    transcriptDir: "projects",
  },
  {
    harness: HARNESS_IDS.COPILOT_CLI,
    home: copilotHomeCopy,
    transcriptDir: "session-state",
  },
];

function listFilesRecursively(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFilesRecursively(fullPath) : [fullPath];
  });
}

/** The session ID ctrlyoke recorded for the run's only step, if any. */
function readRecordedSessionId(workspace: string): string | undefined {
  const runsRoot = path.join(workspace, "state");
  for (const file of findRunFiles(runsRoot, "workflow.ctrlyoke.json")) {
    const workflow = JSON.parse(fs.readFileSync(file, "utf8")) as {
      steps?: { _runtime?: { sessionId?: string } }[];
    };
    const sessionId = workflow.steps?.[0]?._runtime?.sessionId;
    if (sessionId) return sessionId;
  }
  return undefined;
}

suite("Moved harness home regression tests", function () {
  this.timeout(HARNESS_TIMEOUT_MS);

  for (const movedCase of CASES) {
    for (const mode of [
      EXECUTION_MODES.INTERACTIVE,
      EXECUTION_MODES.HEADLESS,
    ] as const satisfies readonly ExecutionMode[]) {
      const label = `${movedCase.harness} (${mode}, moved home)`;

      test(`${movedCase.harness}: ${mode} run follows the moved home`, async function () {
        const workspace = makeHarnessWorkspaceDir(
          movedCase.harness,
          "cy-moved-home-"
        );
        initGitRepo(workspace);
        const restoreRunState = isolateRunState(workspace);
        try {
          const token = `moved-home-${Date.now().toString(36)}`;
          const workflow: PromptFile = {
            harness: movedCase.harness,
            model: HARNESS_MODELS[movedCase.harness],
            executionMode: mode,
            steps: [
              {
                name: "moved-home",
                prompt: `Reply with exactly this word and nothing else: ${token}`,
              },
            ],
          };
          const { result, transcripts } = await withMovedHarnessHome(
            movedCase.home(),
            async (home) => {
              const run: RunResult =
                mode === EXECUTION_MODES.INTERACTIVE
                  ? await runInteractiveWorkflowFile(
                      workflow,
                      workspace,
                      "moved-home"
                    )
                  : runWorkflowFile(workflow, workspace, "moved-home");
              return {
                result: run,
                transcripts: listFilesRecursively(
                  path.join(home, movedCase.transcriptDir)
                ),
              };
            }
          );
          if (logAndMaybeSkip(label, result)) return;

          assert.strictEqual(
            result.exitCode,
            0,
            `${label}: CLI exited with code ${result.exitCode}\n${result.stdout}\n${result.stderr}`
          );
          // Without this the case would prove nothing: the CLI honoured the
          // variable and wrote its session under the moved home.
          assert.ok(
            transcripts.length > 0,
            `${label}: the CLI wrote no session files under the moved home's ${movedCase.transcriptDir}/`
          );
          const sessionId = readRecordedSessionId(workspace);
          assert.ok(sessionId, `${label}: ctrlyoke resolved no session ID`);
          assert.ok(
            transcripts.some((file) => file.includes(sessionId)),
            `${label}: the session ${sessionId} has no transcript under the moved home:\n${transcripts.join("\n")}`
          );
          assert.ok(
            readResponseText(workspace).includes(token),
            `${label}: ctrlyoke recorded no response text containing ${token}\n${result.stdout}`
          );
        } finally {
          restoreRunState();
          removeTempDir(workspace, (dir) =>
            console.log(`  ⚠  Could not clean up ${dir} (may still be in use)`)
          );
        }
      });
    }
  }
});
