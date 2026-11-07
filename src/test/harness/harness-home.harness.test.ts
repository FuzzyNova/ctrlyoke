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

interface CasePreparation {
  /** Folder where the CLI should write this case's session transcripts. */
  readonly transcriptRoot: string;
  /** A folder the transcript must not be in: the location the case moves it away from. */
  readonly notIn?: string;
  readonly additionalArgs?: string;
}

interface MovedHomeCase {
  readonly harness: HarnessId;
  /** What the case moves, shown in its title. */
  readonly moves: string;
  readonly home: () => MovedHarnessHomeOptions;
  readonly prepare: (home: string, workspace: string) => CasePreparation;
}

/** Add `advanced.runtimeOutputDir` to a Qwen settings file. */
function setQwenRuntimeOutputDir(settingsPath: string, value: string): void {
  const settings = fs.existsSync(settingsPath)
    ? (JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<
        string,
        unknown
      >)
    : {};
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ ...settings, advanced: { runtimeOutputDir: value } })
  );
}

const CASES: readonly MovedHomeCase[] = [
  {
    harness: HARNESS_IDS.CLAUDE_CLI,
    moves: "CLAUDE_CONFIG_DIR",
    home: claudeHomeCopy,
    prepare: (home) => ({ transcriptRoot: path.join(home, "projects") }),
  },
  {
    harness: HARNESS_IDS.QWEN_CLI,
    moves: "QWEN_HOME",
    home: qwenHomeCopy,
    prepare: (home) => ({ transcriptRoot: path.join(home, "projects") }),
  },
  {
    harness: HARNESS_IDS.QWEN_CLI,
    moves: "user advanced.runtimeOutputDir",
    home: qwenHomeCopy,
    prepare: (home) => {
      const runtimeDir = path.join(home, "runtime-out");
      setQwenRuntimeOutputDir(path.join(home, "settings.json"), runtimeDir);
      return {
        transcriptRoot: path.join(runtimeDir, "projects"),
        notIn: path.join(home, "projects"),
      };
    },
  },
  {
    harness: HARNESS_IDS.QWEN_CLI,
    moves: "workspace advanced.runtimeOutputDir",
    home: qwenHomeCopy,
    prepare: (home, workspace) => {
      // Relative to the workspace, the way Qwen resolves it.
      setQwenRuntimeOutputDir(
        path.join(workspace, ".qwen", "settings.json"),
        "qwen-runtime"
      );
      return {
        transcriptRoot: path.join(workspace, "qwen-runtime", "projects"),
        notIn: path.join(home, "projects"),
      };
    },
  },
  {
    harness: HARNESS_IDS.COPILOT_CLI,
    moves: "COPILOT_HOME",
    home: copilotHomeCopy,
    prepare: (home) => ({ transcriptRoot: path.join(home, "session-state") }),
  },
  {
    harness: HARNESS_IDS.COPILOT_CLI,
    moves: "--config-dir",
    home: copilotHomeCopy,
    prepare: (home) => {
      // A second signed-in home that --config-dir picks over COPILOT_HOME.
      const configDir = path.join(home, "config-dir");
      fs.mkdirSync(configDir);
      for (const file of ["config.json", "settings.json"]) {
        if (fs.existsSync(path.join(home, file))) {
          fs.copyFileSync(path.join(home, file), path.join(configDir, file));
        }
      }
      return {
        transcriptRoot: path.join(configDir, "session-state"),
        notIn: path.join(home, "session-state"),
        additionalArgs: `--config-dir "${configDir}"`,
      };
    },
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
      const label = `${movedCase.harness} (${mode}, ${movedCase.moves})`;

      test(`${movedCase.harness}: ${mode} run follows ${movedCase.moves}`, async function () {
        const workspace = makeHarnessWorkspaceDir(
          movedCase.harness,
          "cy-moved-home-"
        );
        initGitRepo(workspace);
        const restoreRunState = isolateRunState(workspace);
        try {
          const token = `moved-home-${Date.now().toString(36)}`;
          const { result, transcripts, misplaced } = await withMovedHarnessHome(
            movedCase.home(),
            async (home) => {
              const preparation = movedCase.prepare(home, workspace);
              const workflow: PromptFile = {
                harness: movedCase.harness,
                model: HARNESS_MODELS[movedCase.harness],
                executionMode: mode,
                ...(preparation.additionalArgs
                  ? { additionalArgs: preparation.additionalArgs }
                  : {}),
                steps: [
                  {
                    name: "moved-home",
                    prompt: `Reply with exactly this word and nothing else: ${token}`,
                  },
                ],
              };
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
                transcripts: listFilesRecursively(preparation.transcriptRoot),
                misplaced: preparation.notIn
                  ? listFilesRecursively(preparation.notIn)
                  : [],
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
            `${label}: the CLI wrote no session files where ${movedCase.moves} points`
          );
          const sessionId = readRecordedSessionId(workspace);
          assert.ok(sessionId, `${label}: ctrlyoke resolved no session ID`);
          assert.ok(
            transcripts.some((file) => file.includes(sessionId)),
            `${label}: the session ${sessionId} has no transcript where ${movedCase.moves} points:\n${transcripts.join("\n")}`
          );
          assert.ok(
            !misplaced.some((file) => file.includes(sessionId)),
            `${label}: the session ${sessionId} was written to the location ${movedCase.moves} should replace`
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
