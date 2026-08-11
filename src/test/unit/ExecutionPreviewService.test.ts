import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import {
  ExecutionPreviewService,
  defaultCommandDisplayShell,
  type ExecutionPreviewHarness,
} from "../../core/ExecutionPreviewService";
import { renderCommandForDisplay } from "../../types/CommandDisplayFormatter";
import { CliPromptPreparer } from "../../core/harness/shared/CliPromptPreparer";
import { ExecutionPlanBuilder } from "../../core/harness/shared/ExecutionPlanBuilder";
import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";
import {
  HARNESS_IDS,
  PREVIEW_MUTATION_SCOPES,
  PREVIEW_SCOPES,
} from "../../types/DashboardConstants";
import type { HarnessCapabilityRegistrySnapshot } from "../../types/CompatibilityTypes";
import type { PromptFile } from "../../types/CtrlYokeTypes";
import type { ExecutionPropertyDefaults } from "../../types/ExecutionPropertyResolver";
import type { ExecutionPlan } from "../../core/harness/shared/ExecutionPlanBuilder";
import type { PreparedMutation } from "../../core/harness/shared/interfaces/PreparedMutation";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

const fsPromises = fs.promises;
let temporaryRoots: string[] = [];

function createDefaults(): ExecutionPropertyDefaults {
  return {
    harness: HARNESS_IDS.CLAUDE_CLI,
    modelsByHarness: { [HARNESS_IDS.CLAUDE_CLI]: "default-model" },
    additionalArgsByHarness: {},
    executionMode: "headless",
    resumeSession: false,
    mcpServers: [],
    hooks: null,
  };
}

function createCapabilities(): HarnessCapabilityRegistrySnapshot {
  const provider = new ClaudeCliProvider();
  const permissions = provider.toolPermissionMapper.capabilities;
  const state = {
    fidelity: "exact" as const,
    mechanism: "native" as const,
    verification: "verified" as const,
  };
  return {
    schemaVersion: 1,
    enabledDomains: ["permissions"],
    harnesses: {
      [HARNESS_IDS.CLAUDE_CLI]: {
        available: true,
        version: "1.0.0",
        descriptor: { harnessId: HARNESS_IDS.CLAUDE_CLI, permissions },
        effective: {
          permissions: {
            mode: state,
            allowedTools: state,
            deniedTools: state,
          },
        },
      },
    },
  } as HarnessCapabilityRegistrySnapshot;
}

function createPromptPreparer(): CliPromptPreparer {
  return new CliPromptPreparer({
    shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
    buildPromptSections: async (prompt) => ({
      skillContent: null,
      agentContent: null,
      directFileRefs: [],
      excerptContent: null,
      userPromptText: prompt.prompt,
    }),
    extractLeadingSlashCommand: () => null,
    isSimplePrompt: () => true,
    buildPriorContextXmlFromItems: () => "",
    getWorkspaceRoot: () => undefined,
    getTempFileSplitConfig: () => undefined,
    formatDirectFileRef: (value) => value,
    formatTempFileRef: (_manager, value) => value,
    formatCategorizedReferences: (
      _agents,
      _skills,
      _files,
      _context,
      _excerpts,
      prompts
    ) => prompts.join(" "),
  });
}

function createHarness(workspaceRoot?: string): ExecutionPreviewHarness {
  const provider = new ClaudeCliProvider();
  return {
    provider,
    promptPreparer: createPromptPreparer(),
    executionPlanBuilder: new ExecutionPlanBuilder({
      provider,
      getWorkspaceRoot: () => workspaceRoot,
      getWorkspaceRoots: () => (workspaceRoot ? [workspaceRoot] : []),
      getExtensionPath: () => "extension",
      getExecutionMode: () => "headless",
      getEnabledHookNotificationEvents: () => [],
      resolveCliCommand: async (command, args) => ({
        command,
        args: [...args],
        displayCommand: [command, ...args].join(" "),
        launcherKind: "direct",
      }),
    }),
  };
}

function createExecutionPlan(mutations: PreparedMutation[]): ExecutionPlan {
  const providerPreparation = {
    cliArgs: [],
    mutations,
    diagnostics: [],
  };
  const resolvedCommand = {
    command: "claude",
    args: [],
    displayCommand: "claude",
    launcherKind: "direct" as const,
  };
  return {
    resolvedCommand,
    args: [],
    cliArgs: [],
    mutations,
    providerPreparation,
    permissionApplication: { cliArgs: [], diagnostics: [] },
    mcpApplication: providerPreparation,
    effectiveToolPermissions: undefined,
    diagnostics: [],
  };
}

function createService(
  workspaceRoot?: string,
  plannedMutations?: PreparedMutation[]
): ExecutionPreviewService {
  const harness = createHarness(workspaceRoot);
  if (plannedMutations) {
    harness.executionPlanBuilder.plan = async () =>
      createExecutionPlan(plannedMutations);
  }
  return new ExecutionPreviewService({
    defaults: createDefaults(),
    capabilities: createCapabilities(),
    getHarness: () => harness,
    workspaceRoot,
    workspaceRoots: workspaceRoot ? [workspaceRoot] : [],
    extensionPath: "extension",
    hostCanProvidePty: false,
    platform: "linux",
  });
}

