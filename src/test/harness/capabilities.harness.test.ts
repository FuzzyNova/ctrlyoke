/**
 * Harness Capability Tests
 *
 * One live case per claim the compatibility matrix publishes. The cases are
 * generated from the same `HarnessCapabilityRegistry` declarations that drive
 * the matrix and the dashboard's compatibility warnings, so a harness that
 * claims a capability gets a case that proves it, and a claim with no case
 * fails the "every claim has a case" test below.
 *
 * Besides the declared capabilities, every harness also runs the shared
 * contracts mocks cannot prove: headless and interactive completion, resume of
 * the previous step's session, and an unknown model failing the step with the
 * CLI's own error.
 *
 * Every prompt is deliberately trivial (run one fixed command, call one tool,
 * count three dots) so that a failure means ctrlyoke or the harness broke, not
 * that the model struggled.
 *
 * Run with:  npm run test:harness
 * Run one:   npm run test:harness -- --grep "claude-cli"
 *
 * Exit code 3 from the CLI means "harness not installed" — the case is skipped.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { CliJsonResult } from "../../cli/CliJsonResultBuilder";
import { HarnessCapabilityRegistry } from "../../core/HarnessCapabilityRegistry";
import { CliNotificationMonitor } from "../../core/harness/shared/CliNotificationMonitor";
import {
  HOOK_CAVEAT_CODES,
  PERMISSION_CAVEAT_CODES,
  type CapabilityDeclaration,
  type CompatibilityCaveatCode,
} from "../../types/CompatibilityTypes";
import type {
  McpServerConfig,
  PromptFile,
  PromptStep,
  ToolPermissionsOverride,
  UserHookConfig,
} from "../../types/CtrlYokeTypes";
import {
  EXECUTION_MODES,
  HARNESS_IDS,
  HOOK_EVENT_NAMES,
  PERMISSION_MODES,
  STEP_STATUS,
  type ExecutionMode,
  type HookEvent,
} from "../../types/DashboardConstants";
import { MODEL_NONE } from "../../utils/ModelConstants";
import { removeTempDir } from "../helpers/tempWorkspace";
import {
  UNPROVEN_CLAIMS,
  collectClaims,
  type CapabilityPath,
} from "./capabilityEvidence";
import {
  HARNESS_MODELS,
  HARNESS_TIMEOUT_MS,
  buildHookRecorderScript,
  buildMcpProbeServerScript,
  findRunFiles,
  initGitRepo,
  isolateRunState,
  makeHarnessWorkspaceDir,
  KEEP_WORKSPACES_ENV,
  logAndMaybeSkip,
  readRecordedHookEvents,
  readResponseText,
  runInteractiveWorkflowFile,
  runWorkflowFileJson,
  runsRootFor,
  withIsolatedCodexHome,
  type HarnessId,
  type JsonRunResult,
  type RunResult,
} from "./helpers/harnessRunner";

// ---------------------------------------------------------------------------
// Declared claims
// ---------------------------------------------------------------------------

const FACTS = HarnessCapabilityRegistry.getDocumentationFacts();

/** Every declaration a harness makes that is not `unsupported`. */
function claimsFor(
  harness: HarnessId
): Map<CapabilityPath, CapabilityDeclaration> {
  return collectClaims(
    FACTS.harnesses.find((h) => h.harnessId === harness)?.capabilities
  );
}

const hookPath = (event: HookEvent): CapabilityPath => `hooks.${event}`;

/**
 * Caveats under which a claimed hook may legitimately not fire. Such a hook is
 * registered and reported, but its absence does not fail the case.
 */
const MAY_NOT_FIRE_CAVEATS: ReadonlySet<CompatibilityCaveatCode> = new Set([
  HOOK_CAVEAT_CODES.MAIN_SESSION_START_UNRELIABLE,
]);

// ---------------------------------------------------------------------------
// Cases and the claims they prove
// ---------------------------------------------------------------------------

