/**
 * Native sandbox end-to-end checks. These run only in `npm run test:harness`.
 *
 * The "outside" target must not be under the OS temp directory: Codex's
 * workspace-write, Claude's and Copilot's sandboxes all keep temp writable, so
 * a sibling of a temp workspace is reachable and proves nothing. It is a
 * throwaway hidden directory in the home directory, removed by each case.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CLI_EVENT_TYPES,
  HARNESS_IDS,
  HOOK_EVENT_NAMES,
  MCP_SERVER_IDS,
  PERMISSION_MODES,
  SANDBOX_MODES,
} from "../../types/DashboardConstants";
import { normalizeCliEvents } from "../../utils/CliEventNormalizer";
import { MCP_PROBE_CALLS } from "./mcpProbeContract";
import type { PromptFile, UserHookConfig } from "../../types/CtrlYokeTypes";
import { HarnessCapabilityRegistry } from "../../core/HarnessCapabilityRegistry";
import { CodexSandboxMapper } from "../../core/harness/codex/CodexSandboxMapper";
import { CodexToolPermissionMapper } from "../../core/harness/codex/CodexToolPermissionMapper";
import { CliNotificationMonitor } from "../../core/harness/shared/CliNotificationMonitor";
import { removeTempDir } from "../helpers/tempWorkspace";
import {
  HARNESS_MODELS,
  HARNESS_TIMEOUT_MS,
  MCP_STARTUP_WAIT_INSTRUCTION,
  buildHookRecorderScript,
  findRunFiles,
  initGitRepo,
  isolateRunState,
  logAndMaybeSkip,
  makeHarnessWorkspaceDir,
  readRecordedCliEvents,
  readRecordedHookEvents,
  runWorkflowFile,
  runsRootFor,
  withIsolatedCodexHome,
  type HarnessId,
} from "./helpers/harnessRunner";

const facts = HarnessCapabilityRegistry.getDocumentationFacts();
// A harness with no declaration at all is unsupported too, not "not unsupported".
function declaresSandbox(entry: (typeof facts.harnesses)[number]): boolean {
  const fidelity = entry.capabilities.sandbox?.terminal.fidelity;
  return fidelity !== undefined && fidelity !== "unsupported";
}
// Claude has no Bash sandbox on Windows, so ClaudeSandboxMapper refuses
// `sandbox: true` there the way an unsupported harness does.
function hostCannotSandbox(entry: (typeof facts.harnesses)[number]): boolean {
  return (
    process.platform === "win32" && entry.harnessId === HARNESS_IDS.CLAUDE_CLI
  );
}
const SANDBOXED_HARNESSES = facts.harnesses
  .filter((entry) => declaresSandbox(entry) && !hostCannotSandbox(entry))
  .map((entry) => entry.harnessId as HarnessId);
const UNSUPPORTED_HARNESSES = facts.harnesses
  .filter((entry) => !declaresSandbox(entry) || hostCannotSandbox(entry))
  .map((entry) => entry.harnessId as HarnessId);

function workflow(
  harness: HarnessId,
  prompt: string,
  extra: Partial<PromptFile> = {}
): PromptFile {
  return {
    harness,
    ...(HARNESS_MODELS[harness] ? { model: HARNESS_MODELS[harness] } : {}),
    ...extra,
    steps: [{ name: "sandbox-check", prompt }],
  };
}

const WRITE_SCRIPT = "write-outside.js";

/**
 * The write goes through a script already in the workspace so the prompt never
 * mentions an outside path: some models refuse that themselves, and a refusal
 * would look exactly like a sandbox block.
 */
function prepareOutsideWrite(workspace: string, filePath: string): string {
  fs.writeFileSync(
    path.join(workspace, WRITE_SCRIPT),
    `require("fs").writeFileSync(${JSON.stringify(filePath)}, "sandbox-marker");\n`
  );
  return `Run exactly this command once: node ${WRITE_SCRIPT}. Then stop.`;
}

