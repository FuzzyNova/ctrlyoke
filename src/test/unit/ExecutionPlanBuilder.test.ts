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
import { resolveHookNotificationPlan } from "../../core/harness/shared/HookNotificationPlan";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";
import {
  EFFECTIVE_SANDBOX_KINDS,
  EXECUTION_MODES,
  HARNESS_IDS,
} from "../../types/DashboardConstants";
import type { ResolvedProperties } from "../../utils/PropertyResolver";
import type { PromptFile } from "../../types/CtrlYokeTypes";
import { COMPATIBILITY_DIAGNOSTIC_CODES } from "../../types/CompatibilityTypes";

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
  properties: ResolvedProperties = resolvedProperties,
  workflowFile?: PromptFile
): CliExecutionSession {
  return new CliExecutionSession({
    prompt: { prompt: "prompt text" },
    resolvedProperties: { ...properties, executionMode },
    workflowContext: {
      promptIndex: 0,
      allPrompts: [],
      resolvedProperties: { ...properties, executionMode },
      ...(workflowFile ? { workflowFile } : {}),
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
    getInstallHookNotificationEvents: () => [],
    resolveCliCommand: async (command, args) => ({
      command,
      args: [...args],
      displayCommand: [command, ...args].join(" "),
      launcherKind: "direct",
    }),
  });
}

suite("ExecutionPlanBuilder", () => {
  test("merges Claude sandbox settings into its single hook settings file in both modes", async () => {
    const provider = new ClaudeCliProvider();
    provider.getVersion = async () => "2.1.316";
    const properties: ResolvedProperties = {
      ...resolvedProperties,
      sandbox: true,
      hooks: null,
    };
    const workspaceRoot = path.join(os.tmpdir(), "claude-sandbox-plan");

    for (const mode of ["interactive", "headless"] as const) {
      const plan = await createBuilder(provider, workspaceRoot).plan(
        createSession(mode, properties)
      );
      const settingsMutation = plan.mutations.find(
        (mutation) =>
          mutation.description?.includes("Claude") &&
          mutation.description?.includes("hook settings")
      );
      assert.ok(settingsMutation?.intendedContent);
      const settings = JSON.parse(settingsMutation.intendedContent) as {
        sandbox?: { enabled?: boolean; filesystem?: { allowWrite?: string[] } };
      };
      assert.strictEqual(settings.sandbox?.enabled, true, mode);
      assert.ok(
        settings.sandbox?.filesystem?.allowWrite?.includes(workspaceRoot)
      );
      assert.strictEqual(
        plan.cliArgs.filter((arg) => arg === "--settings").length,
        1,
        mode
      );
    }
  });

  test("refuses a Claude sandbox that additionalArgs --settings would replace", async () => {
    const provider = new ClaudeCliProvider();
    provider.getVersion = async () => "2.1.317";
    const properties: ResolvedProperties = {
      ...resolvedProperties,
      sandbox: true,
      additionalArgs: "--settings=user.json",
    };
    const workspaceRoot = path.join(os.tmpdir(), "claude-sandbox-plan");
    await assert.rejects(
      createBuilder(provider, workspaceRoot).plan(
        createSession("headless", properties)
      ),
      /additionalArgs passes its own --settings/
    );
  });

  test("refuses a Claude sandbox with no workspace to write its settings to", async () => {
    const provider = new ClaudeCliProvider();
    provider.getVersion = async () => "2.1.317";
    await assert.rejects(
      createBuilder(provider).plan(
        createSession("headless", { ...resolvedProperties, sandbox: true })
      ),
      /sandboxing needs a workspace folder/
    );
  });

  test("refuses an authored sandbox on a harness that can't sandbox, but only warns for defaults.sandbox", async () => {
    const unsupported = [
      HARNESS_IDS.COPILOT_CLI,
      HARNESS_IDS.QWEN_CLI,
      HARNESS_IDS.OPENCODE_CLI,
      HARNESS_IDS.ANTIGRAVITY_CLI,
    ];
    for (const [harnessId, create] of providers) {
      if (!(unsupported as readonly string[]).includes(harnessId)) continue;
      const provider = create();
      const properties: ResolvedProperties = {
        ...resolvedProperties,
        harness: harnessId,
        sandbox: true,
      };
      // No workflow file: the request is treated as authored (fail closed).
      await assert.rejects(
        createBuilder(provider).plan(createSession("headless", properties)),
        /can't sandbox commands/,
        harnessId
      );
      const preview = await createBuilder(provider).plan(
        createSession("headless", properties),
        { allowUnsupportedSandboxPreview: true }
      );
      // Dry Run must not call an uncontained step "Sandboxed".
      assert.strictEqual(
        preview.effectiveSandbox?.kind,
        EFFECTIVE_SANDBOX_KINDS.OFF,
        harnessId
      );

      // Neither the step nor the workflow wrote it: defaults.sandbox did.
      const inherited = await createBuilder(provider).plan(
        createSession("headless", properties, { steps: [] })
      );
      assert.ok(
        inherited.diagnostics.some(
          (item) =>
            item.code === COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_DEFAULT_SKIPPED
        ),
        harnessId
      );
      assert.strictEqual(
        inherited.effectiveSandbox?.kind,
        EFFECTIVE_SANDBOX_KINDS.HARNESS,
        harnessId
      );
    }
  });

  test("passes Qwen's off switch as a flag and a process environment variable", async () => {
    const provider = new QwenCliProvider();
    const plan = await createBuilder(provider).plan(
      createSession("headless", {
        ...resolvedProperties,
        harness: HARNESS_IDS.QWEN_CLI,
        sandbox: false,
      })
    );
    assert.ok(plan.cliArgs.includes("--sandbox=false"), plan.cliArgs.join(" "));
    const envMutation = plan.mutations.find(
      (mutation) => mutation.description === "Set sandbox process environment"
    );
    assert.ok(envMutation);
    let applied: Readonly<Record<string, string>> | undefined;
    provider.setSandboxSpawnEnv = (env) => {
      applied = env;
    };
    await envMutation.apply();
    assert.deepStrictEqual(applied, { QWEN_SANDBOX: "false" });

    // The next launch without Off clears it again.
    const none = await createBuilder(provider).plan(
      createSession("headless", {
        ...resolvedProperties,
        harness: HARNESS_IDS.QWEN_CLI,
        sandbox: null,
      })
    );
    assert.ok(!none.cliArgs.some((arg) => arg.startsWith("--sandbox")));
    await none.mutations
      .find(
        (mutation) => mutation.description === "Set sandbox process environment"
      )!
      .apply();
    assert.deepStrictEqual(applied, {});
  });

  test("turns Copilot's sandbox off with --no-sandbox and passes nothing for None", async () => {
    const plan = (sandbox: boolean | null) =>
      createBuilder(new CopilotCliProvider()).plan(
        createSession("headless", {
          ...resolvedProperties,
          harness: HARNESS_IDS.COPILOT_CLI,
          sandbox,
        })
      );
    assert.ok((await plan(false)).cliArgs.includes("--no-sandbox"));
    assert.ok(!(await plan(null)).cliArgs.includes("--no-sandbox"));
  });

  test("uses a stable but step-specific env file for Qwen hooks", async () => {
    const workspaceRoot = "workspace";
    const properties: ResolvedProperties = {
      ...resolvedProperties,
      harness: HARNESS_IDS.QWEN_CLI,
      hooks: [
        {
          event: "stop",
          command: "echo hook",
          env: { TOKEN: "value" },
        },
      ],
    };
    const builder = createBuilder(new QwenCliProvider(), workspaceRoot);
    const makeSession = (promptIndex: number) =>
      new CliExecutionSession({
        prompt: { prompt: "prompt text" },
        resolvedProperties: properties,
        workflowContext: {
          promptIndex,
          allPrompts: [],
          resolvedProperties: properties,
          workingFilePath: "workflow.yaml",
        },
      });

    const stepZero = await builder.plan(makeSession(0));
    const stepOne = await builder.plan(makeSession(1));
    const rerunStepZero = await builder.plan(makeSession(0));

    assert.notStrictEqual(
      stepZero.deferredHookEnvironmentFilePaths[0],
      stepOne.deferredHookEnvironmentFilePaths[0]
    );
    assert.strictEqual(
      stepZero.deferredHookEnvironmentFilePaths[0],
      rerunStepZero.deferredHookEnvironmentFilePaths[0]
    );
  });

  test("passes the resolved execution mode to image argument builders", async () => {
    const provider = new OpenCodeCliProvider();
    const receivedModes: boolean[] = [];
    provider.buildImageAttachmentArgs = (_paths, isInteractive) => {
      receivedModes.push(isInteractive);
      return [];
    };

    for (const mode of ["interactive", "headless"] as const) {
      const session = createSession(mode);
      session.preparePrompt(
        "Describe shots/diagram.png",
        [],
        ["shots/diagram.png"]
      );
      await createBuilder(provider).plan(session);
    }

    assert.deepStrictEqual(receivedModes, [true, false]);
  });

  test("omits OpenCode image flags interactively and keeps them headlessly", async () => {
    const provider = new OpenCodeCliProvider();
    const plans = [];

    for (const mode of ["interactive", "headless"] as const) {
      const session = createSession(mode);
      session.preparePrompt(
        "Describe shots/diagram.png",
        [],
        ["shots/diagram.png"]
      );
      plans.push(await createBuilder(provider).plan(session));
    }

    assert.ok(!plans[0].cliArgs.includes("--file"));
    // The headless prompt is piped on stdin, so it is not an argument.
    assert.ok(!plans[1].cliArgs.includes("Describe shots/diagram.png"));
    const imageFlagIndex = plans[1].cliArgs.indexOf("--file");
    assert.deepStrictEqual(plans[1].cliArgs.slice(imageFlagIndex), [
      "--file",
      "shots/diagram.png",
    ]);
  });

  test("places Codex image flags after the headless prompt", async () => {
    const session = createSession("headless");
    session.preparePrompt(
      "Describe shots/diagram.png",
      [],
      ["shots/diagram.png"]
    );
    const plan = await createBuilder(new CodexCliProvider()).plan(session);
    const promptIndex = plan.cliArgs.indexOf("Describe shots/diagram.png");
    const imageFlagIndex = plan.cliArgs.indexOf("--image");

    assert.ok(promptIndex >= 0 && promptIndex < imageFlagIndex);
    assert.deepStrictEqual(plan.cliArgs.slice(imageFlagIndex), [
      "--image",
      "shots/diagram.png",
    ]);
  });

  test("normalizes MCP deny rules only for Claude", async () => {
    const properties: ResolvedProperties = {
      ...resolvedProperties,
      harness: HARNESS_IDS.CLAUDE_CLI,
      mcpServers: [
        {
          id: "io.github.upstash/context7",
          deniedTools: ["resolve-library-id"],
        },
      ],
      toolPermissions: { mode: "custom", allowedTools: [], deniedTools: [] },
    };
    const session = createSession("headless", properties);
    const plan = await createBuilder(new ClaudeCliProvider()).plan(session);

    assert.deepStrictEqual(plan.effectiveToolPermissions?.deniedTools, [
      "mcp__io_github_upstash_context7__resolve-library-id",
    ]);
  });

  for (const [harnessId, createProvider] of providers) {
    for (const executionMode of ["interactive", "headless"] as const) {
      test(`${harnessId} ${executionMode} plan matches real execution argv`, async () => {
        const provider = createProvider();
        const session = createSession(executionMode);
        const plan = await createBuilder(provider).plan(session);
        const baseArgs = await provider.buildCliArgs(
          session.prompt,
          executionMode === EXECUTION_MODES.INTERACTIVE,
          "extension",
          undefined,
          undefined,
          session.workflowContext,
          []
        );
        const realArgs =
          executionMode === EXECUTION_MODES.INTERACTIVE
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
        getInstallHookNotificationEvents: (hooksDisabled) =>
          hooksDisabled ? [] : ["notification"],
      }).plan(session);

      assert.ok(plan);
      assert.strictEqual(capturedUserHooks, undefined);
      assert.deepStrictEqual(capturedEvents, []);
    } finally {
      await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("forwards an install-only notification source to the provider", async () => {
    const provider = new CodexCliProvider();
    let capturedEvents: unknown;
    Object.defineProperty(provider, "planNotificationHookArgs", {
      value: async (
        _extensionPath: string,
        _workspaceRoot: string,
        _promptIndex: number,
        _workingFilePath: string | undefined,
        _userHooks: unknown,
        events: unknown
      ) => {
        capturedEvents = events;
        return { cliArgs: [], mutations: [], diagnostics: [] };
      },
    });
    const workspaceRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-execution-plan-notification-source-")
    );
    const settings = {
      ...CTRLYOKE_SETTINGS_DEFAULTS.notifications,
      events: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.notifications.events,
        hookEvents: {
          ...CTRLYOKE_SETTINGS_DEFAULTS.notifications.events.hookEvents,
          permissionRequest: false,
        },
      },
    };
    const plan = resolveHookNotificationPlan(HARNESS_IDS.CODEX_CLI, settings);

    try {
      await new ExecutionPlanBuilder({
        provider,
        getWorkspaceRoot: () => workspaceRoot,
        getWorkspaceRoots: () => [workspaceRoot],
        getExtensionPath: () => "extension",
        getExecutionMode: () => "interactive",
        getInstallHookNotificationEvents: (hooksDisabled) =>
          resolveHookNotificationPlan(HARNESS_IDS.CODEX_CLI, settings, {
            hooksDisabled,
          }).installEvents,
      }).plan(
        createSession("interactive", {
          ...resolvedProperties,
          harness: HARNESS_IDS.CODEX_CLI,
          hooks: [],
        })
      );

      assert.deepStrictEqual(plan.emitRawEvents, []);
      assert.deepStrictEqual(plan.installEvents, ["permissionRequest"]);
      assert.deepStrictEqual(capturedEvents, plan.installEvents);
    } finally {
      await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