const CASES = {
  turnHooks: "hooks: session, prompt, tool and stop events fire",
  permissionRequestHook:
    "hooks: permissionRequest fires for a tool needing approval",
  notificationHook: "hooks: notification fires for an unanswered approval",
  allowedTools: "permissions: an allowed tool pattern runs in custom mode",
  deniedTools: "permissions: a denied tool pattern is refused",
  mcpFiltering:
    "mcp: attached server tool runs, a per-server denied tool is refused",
  imageAndResume:
    "headless: image input reaches the model and the next step resumes",
  interactiveResume: "interactive: two steps complete in one resumed session",
  unknownModel: "unknown model fails the step with the CLI's error",
} as const;

type CaseId = keyof typeof CASES;

/** The claims each case proves. A claim missing from here has no evidence. */
const CASE_CLAIMS: Record<CaseId, readonly CapabilityPath[]> = {
  turnHooks: [
    hookPath(HOOK_EVENT_NAMES.SESSION_START),
    hookPath(HOOK_EVENT_NAMES.USER_PROMPT_SUBMIT),
    hookPath(HOOK_EVENT_NAMES.PRE_TOOL_USE),
    hookPath(HOOK_EVENT_NAMES.POST_TOOL_USE),
    hookPath(HOOK_EVENT_NAMES.STOP),
    // dangerouslyAllowAll lets the command run.
    "permissions.mode",
  ],
  permissionRequestHook: [hookPath(HOOK_EVENT_NAMES.PERMISSION_REQUEST)],
  notificationHook: [hookPath(HOOK_EVENT_NAMES.NOTIFICATION)],
  allowedTools: ["permissions.allowedTools", "permissions.mode"],
  deniedTools: ["permissions.deniedTools", "permissions.mode"],
  mcpFiltering: ["mcp.perServerToolFiltering"],
  imageAndResume: ["promptInputs.images"],
  interactiveResume: [],
  unknownModel: [hookPath(HOOK_EVENT_NAMES.ERROR)],
};

/** Cases every harness runs, whatever it declares. */
const SHARED_CASES: ReadonlySet<CaseId> = new Set([
  "imageAndResume",
  "interactiveResume",
  "unknownModel",
]);

/** Whether a harness's declarations give `caseId` anything to prove. */
function caseApplies(
  caseId: CaseId,
  claims: Map<CapabilityPath, CapabilityDeclaration>
): boolean {
  if (SHARED_CASES.has(caseId)) return true;
  // permissions.mode alone is proven by turnHooks; it does not pull in the
  // allow/deny cases for a harness that cannot enforce tool patterns.
  const ownClaims = CASE_CLAIMS[caseId].filter(
    (claim) => caseId === "turnHooks" || claim !== "permissions.mode"
  );
  return ownClaims.some((claim) => claims.has(claim));
}

/**
 * Where a harness raises its approval request. Claude's headless custom mode is
 * `dontAsk`, which refuses an unlisted tool without asking, and `codex exec`
 * never asks, so both have to be driven through their TUI.
 */
const APPROVAL_EXECUTION_MODE: Record<HarnessId, ExecutionMode> = {
  "copilot-cli": EXECUTION_MODES.HEADLESS,
  "claude-cli": EXECUTION_MODES.INTERACTIVE,
  "codex-cli": EXECUTION_MODES.INTERACTIVE,
  "opencode-cli": EXECUTION_MODES.HEADLESS,
  "qwen-cli": EXECUTION_MODES.HEADLESS,
  "antigravity-cli": EXECUTION_MODES.HEADLESS,
};

/** How long an interactive case may wait on a person before it is a failure. */
const INTERACTIVE_APPROVAL_TIMEOUT_MS = 240_000;