/**
 * Whether the run's timeline records a shell command containing \`needle\`. A
 * "blocked" write only proves the sandbox if the agent really tried it.
 */
function shellCommandAttempted(workspace: string, needle: string): boolean {
  const eventsPath = findRunFiles(runsRootFor(workspace), "events.jsonl")[0];
  if (!eventsPath) return false;
  return normalizeCliEvents(readRecordedCliEvents(eventsPath)).some(
    (event) =>
      event.type === CLI_EVENT_TYPES.BASH_COMMAND &&
      String((event.data as { command?: string }).command ?? "").includes(
        needle
      )
  );
}

suite("Harness sandbox tests", function () {
  this.timeout(HARNESS_TIMEOUT_MS);

  for (const harness of SANDBOXED_HARNESSES) {
    suite(harness, function () {
      let root: string;
      let workspace: string;
      let outsideDir: string;
      let restoreRunState: () => void;

      setup(function () {
        root = makeHarnessWorkspaceDir(harness, "cy-sandbox-");
        // macOS reaches the temp root through a symlink (/var -> /private/var);
        // the CLI resolves it, so the state-root lookup must too.
        workspace = path.join(fs.realpathSync(root), "workspace");
        fs.mkdirSync(workspace);
        initGitRepo(workspace);
        outsideDir = fs.mkdtempSync(
          path.join(os.homedir(), ".cy-sandbox-outside-")
        );
        restoreRunState = isolateRunState(root);
      });

      teardown(function () {
        restoreRunState();
        fs.rmSync(outsideDir, { recursive: true, force: true, maxRetries: 3 });
        if (!process.env.CTRLYOKE_HARNESS_KEEP_WORKSPACES) {
          removeTempDir(root, (dir) =>
            console.log(`  ⚠  Could not clean up ${dir}`)
          );
        } else {
          console.log(`  ↳ workspace kept: ${root}`);
        }
      });

      for (const sandbox of [true, false] as const) {
        test(`${harness}: sandbox ${sandbox} ${sandbox ? "blocks" : "allows"} a sibling write`, async function () {
          const outside = path.join(outsideDir, `outside-${sandbox}.txt`);
          const definition = workflow(
            harness,
            prepareOutsideWrite(workspace, outside),
            { sandbox }
          );
          const run = async () =>
            runWorkflowFile(definition, workspace, `sandbox-write-${sandbox}`);
          const result =
            harness === HARNESS_IDS.CODEX_CLI
              ? await withIsolatedCodexHome([workspace], run)
              : await run();
          if (logAndMaybeSkip(harness, result)) return;
          assert.ok(
            shellCommandAttempted(workspace, WRITE_SCRIPT),
            `${harness}: the agent never ran the write, so the result proves nothing\nstdout: ${result.stdout}`
          );
          assert.strictEqual(
            fs.existsSync(outside),
            !sandbox,
            `${harness}: sandbox=${sandbox} outside write state was unexpected\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
          );
          if (!sandbox)
            assert.strictEqual(
              result.exitCode,
              0,
              `${result.stdout}\n${result.stderr}`
            );
        });
      }

      test(`${harness}: ctrlyoke MCP server and completion hook work with sandbox enabled`, async function () {
        const hookLog = path.join(root, "hooks.jsonl");
        const recorder = path.join(root, "record-hook.js");
        fs.writeFileSync(recorder, buildHookRecorderScript());
        const hooks: UserHookConfig[] = [
          {
            event: HOOK_EVENT_NAMES.STOP,
            command: CliNotificationMonitor.buildNodeCommand(
              recorder,
              [HOOK_EVENT_NAMES.STOP, hookLog],
              CliNotificationMonitor.shouldQuoteNodeCommand(harness)
            ),
          },
        ];
        const definition = workflow(
          harness,
          `/mcp:ctrlyoke\nCall the ctrlyoke MCP tool ${MCP_PROBE_CALLS[0].tool} once with no arguments, then reply OK. ${MCP_STARTUP_WAIT_INSTRUCTION}`,
          { sandbox: true, hooks, mcpServers: [MCP_SERVER_IDS.CTRLYOKE] }
        );
        const run = async () =>
          runWorkflowFile(definition, workspace, "sandbox-mcp-hooks");
        const result =
          harness === HARNESS_IDS.CODEX_CLI
            ? await withIsolatedCodexHome([workspace], run)
            : await run();
        if (logAndMaybeSkip(harness, result)) return;
        assert.strictEqual(
          result.exitCode,
          0,
          `${result.stdout}\n${result.stderr}`
        );
        const eventsPath = findRunFiles(
          runsRootFor(workspace),
          "events.jsonl"
        )[0];
        assert.ok(eventsPath, "run timeline was not recorded");
        const mcpEvents = normalizeCliEvents(
          readRecordedCliEvents(eventsPath)
        ).filter((event) => event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL);
        assert.ok(
          mcpEvents.some(
            (event) =>
              (event.data as { server?: string; tool?: string }).server ===
                MCP_SERVER_IDS.CTRLYOKE &&
              (event.data as { tool?: string }).tool === MCP_PROBE_CALLS[0].tool
          ),
          `${MCP_PROBE_CALLS[0].tool} was not called: ${JSON.stringify(mcpEvents)}\nstdout: ${result.stdout}`
        );
        assert.ok(
          readRecordedHookEvents(hookLog).has(HOOK_EVENT_NAMES.STOP),
          "completion hook did not fire under sandbox=true"
        );
      });

      if (harness === HARNESS_IDS.CODEX_CLI) {
        test("codex-cli: dangerouslyAllowAll with sandbox true does not bypass the sandbox", async function () {
          const outside = path.join(
            outsideDir,
            "outside-dangerously-allow-all.txt"
          );
          const definition = workflow(
            harness,
            prepareOutsideWrite(workspace, outside),
            {
              sandbox: true,
              toolPermissions: { mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL },
            }
          );
          // Assert the exact provider arguments used for this permission mode:
          // sandbox=true must suppress the normal all-access bypass flag. The
          // `-s` comes from the sandbox mapper, the rest from the permission one.
          const toolPermissions = {
            mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
            allowedTools: [],
            deniedTools: [],
          };
          const codexArgs = [
            ...(
              await new CodexSandboxMapper().prepare(true, {
                isInteractive: false,
                writableRoots: [],
                sandboxMode: SANDBOX_MODES.WORKSPACE_WRITE,
                requestFromDefaults: false,
              })
            ).cliArgs,
            ...new CodexToolPermissionMapper().buildCodexSpecificArgs(
              toolPermissions,
              false
            ),
          ];
          assert.ok(
            codexArgs.includes("-s") && codexArgs.includes("workspace-write"),
            `expected a workspace-write sandbox in spawned Codex args: ${codexArgs}`
          );
          assert.ok(
            !codexArgs.includes("--dangerously-bypass-approvals-and-sandbox"),
            `bypass flag must not appear in Codex args: ${codexArgs}`
          );
          const result = await withIsolatedCodexHome([workspace], () =>
            Promise.resolve(
              runWorkflowFile(definition, workspace, "sandbox-no-bypass")
            )
          );
          if (logAndMaybeSkip(harness, result)) return;
          assert.ok(
            shellCommandAttempted(workspace, WRITE_SCRIPT),
            `Codex never ran the write\nstdout: ${result.stdout}`
          );
          assert.strictEqual(
            fs.existsSync(outside),
            false,
            `dangerouslyAllowAll bypassed sandbox=true\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
          );
          assert.ok(
            !/--dangerously-bypass-approvals-and-sandbox/.test(
              `${result.stdout}\n${result.stderr}`
            ),
            "Codex reported the bypass argument in its launch output"
          );
        });

        // Codex 0.166.0 lets the bypass flag win over `-s` and runs with
        // danger-full-access, so ctrlyoke must refuse before the CLI starts.
        test("codex-cli: sandbox true with a bypass in additionalArgs fails at launch", async function () {
          const outside = path.join(outsideDir, "outside-additional-args.txt");
          const result = await withIsolatedCodexHome([workspace], () =>
            Promise.resolve(
              runWorkflowFile(
                workflow(harness, prepareOutsideWrite(workspace, outside), {
                  sandbox: true,
                  additionalArgs: "--dangerously-bypass-approvals-and-sandbox",
                }),
                workspace,
                "sandbox-additional-args-bypass"
              )
            )
          );
          if (logAndMaybeSkip(harness, result)) return;
          assert.notStrictEqual(
            result.exitCode,
            0,
            `Codex ran with a bypassed sandbox: true\n${result.stdout}`
          );
          assert.ok(
            /additionalArgs/.test(`${result.stdout}\n${result.stderr}`),
            `failure did not name additionalArgs\n${result.stdout}\n${result.stderr}`
          );
          assert.ok(
            !shellCommandAttempted(workspace, WRITE_SCRIPT),
            "Codex started despite the sandbox failure"
          );
          assert.strictEqual(fs.existsSync(outside), false);
        });

        test("codex-cli: sandbox true closes outbound network", async function () {
          const marker = path.join(workspace, "network-reached.txt");
          const prompt = `Run exactly: node -e "fetch('https://example.com').then(()=>require('fs').writeFileSync('${marker.replace(/\\/g, "/")}','reached')).catch(()=>process.exit(1))". Then stop.`;
          const result = await withIsolatedCodexHome([workspace], () =>
            Promise.resolve(
              runWorkflowFile(
                workflow(harness, prompt, { sandbox: true }),
                workspace,
                "sandbox-network"
              )
            )
          );
          if (logAndMaybeSkip(harness, result)) return;
          // Codex's Windows sandbox (a restricted token) contains writes but
          // never filters network, whatever network_access says; the docs say
          // so. Asserting it flags the day Codex starts blocking it.
          const networkBlocked = process.platform !== "win32";
          assert.strictEqual(
            fs.existsSync(marker),
            !networkBlocked,
            networkBlocked
              ? `Codex reached the network under sandbox=true\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
              : `Codex now blocks network under sandbox=true on Windows: update docs/harnesses/codex-cli.md and the network caveat\nstdout: ${result.stdout}`
          );
        });
      }
    });
  }

  // An explicit `sandbox: true` that cannot be honored must stop the step
  // before the CLI starts: it never reaches a model, so these cost nothing.
  for (const harness of UNSUPPORTED_HARNESSES) {
    test(`${harness}: an explicit sandbox true fails the step at launch`, async function () {
      const root = makeHarnessWorkspaceDir(harness, "cy-sandbox-");
      const workspace = path.join(fs.realpathSync(root), "workspace");
      fs.mkdirSync(workspace);
      initGitRepo(workspace);
      const restoreRunState = isolateRunState(root);
      const marker = path.join(workspace, "ran.txt");
      try {
        const result = await runWorkflowFile(
          workflow(
            harness,
            `Create the file ${marker.replace(/\\/g, "/")} then stop.`,
            { sandbox: true }
          ),
          workspace,
          "sandbox-unsupported"
        );
        if (logAndMaybeSkip(harness, result)) return;
        assert.notStrictEqual(
          result.exitCode,
          0,
          `${harness} ran with an unhonorable sandbox: true\n${result.stdout}`
        );
        assert.ok(
          /sandbox/i.test(`${result.stdout}\n${result.stderr}`),
          `failure did not name the sandbox\n${result.stdout}\n${result.stderr}`
        );
        assert.strictEqual(
          fs.existsSync(marker),
          false,
          `${harness} started despite the sandbox failure`
        );
      } finally {
        restoreRunState();
        removeTempDir(root, (dir) =>
          console.log(`  ⚠  Could not clean up ${dir}`)
        );
      }
    });
  }
});