suite("ExecutionPreviewService", () => {
  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  });

  test("resolves authored prompt-file paths at preview time after substitution", async () => {
    const workspaceRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preview-prompt-file-")
    );
    temporaryRoots.push(workspaceRoot);
    const promptPath = path.join(workspaceRoot, "current.prompt.md");
    const sourcePath = path.join(workspaceRoot, "workflow.ctrlyoke.json");
    await fsPromises.writeFile(promptPath, "preview contents", "utf8");

    const workflow: PromptFile = {
      vars: { name: "current" },
      steps: [{ prompt: "./{{name}}.prompt.md" }],
    };
    const preview = await createService(workspaceRoot).build({
      workflow,
      sourcePath,
      sourceDefinitionPath: sourcePath,
    });

    assert.ok(
      preview.steps[0].prompt?.sections.some((section) =>
        section.body?.includes("preview contents")
      )
    );
    assert.ok(
      !JSON.stringify(preview.steps[0].prompt).includes("{{name}}.prompt.md")
    );
  });

  test("rejects empty and missing prompt-file references during preview", async () => {
    const workspaceRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preview-invalid-prompt-file-")
    );
    temporaryRoots.push(workspaceRoot);
    await fsPromises.writeFile(
      path.join(workspaceRoot, "empty.prompt.md"),
      " \n\t",
      "utf8"
    );
    const sourcePath = path.join(workspaceRoot, "workflow.ctrlyoke.json");

    await assert.rejects(
      createService(workspaceRoot).build({
        workflow: { steps: [{ prompt: "./empty.prompt.md" }] },
        sourceDefinitionPath: sourcePath,
      }),
      /empty after resolving|empty/i
    );
    await assert.rejects(
      createService(workspaceRoot).build({
        workflow: { steps: [{ prompt: "./missing.prompt.md" }] },
        sourceDefinitionPath: sourcePath,
      }),
      /could not be found/
    );
  });

  test("uses shared planning paths and produces a step-scoped DTO", async () => {
    const workflow: PromptFile = {
      harness: HARNESS_IDS.CLAUDE_CLI,
      model: "workflow-model",
      steps: [
        {
          name: "Inspect",
          prompt: "inspect {{target}}",
          toolPermissions: {
            mode: "custom",
            allowedTools: ["read"],
          },
        },
        { prompt: "not selected" },
      ],
      vars: { target: "src/app.ts" },
    };

    const preview = await createService().build({
      workflow,
      scope: { kind: PREVIEW_SCOPES.STEP, stepIndex: 0 },
      workflowName: "inspection",
    });

    assert.strictEqual(preview.steps.length, 1);
    assert.strictEqual(preview.steps[0].stepName, "Inspect");
    assert.strictEqual(
      preview.steps[0].resolvedProperties.model,
      "workflow-model"
    );
    assert.strictEqual(
      preview.steps[0].resolvedProperties.propertySources.model,
      "workflow"
    );
    assert.ok(preview.steps[0].command);
    assert.ok(preview.steps[0].command?.args.includes("inspect src/app.ts"));
    assert.ok(preview.steps[0].command?.args.includes("--model"));
    assert.ok(
      preview.steps[0].prompt?.sections.some((section) =>
        section.body?.includes("src/app.ts")
      )
    );
  });

  test("omits MCP environment values while retaining structural key names", async () => {
    const root = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preview-")
    );
    temporaryRoots.push(root);
    const secret = "preview-very-secret-token-value";
    const workflow: PromptFile = {
      steps: [
        {
          prompt: "use the service",
          mcpServers: [
            {
              id: "private-service",
              command: "node",
              env: { PRIVATE_API_KEY: secret },
            },
          ],
        },
      ],
    };

    const writes: string[] = [];
    const originalWriteFile = fsPromises.writeFile;
    fsPromises.writeFile = (async (...args) => {
      writes.push(String(args[0]));
      return originalWriteFile(...args);
    }) as typeof fsPromises.writeFile;
    try {
      const preview = await createService(root).build({ workflow });
      const serialized = JSON.stringify(preview);
      assert.ok(serialized.includes("PRIVATE_API_KEY"));
      assert.ok(!serialized.includes(secret));
      assert.deepStrictEqual(
        preview.steps[0].mcpApplication?.servers[0].environmentKeys,
        ["PRIVATE_API_KEY"]
      );
      assert.deepStrictEqual(writes, []);
    } finally {
      fsPromises.writeFile = originalWriteFile;
    }
  });

  test("defaults Windows command display to PowerShell and POSIX to sh-style quoting", () => {
    assert.strictEqual(defaultCommandDisplayShell("win32"), "powershell");
    assert.strictEqual(defaultCommandDisplayShell("linux"), "posix");

    const windows = renderCommandForDisplay(
      "node",
      ["a path/file.ts", "x&y"],
      defaultCommandDisplayShell("win32")
    );
    assert.ok(windows.includes("'a path/file.ts'"));
    assert.ok(windows.includes("'x&y'"));

    const cmd = renderCommandForDisplay(
      "node",
      ["a path/file.ts", "x&y"],
      "cmd"
    );
    assert.ok(cmd.includes("^&"));
    assert.ok(cmd.includes("a^ path/file.ts"));

    const posix = renderCommandForDisplay(
      "/usr/bin/node",
      ["a path/file.ts", "it's ready"],
      defaultCommandDisplayShell("linux")
    );
    assert.ok(posix.includes("'a path/file.ts'"));
    assert.ok(posix.includes(`'it'"'"'s ready'`));
  });

  test("does not execute conditions or resolve external session state", async () => {
    let conditionExecuted = false;
    const workflow: PromptFile = {
      steps: [
        {
          prompt: "safe preview",
          preCondition: {
            script: 'node -e "condition"',
            onPass: "continue",
          },
          endCondition: {
            script: 'node -e "condition"',
            returns: "ok",
          },
        },
      ],
    };
    const preview = await createService().build({ workflow });
    conditionExecuted = preview.steps[0].conditions.pre[0].configured;
    assert.strictEqual(conditionExecuted, true);
    assert.strictEqual(preview.steps[0].conditions.end[0].configured, true);
    assert.ok(preview.steps[0].conditions.pre[0].scriptPath);
  });

  test("classifies mutation scope, warnings, and owned keys", async () => {
    const workspaceRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preview-workspace-")
    );
    temporaryRoots.push(workspaceRoot);

    const tempPath = path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.TEMP_DIR,
      "hook-settings.json"
    );
    const reportedTempPath =
      process.platform === "win32"
        ? tempPath
            .replace(/\\/g, "/")
            .replace(/\.ctrlyoke\/temp/i, ".CTRLYOKE/TEMP")
        : tempPath;
    const mutations: PreparedMutation[] = [
      {
        path: reportedTempPath,
        intendedContent: '{"hooks": []}',
        description: "run-local hook settings",
        apply: async () => {},
      },
      {
        path: path.join(workspaceRoot, ".qwen", "settings.json"),
        ownedKeys: ["hooks", "trustedHooks"],
        description: "shared Qwen settings",
        apply: async () => {},
      },
      {
        path: path.join(os.homedir(), ".gemini", "config", "hooks.json"),
        description: "Antigravity global hooks",
        apply: async () => {},
      },
      {
        intendedContent: '{"fallbackKey": true}',
        description: "process state",
        apply: async () => {},
      },
    ];

    const preview = await createService(workspaceRoot, mutations).build({
      workflow: { steps: [{ prompt: "classify mutations" }] },
    });
    const actual = preview.steps[0].workspaceMutations;

    assert.deepStrictEqual(
      actual.map((mutation) => mutation.scope),
      [
        PREVIEW_MUTATION_SCOPES.RUN_LOCAL,
        PREVIEW_MUTATION_SCOPES.SHARED,
        PREVIEW_MUTATION_SCOPES.SHARED,
        PREVIEW_MUTATION_SCOPES.RUN_LOCAL,
      ]
    );
    assert.deepStrictEqual(actual[0].ownedKeys, ["hooks"]);
    assert.deepStrictEqual(actual[1].ownedKeys, ["hooks", "trustedHooks"]);
    assert.deepStrictEqual(actual[3].ownedKeys, ["fallbackKey"]);
    assert.strictEqual(actual[0].warning, undefined);
    assert.ok(actual[1].warning);
    assert.ok(actual[2].warning);
    assert.strictEqual(actual[3].warning, undefined);
    assert.strictEqual(actual[3].path, undefined);
    assert.strictEqual(actual[3].operation, "process-local");
  });

  test("classifies the cleanup mutation by its temp directory path", async () => {
    const workspaceRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preview-cleanup-")
    );
    temporaryRoots.push(workspaceRoot);

    const preview = await createService(workspaceRoot).build({
      workflow: {
        hooks: [],
        steps: [{ prompt: "prepare hooks" }],
      },
    });
    const tempDirectory = path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.TEMP_DIR
    );
    const cleanup = preview.steps[0].workspaceMutations.find(
      (mutation) => mutation.path === tempDirectory
    );

    assert.ok(cleanup);
    assert.strictEqual(cleanup.scope, PREVIEW_MUTATION_SCOPES.RUN_LOCAL);
    assert.strictEqual(cleanup.warning, undefined);
  });

  test("never applies planned mutations during preview", async () => {
    let applied = false;
    const mutation: PreparedMutation = {
      path: path.join(os.tmpdir(), "ctrlyoke-preview-must-not-exist.json"),
      description: "preview-only mutation",
      apply: async () => {
        applied = true;
      },
    };

    const preview = await createService(undefined, [mutation]).build({
      workflow: { steps: [{ prompt: "read-only preview" }] },
    });

    assert.strictEqual(applied, false);
    assert.strictEqual(preview.steps[0]?.workspaceMutations.length, 1);
  });
});