/** OpenCode takes `provider/model`; every other harness a bare model id. */
const UNKNOWN_MODEL: Record<HarnessId, string> = {
  "copilot-cli": "cy-no-such-model",
  "claude-cli": "cy-no-such-model",
  "codex-cli": "cy-no-such-model",
  "opencode-cli": "opencode/cy-no-such-model",
  "qwen-cli": "cy-no-such-model",
  "antigravity-cli": "cy-no-such-model",
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOTS_FIXTURE = path.resolve(
  __dirname,
  "../../../src/test/harness/fixtures/three-dots.png"
);

const MARKER_FILE = "marker.txt";
const MARKER_SCRIPT = "mark.js";
/** The one shell command every tool-using prompt asks for. */
const MARKER_COMMAND = `node ${MARKER_SCRIPT}`;
const NODE_PATTERN = "shell(node:*)";

const MCP_SERVER_ID = "cyprobe";
const MCP_OPEN_TOOL = "probe_open";
const MCP_BLOCKED_TOOL = "probe_blocked";

const runCommandPrompt = (command: string) =>
  `Run exactly one shell command, and no other command before or after it: ${command}. Do not explain — just run it.`;
const RUN_MARKER_PROMPT = runCommandPrompt(MARKER_COMMAND);
/** For a case where the command may be refused: no workaround may hide that. */
const orStop = (prompt: string) =>
  `${prompt} If that command is refused or denied, do not retry it and do not create any file another way.`;
const RUN_MARKER_OR_STOP_PROMPT = orStop(RUN_MARKER_PROMPT);

/**
 * A prompt whose tool call the harness must ask approval for.
 *
 * - Claude applies the developer's own allow rules even in `default` mode, and
 *   `Bash(node:*)` is a common one, so it writes the file with its file tool.
 * - Codex's default sandbox lets a workspace write through without asking, so
 *   its command writes outside the workspace, which needs an escalation
 *   request. (A read-only sandbox would ask for any write, but Codex 0.163 will
 *   not start in one: dev/bugs/backlog/codex-read-only-sandbox-refuses-add-dir.md.)
 */
function approvalPrompt(harness: HarnessId, workspace: Workspace): string {
  if (harness === HARNESS_IDS.CLAUDE_CLI) {
    return `Use your file-writing tool (not the shell) to create the file ${MARKER_FILE} containing the text ok. Do nothing else. If writing is refused or denied, stop.`;
  }
  if (harness !== HARNESS_IDS.CODEX_CLI) return RUN_MARKER_OR_STOP_PROMPT;
  const outside = path
    .join(os.tmpdir(), `${path.basename(workspace.dir)}-approval.txt`)
    .replace(/\\/g, "/");
  // Asking for escalation up front: a model that first hits the sandbox and
  // then reads "do not retry" never asks at all.
  return `Run exactly one shell command, with escalated permissions (request approval to run it outside the sandbox, because it writes outside the workspace): ${MARKER_COMMAND} ${outside}. Do not run it inside the sandbox first. If approval is refused, stop.`;
}

interface Workspace {
  dir: string;
  marker: string;
  hookLog: string;
  mcpLog: string;
  recorder: string;
  mcpServer: string;
}

function makeWorkspace(dir: string): Workspace {
  initGitRepo(dir);
  const workspace: Workspace = {
    dir,
    marker: path.join(dir, MARKER_FILE),
    hookLog: path.join(dir, "hooks.jsonl"),
    mcpLog: path.join(dir, "mcp-calls.txt"),
    recorder: path.join(dir, "record-hook.js"),
    mcpServer: path.join(dir, "mcp-probe.js"),
  };
  // Writes the workspace marker, or the file named by its first argument.
  fs.writeFileSync(
    path.join(dir, MARKER_SCRIPT),
    `require("fs").writeFileSync(process.argv[2] || ${JSON.stringify(workspace.marker)}, "ok");\nconsole.log("marker written");\n`
  );
  fs.writeFileSync(workspace.recorder, buildHookRecorderScript());
  fs.writeFileSync(workspace.mcpServer, buildMcpProbeServerScript());
  fs.copyFileSync(DOTS_FIXTURE, path.join(dir, "dots.png"));
  return workspace;
}

/**
 * Hooks that record `events`, quoted the way ctrlyoke quotes its own hook
 * commands for the harness: Qwen and Antigravity run a hook command without a
 * shell, so quotes would reach node literally.
 */
function recordHooks(
  harness: HarnessId,
  workspace: Workspace,
  events: readonly HookEvent[]
): UserHookConfig[] {
  return events.map((event) => ({
    event,
    command: CliNotificationMonitor.buildNodeCommand(
      workspace.recorder,
      [event, workspace.hookLog],
      CliNotificationMonitor.shouldQuoteNodeCommand(harness)
    ),
  }));
}

function probeServer(
  workspace: Workspace,
  deniedTools?: string[]
): McpServerConfig {
  return {
    id: MCP_SERVER_ID,
    command: "node",
    args: [
      workspace.mcpServer,
      `${MCP_OPEN_TOOL},${MCP_BLOCKED_TOOL}`,
      workspace.mcpLog,
    ],
    autoApprove: true,
    ...(deniedTools ? { deniedTools } : {}),
  };
}

function mcpCalls(workspace: Workspace): string[] {
  if (!fs.existsSync(workspace.mcpLog)) return [];
  return fs
    .readFileSync(workspace.mcpLog, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
}

const MCP_PROMPT = [
  `Call the MCP tool ${MCP_OPEN_TOOL} from the ${MCP_SERVER_ID} server once.`,
  `Then call the MCP tool ${MCP_BLOCKED_TOOL} from the ${MCP_SERVER_ID} server once.`,
  "If a tool is unavailable or refused, skip it. Do not use any other tool. Then reply DONE.",
].join(" ");

function workflowFor(
  harness: HarnessId,
  fields: Omit<PromptFile, "harness" | "steps">,
  steps: PromptStep[]
): PromptFile {
  return {
    harness,
    ...(HARNESS_MODELS[harness] ? { model: HARNESS_MODELS[harness] } : {}),
    ...fields,
    steps,
  };
}

/**
 * Run `workflow` in the mode it names. Interactive Codex gets an isolated home
 * that already trusts the folder (see `withIsolatedCodexHome`).
 */
async function runInMode(
  workflow: PromptFile,
  workspace: Workspace,
  label: string,
  options: { timeoutMs?: number; stopWhen?: () => boolean } = {}
): Promise<RunResult> {
  if (workflow.executionMode !== EXECUTION_MODES.INTERACTIVE) {
    return runWorkflowFileJson(workflow, workspace.dir, label);
  }
  const run = () =>
    runInteractiveWorkflowFile(
      workflow,
      workspace.dir,
      label,
      undefined,
      options.timeoutMs,
      options.stopWhen
    );
  return workflow.harness === HARNESS_IDS.CODEX_CLI
    ? withIsolatedCodexHome([workspace.dir], run)
    : run();
}

function describeRun(result: RunResult): string {
  return `exit ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
}

function assertSucceeded(label: string, result: RunResult): void {
  assert.strictEqual(result.exitCode, 0, `${label}: ${describeRun(result)}`);
}

/** Steps of the single run recorded under `workspace`, from its run file. */
function readRunSteps(
  workspace: Workspace
): Array<{ _runtime?: { sessionId?: string; status?: string } }> {
  const runFiles = findRunFiles(
    runsRootFor(workspace.dir),
    "workflow.ctrlyoke.json"
  ).filter((file) => path.basename(path.dirname(file)).startsWith("run-"));
  assert.strictEqual(runFiles.length, 1, `expected one run, got ${runFiles}`);
  return (
    JSON.parse(fs.readFileSync(runFiles[0], "utf8")) as {
      steps: Array<{ _runtime?: { sessionId?: string; status?: string } }>;
    }
  ).steps;
}

/** Assert each claimed event fired, reporting the rest. */
function assertHooksFired(
  harness: HarnessId,
  workspace: Workspace,
  events: readonly HookEvent[],
  claims: Map<CapabilityPath, CapabilityDeclaration>,
  result: RunResult
): void {
  const fired = readRecordedHookEvents(workspace.hookLog);
  console.log(`  ↳ hooks fired: ${[...fired].join(", ") || "(none)"}`);
  for (const event of events) {
    const claim = claims.get(hookPath(event));
    if (!claim || fired.has(event)) continue;
    if (claim.caveatCode && MAY_NOT_FIRE_CAVEATS.has(claim.caveatCode)) {
      console.log(`  ↳ ${event} did not fire (allowed by ${claim.caveatCode})`);
      continue;
    }
    if (UNPROVEN_CLAIMS[harness]?.[hookPath(event)]) {
      console.log(`  ↳ ${event} did not fire (unproven claim, not asserted)`);
      continue;
    }
    assert.fail(
      `${harness}: claimed hook "${event}" did not fire (fired: ${[...fired].join(", ") || "none"})\n${describeRun(result)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite("Harness capability tests", function () {
  this.timeout(HARNESS_TIMEOUT_MS);

  test("every claimed capability has a case", function () {
    const covered = new Set(Object.values(CASE_CLAIMS).flat());
    const uncovered = Object.values(HARNESS_IDS).flatMap((harness) =>
      [...claimsFor(harness).keys()]
        .filter((claim) => !covered.has(claim))
        .map((claim) => `${harness}: ${claim}`)
    );
    assert.deepStrictEqual(uncovered, []);
  });

  for (const harness of Object.values(HARNESS_IDS)) {
    const claims = claimsFor(harness);
    const applies = (caseId: CaseId) => caseApplies(caseId, claims);

    suite(harness, function () {
      let workspace: Workspace;
      let restoreRunState: () => void;

      setup(function () {
        const dir = makeHarnessWorkspaceDir(harness, "cy-capability-");
        restoreRunState = isolateRunState(dir);
        workspace = makeWorkspace(dir);
      });

      teardown(function () {
        restoreRunState();
        if (process.env[KEEP_WORKSPACES_ENV]) {
          console.log(`  ↳ workspace kept: ${workspace.dir}`);
          return;
        }
        removeTempDir(workspace.dir, (dir) =>
          console.log(`  ⚠  Could not clean up ${dir} (may still be in use)`)
        );
      });

      if (applies("turnHooks")) {
        test(`${harness}: ${CASES.turnHooks}`, async function () {
          const events = [
            HOOK_EVENT_NAMES.SESSION_START,
            HOOK_EVENT_NAMES.USER_PROMPT_SUBMIT,
            HOOK_EVENT_NAMES.PRE_TOOL_USE,
            HOOK_EVENT_NAMES.POST_TOOL_USE,
            HOOK_EVENT_NAMES.STOP,
          ].filter((event) => claims.has(hookPath(event)));
          const result = await runInMode(
            workflowFor(
              harness,
              {
                toolPermissions: {
                  mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
                },
                hooks: recordHooks(harness, workspace, events),
              },
              [{ name: "turn-hooks", prompt: RUN_MARKER_PROMPT }]
            ),
            workspace,
            `${harness}-turn-hooks`
          );
          if (logAndMaybeSkip(harness, result)) return;
          assertSucceeded(harness, result);
          assert.ok(
            fs.existsSync(workspace.marker),
            `${harness}: dangerouslyAllowAll did not let the command run`
          );
          assertHooksFired(harness, workspace, events, claims, result);
        });
      }

      if (applies("permissionRequestHook")) {
        test(`${harness}: ${CASES.permissionRequestHook}`, async function () {
          const executionMode = APPROVAL_EXECUTION_MODE[harness];
          const events = [HOOK_EVENT_NAMES.PERMISSION_REQUEST];
          const result = await runInMode(
            workflowFor(
              harness,
              {
                executionMode,
                toolPermissions: {
                  mode: PERMISSION_MODES.CUSTOM,
                  allowedTools: [],
                  deniedTools: [],
                },
                // The recorder answers with an allow decision.
                hooks: recordHooks(harness, workspace, events),
              },
              [
                {
                  name: "permission-request",
                  prompt: approvalPrompt(harness, workspace),
                },
              ]
            ),
            workspace,
            `${harness}-permission-request`,
            { timeoutMs: INTERACTIVE_APPROVAL_TIMEOUT_MS }
          );
          if (logAndMaybeSkip(harness, result)) return;
          assertSucceeded(harness, result);
          assertHooksFired(harness, workspace, events, claims, result);
          console.log(
            `  ↳ command ${fs.existsSync(workspace.marker) ? "ran" : "did not run"} after the hook's allow decision`
          );
        });
      }

      if (applies("notificationHook")) {
        test(`${harness}: ${CASES.notificationHook}`, async function () {
          const events = [HOOK_EVENT_NAMES.NOTIFICATION];
          // Nobody answers the approval prompt, so the run is stopped as soon
          // as the notification is recorded.
          const result = await runInMode(
            workflowFor(
              harness,
              {
                executionMode: EXECUTION_MODES.INTERACTIVE,
                toolPermissions: {
                  mode: PERMISSION_MODES.CUSTOM,
                  allowedTools: [],
                  deniedTools: [],
                },
                hooks: recordHooks(harness, workspace, events),
              },
              [
                {
                  name: "notification",
                  prompt: approvalPrompt(harness, workspace),
                },
              ]
            ),
            workspace,
            `${harness}-notification`,
            {
              timeoutMs: INTERACTIVE_APPROVAL_TIMEOUT_MS,
              stopWhen: () =>
                readRecordedHookEvents(workspace.hookLog).has(
                  HOOK_EVENT_NAMES.NOTIFICATION
                ),
            }
          );
          if (logAndMaybeSkip(harness, result)) return;
          assertHooksFired(harness, workspace, events, claims, result);
        });
      }

      if (applies("allowedTools")) {
        test(`${harness}: ${CASES.allowedTools}`, async function () {
          const result = await runInMode(
            workflowFor(
              harness,
              {
                toolPermissions: {
                  mode: PERMISSION_MODES.CUSTOM,
                  allowedTools: [NODE_PATTERN],
                  deniedTools: [],
                },
              },
              [{ name: "allowed-tool", prompt: RUN_MARKER_PROMPT }]
            ),
            workspace,
            `${harness}-allowed-tool`
          );
          if (logAndMaybeSkip(harness, result)) return;
          assertSucceeded(harness, result);
          assert.ok(
            fs.existsSync(workspace.marker),
            `${harness}: the allowed command did not run`
          );
        });
      }

      if (applies("deniedTools")) {
        const mcpOnly =
          claims.get("permissions.deniedTools")?.caveatCode ===
          PERMISSION_CAVEAT_CODES.MCP_TOOL_DENIALS_ONLY;
        test(`${harness}: ${CASES.deniedTools}`, async function () {
          const blockedPattern = `mcp__${MCP_SERVER_ID}__${MCP_BLOCKED_TOOL}`;
          const toolPermissions: ToolPermissionsOverride = {
            mode: PERMISSION_MODES.ALLOW_ALL,
            deniedTools: [mcpOnly ? blockedPattern : NODE_PATTERN],
          };
          const result = await runInMode(
            workflowFor(
              harness,
              mcpOnly
                ? { toolPermissions, mcpServers: [probeServer(workspace)] }
                : { toolPermissions },
              [
                {
                  name: "denied-tool",
                  prompt: mcpOnly ? MCP_PROMPT : RUN_MARKER_OR_STOP_PROMPT,
                },
              ]
            ),
            workspace,
            `${harness}-denied-tool`
          );
          if (logAndMaybeSkip(harness, result)) return;
          assertSucceeded(harness, result);
          if (mcpOnly) {
            const calls = mcpCalls(workspace);
            assert.ok(calls.includes(MCP_OPEN_TOOL), `calls: ${calls}`);
            assert.ok(!calls.includes(MCP_BLOCKED_TOOL), `calls: ${calls}`);
          } else {
            assert.ok(
              !fs.existsSync(workspace.marker),
              `${harness}: the denied command ran`
            );
          }
        });
      }

      if (applies("mcpFiltering")) {
        test(`${harness}: ${CASES.mcpFiltering}`, async function () {
          const result = await runInMode(
            workflowFor(
              harness,
              {
                toolPermissions: { mode: PERMISSION_MODES.ALLOW_ALL },
                mcpServers: [probeServer(workspace, [MCP_BLOCKED_TOOL])],
              },
              [{ name: "mcp-filtering", prompt: MCP_PROMPT }]
            ),
            workspace,
            `${harness}-mcp-filtering`
          );
          if (logAndMaybeSkip(harness, result)) return;
          assertSucceeded(harness, result);
          const calls = mcpCalls(workspace);
          assert.ok(
            calls.includes(MCP_OPEN_TOOL),
            `${harness}: the attached server's tool was never called (calls: ${calls})`
          );
          assert.ok(
            !calls.includes(MCP_BLOCKED_TOOL),
            `${harness}: the server's denied tool was called`
          );
        });
      }

      test(`${harness}: ${CASES.imageAndResume}`, async function () {
        const result = (await runInMode(
          workflowFor(harness, { resumeSession: true }, [
            {
              name: "count-dots",
              prompt:
                'How many black dots are in @dots.png? Answer with only "DOTS=" followed by the number in digits.',
            },
            {
              name: "recall",
              prompt:
                'What number did you give in your previous answer? Answer with only "RECALL=" followed by that number in digits.',
            },
          ]),
          workspace,
          `${harness}-image-resume`
        )) as JsonRunResult;
        if (logAndMaybeSkip(harness, result)) return;
        assertSucceeded(harness, result);
        const text = readResponseText(workspace.dir);
        const steps = result.json?.steps ?? [];
        assert.ok(steps[0]?.sessionId, `${harness}: step 1 has no session`);
        assert.strictEqual(
          steps[1]?.sessionId,
          steps[0].sessionId,
          `${harness}: step 2 did not resume step 1's session`
        );
        if (claims.has("promptInputs.images")) {
          assert.match(text, /DOTS=\s*3\b/, `${harness}: response: ${text}`);
        }
        assert.match(text, /RECALL=\s*3\b/, `${harness}: response: ${text}`);
      });

      test(`${harness}: ${CASES.interactiveResume}`, async function () {
        const result = await runInMode(
          workflowFor(
            harness,
            {
              executionMode: EXECUTION_MODES.INTERACTIVE,
              resumeSession: true,
            },
            [
              { name: "first", prompt: "Reply with exactly: first" },
              { name: "second", prompt: "Reply with exactly: second" },
            ]
          ),
          workspace,
          `${harness}-interactive-resume`,
          { timeoutMs: INTERACTIVE_APPROVAL_TIMEOUT_MS }
        );
        if (logAndMaybeSkip(harness, result)) return;
        assertSucceeded(harness, result);
        const [first, second] = readRunSteps(workspace);
        assert.ok(
          first._runtime?.sessionId,
          `${harness}: step 1 has no session`
        );
        assert.strictEqual(
          second._runtime?.sessionId,
          first._runtime.sessionId,
          `${harness}: step 2 did not resume step 1's session`
        );
      });

      test(`${harness}: ${CASES.unknownModel}`, async function () {
        const events = [HOOK_EVENT_NAMES.ERROR].filter((event) =>
          claims.has(hookPath(event))
        );
        // `model: none` keeps ctrlyoke from passing its own --model, so the
        // CLI receives exactly the unknown id. The API rejects the request
        // before any tokens are used.
        const result = (await runInMode(
          {
            harness,
            model: MODEL_NONE,
            additionalArgs: `--model ${UNKNOWN_MODEL[harness]}`,
            hooks: recordHooks(harness, workspace, events),
            steps: [{ name: "unknown-model", prompt: "Reply with OK." }],
          },
          workspace,
          `${harness}-unknown-model`
        )) as JsonRunResult;
        if (logAndMaybeSkip(harness, result)) return;
        assert.notStrictEqual(
          result.exitCode,
          0,
          `${harness}: a step on an unknown model succeeded\n${describeRun(result)}`
        );
        const json = result.json as CliJsonResult;
        const step = json?.steps[0];
        assert.strictEqual(
          step?.status,
          STEP_STATUS.FAILED,
          describeRun(result)
        );
        // The wording is each CLI's own (OpenCode's does not even name the
        // model), so only its presence is asserted.
        const message = (step.error ?? json.error?.message ?? "").trim();
        console.log(`  ↳ error: ${message}`);
        assert.ok(message, `${harness}: the failed step carries no error`);
        assertHooksFired(harness, workspace, events, claims, result);
      });
    });
  }
});
