/**
 * Native sandbox end-to-end checks. These run only in `npm run test:harness`.
 * The outside target is a sibling of the workspace under the test temp root,
 * never a path in the developer's home directory.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { CLI_EVENT_TYPES, HARNESS_IDS, HOOK_EVENT_NAMES, PERMISSION_MODES } from "../../types/DashboardConstants";
import type { PromptFile, UserHookConfig } from "../../types/CtrlYokeTypes";
import { HarnessCapabilityRegistry } from "../../core/HarnessCapabilityRegistry";
import { CodexToolPermissionMapper } from "../../core/harness/codex/CodexToolPermissionMapper";
import { CliNotificationMonitor } from "../../core/harness/shared/CliNotificationMonitor";
import { removeTempDir } from "../helpers/tempWorkspace";
import {
  HARNESS_MODELS,
  HARNESS_TIMEOUT_MS,
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
const SANDBOXED_HARNESSES = facts.harnesses
  .filter((entry) => entry.capabilities.sandbox?.terminal.fidelity !== "unsupported")
  .map((entry) => entry.harnessId as HarnessId);

function workflow(harness: HarnessId, prompt: string, extra: Partial<PromptFile> = {}): PromptFile {
  return {
    harness,
    ...(HARNESS_MODELS[harness] ? { model: HARNESS_MODELS[harness] } : {}),
    ...extra,
    steps: [{ name: "sandbox-check", prompt }],
  };
}

function shellWrite(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return `Run exactly this command once: node -e "require('fs').writeFileSync('${normalized}','sandbox-marker')". Then stop.`;
}

suite("Harness sandbox tests", function () {
  this.timeout(HARNESS_TIMEOUT_MS);

  for (const harness of SANDBOXED_HARNESSES) {
    suite(harness, function () {
      let root: string;
      let workspace: string;
      let restoreRunState: () => void;

      setup(function () {
        root = makeHarnessWorkspaceDir(harness, "cy-sandbox-");
        workspace = path.join(root, "workspace");
        fs.mkdirSync(workspace);
        initGitRepo(workspace);
        restoreRunState = isolateRunState(root);
      });

      teardown(function () {
        restoreRunState();
        if (!process.env.CTRLYOKE_HARNESS_KEEP_WORKSPACES) {
          removeTempDir(root, (dir) => console.log(`  ⚠  Could not clean up ${dir}`));
        } else {
          console.log(`  ↳ workspace kept: ${root}`);
        }
      });

      for (const sandbox of [true, false] as const) {
        test(`${harness}: sandbox ${sandbox} ${sandbox ? "blocks" : "allows"} a sibling write`, async function () {
          const outside = path.join(root, `outside-${sandbox}.txt`);
          const definition = workflow(harness, shellWrite(outside), { sandbox });
          const run = async () => runWorkflowFile(definition, workspace, `sandbox-write-${sandbox}`);
          const result = harness === HARNESS_IDS.CODEX_CLI
            ? await withIsolatedCodexHome([workspace], run)
            : await run();
          if (logAndMaybeSkip(harness, result)) return;
          assert.strictEqual(fs.existsSync(outside), !sandbox,
            `${harness}: sandbox=${sandbox} outside write state was unexpected\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
          if (!sandbox) assert.strictEqual(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
        });
      }

      test(`${harness}: global_status and completion hook work with sandbox enabled`, async function () {
        const hookLog = path.join(root, "hooks.jsonl");
        const recorder = path.join(root, "record-hook.js");
        fs.writeFileSync(recorder, buildHookRecorderScript());
        const hooks: UserHookConfig[] = [{
          event: HOOK_EVENT_NAMES.STOP,
          command: CliNotificationMonitor.buildNodeCommand(
            recorder,
            [HOOK_EVENT_NAMES.STOP, hookLog],
            CliNotificationMonitor.shouldQuoteNodeCommand(harness)
          ),
        }];
        const definition = workflow(harness,
          "Call ctrlyoke's global_status MCP tool once, then reply OK.",
          { sandbox: true, hooks });
        const run = async () => runWorkflowFile(definition, workspace, "sandbox-mcp-hooks");
        const result = harness === HARNESS_IDS.CODEX_CLI
          ? await withIsolatedCodexHome([workspace], run)
          : await run();
        if (logAndMaybeSkip(harness, result)) return;
        assert.strictEqual(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
        const eventsPath = findRunFiles(runsRootFor(workspace), "events.jsonl")[0];
        assert.ok(eventsPath, "run timeline was not recorded");
        const mcpEvents = readRecordedCliEvents(eventsPath).filter((event) => event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL);
        assert.ok(mcpEvents.some((event) => JSON.stringify(event).includes("global_status")),
          `global_status was not called: ${JSON.stringify(mcpEvents)}`);
        assert.ok(readRecordedHookEvents(hookLog).has(HOOK_EVENT_NAMES.STOP),
          "completion hook did not fire under sandbox=true");
      });

      if (harness === HARNESS_IDS.CODEX_CLI) {
        test("codex-cli: dangerouslyAllowAll with sandbox true does not bypass the sandbox", async function () {
          const outside = path.join(root, "outside-dangerously-allow-all.txt");
          const definition = workflow(harness, shellWrite(outside), {
            sandbox: true,
            toolPermissions: { mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL },
          });
          // Assert the exact provider arguments used for this permission mode:
          // sandbox=true must suppress the normal all-access bypass flag.
          const codexArgs = new CodexToolPermissionMapper().buildCodexSpecificArgs(
            { mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, allowedTools: [], deniedTools: [] },
            undefined,
            undefined,
            false,
            undefined,
            true
          );
          assert.ok(codexArgs.includes("-s") && codexArgs.includes("workspace-write"),
            `expected a workspace-write sandbox in spawned Codex args: ${codexArgs}`);
          assert.ok(!codexArgs.includes("--dangerously-bypass-approvals-and-sandbox"),
            `bypass flag must not appear in Codex args: ${codexArgs}`);
          const result = await withIsolatedCodexHome([workspace], () =>
            Promise.resolve(runWorkflowFile(definition, workspace, "sandbox-no-bypass"))
          );
          if (logAndMaybeSkip(harness, result)) return;
          assert.strictEqual(fs.existsSync(outside), false,
            `dangerouslyAllowAll bypassed sandbox=true\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
          assert.ok(!/--dangerously-bypass-approvals-and-sandbox/.test(`${result.stdout}\n${result.stderr}`),
            "Codex reported the bypass argument in its launch output");
        });

        test("codex-cli: sandbox true closes outbound network", async function () {
          const marker = path.join(workspace, "network-reached.txt");
          const prompt = `Run exactly: node -e "fetch('https://example.com').then(()=>require('fs').writeFileSync('${marker.replace(/\\/g, "/")}','reached')).catch(()=>process.exit(1))". Then stop.`;
          const result = await withIsolatedCodexHome([workspace], () =>
            Promise.resolve(runWorkflowFile(workflow(harness, prompt, { sandbox: true }), workspace, "sandbox-network"))
          );
          if (logAndMaybeSkip(harness, result)) return;
          assert.strictEqual(fs.existsSync(marker), false,
            `Codex reached the network under sandbox=true\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
        });
      }
    });
  }
});
