import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { AntigravityCliProvider } from "../../core/harness/antigravity/AntigravityCliProvider";
import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";
import { CodexCliProvider } from "../../core/harness/codex/CodexCliProvider";
import { CopilotCliProvider } from "../../core/harness/copilot/CopilotCliProvider";
import { OpenCodeCliProvider } from "../../core/harness/opencode/OpenCodeCliProvider";
import { QwenCliProvider } from "../../core/harness/qwen/QwenCliProvider";
import { CliExecutionSession } from "../../core/harness/shared/CliExecutionSession";
import { ExecutionPlanBuilder } from "../../core/harness/shared/ExecutionPlanBuilder";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import type { ResolvedProperties } from "../../utils/PropertyResolver";

const fsPromises = require("fs/promises") as typeof import("fs/promises");

const resolvedProperties: ResolvedProperties = {
  harness: HARNESS_IDS.CLAUDE_CLI,
  model: "model-x",
  executionMode: "interactive",
  resumeSession: false,
  mcpServers: null,
  hooks: null,
  toolPermissions: null,
};

const providers = [
  [HARNESS_IDS.COPILOT_CLI, () => new CopilotCliProvider()],
  [HARNESS_IDS.CLAUDE_CLI, () => new ClaudeCliProvider()],
  [HARNESS_IDS.CODEX_CLI, () => new CodexCliProvider()],
  [HARNESS_IDS.OPENCODE_CLI, () => new OpenCodeCliProvider()],
  [HARNESS_IDS.QWEN_CLI, () => new QwenCliProvider()],
  [HARNESS_IDS.ANTIGRAVITY_CLI, () => new AntigravityCliProvider()],
] as const;

type MutableFsPromises = Pick<
  typeof fsPromises,
  "writeFile" | "mkdir" | "copyFile"
>;
const mutableFsPromises = fsPromises as unknown as MutableFsPromises;

function createSession(
  executionMode: "interactive" | "headless",
  properties: ResolvedProperties = resolvedProperties
): CliExecutionSession {
  return new CliExecutionSession({
    prompt: { prompt: "prompt text" },
    resolvedProperties: { ...properties, executionMode },
    workflowContext: {
      promptIndex: 0,
      allPrompts: [],
      resolvedProperties: { ...properties, executionMode },
    },
  });
}

function createBuilder(
  provider: ReturnType<(typeof providers)[number][1]>,
  workspaceRoot?: string
): ExecutionPlanBuilder {
  return new ExecutionPlanBuilder({
    provider,
    getWorkspaceRoot: () => workspaceRoot,
    getWorkspaceRoots: () => (workspaceRoot ? [workspaceRoot] : []),
    getExtensionPath: () => "extension",
    getExecutionMode: () => "interactive",
    getEnabledHookNotificationEvents: () => [],
    resolveCliCommand: async (command, args) => ({
      command,
      args: [...args],
      displayCommand: [command, ...args].join(" "),
      launcherKind: "direct",
    }),
  });
}

suite("ExecutionPlanBuilder", () => {
  for (const [harnessId, createProvider] of providers) {
    for (const executionMode of ["interactive", "headless"] as const) {
      test(`${harnessId} ${executionMode} plan matches real execution argv`, async () => {
        const provider = createProvider();
        const session = createSession(executionMode);
        const plan = await createBuilder(provider).plan(session);
        const baseArgs = await provider.buildCliArgs(
          session.prompt,
          executionMode === "interactive",
          "extension",
          undefined,
          undefined,
          session.workflowContext,
          []
        );
        const realArgs =
          executionMode === "interactive"
            ? provider.buildInteractiveArgs(baseArgs, session.promptArgument)
            : provider.buildHeadlessArgs(baseArgs, session.promptArgument);

        assert.deepStrictEqual(plan.cliArgs, realArgs);
        assert.deepStrictEqual(plan.args, realArgs);
        assert.strictEqual(plan.resolvedCommand.command, provider.config.name);
      });
    }
  }

  test("planning does not spawn, write files, or mutate the execution session", async () => {
    const workspaceRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-execution-plan-")
    );
    const originalWriteFile = fsPromises.writeFile;
    const originalMkdir = fsPromises.mkdir;
    const originalCopyFile = fsPromises.copyFile;
    let writeCount = 0;
    let mkdirCount = 0;
    let copyCount = 0;

    mutableFsPromises.writeFile = (async (...args) => {
      writeCount += 1;
      return originalWriteFile(...args);
    }) as typeof fsPromises.writeFile;
    mutableFsPromises.mkdir = (async (...args) => {
      mkdirCount += 1;
      return originalMkdir(...args);
    }) as typeof fsPromises.mkdir;
    mutableFsPromises.copyFile = (async (...args) => {
      copyCount += 1;
      return originalCopyFile(...args);
    }) as typeof fsPromises.copyFile;

    try {
      const properties: ResolvedProperties = {
        ...resolvedProperties,
        mcpServers: ["ctrlyoke"],
        hooks: [{ event: "stop", command: "node stop.js" }],
      };
      for (const [, createProvider] of providers) {
        const session = createSession("headless", properties);
        const before = session.toSnapshot();
        await createBuilder(createProvider(), workspaceRoot).plan(session);
        assert.deepStrictEqual(session.toSnapshot(), before);
      }
      assert.strictEqual(writeCount, 0);
      assert.strictEqual(mkdirCount, 0);
      assert.strictEqual(copyCount, 0);
    } finally {
      mutableFsPromises.writeFile = originalWriteFile;
      mutableFsPromises.mkdir = originalMkdir;
      mutableFsPromises.copyFile = originalCopyFile;
      await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("hooks:null suppresses inherited custom hooks and hook notifications", async () => {
    const provider = new ClaudeCliProvider();
    let capturedUserHooks: unknown;
    let capturedEvents: unknown;
    Object.defineProperty(provider, "planNotificationHookArgs", {
      value: async (
        _extensionPath: string,
        _workspaceRoot: string,
        _promptIndex: number,
        _workingFilePath: string | undefined,
        userHooks: unknown,
        events: unknown
      ) => {
        capturedUserHooks = userHooks;
        capturedEvents = events;
        return { cliArgs: [], mutations: [], diagnostics: [] };
      },
    });
    const workspaceRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-execution-plan-hooks-null-")
    );

    try {
      const session = createSession("interactive", {
        ...resolvedProperties,
        hooks: null,
      });
      const plan = await new ExecutionPlanBuilder({
        provider,
        getWorkspaceRoot: () => workspaceRoot,
        getWorkspaceRoots: () => [workspaceRoot],
        getExtensionPath: () => "extension",
        getExecutionMode: () => "interactive",
        getEnabledHookNotificationEvents: () => ["notification"],
      }).plan(session);

      assert.ok(plan);
      assert.strictEqual(capturedUserHooks, undefined);
      assert.deepStrictEqual(capturedEvents, []);
    } finally {
      await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
