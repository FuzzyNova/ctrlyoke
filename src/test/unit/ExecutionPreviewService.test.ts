import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { suite, teardown, test } from "mocha";
import {
  ExecutionPreviewService,
  defaultCommandDisplayShell,
  type ExecutionPreviewHarness,
} from "../../core/ExecutionPreviewService";
import type { PromptSections } from "../../core/HarnessIntegration";
import {
  COMMAND_DISPLAY_SHELLS,
  renderCommandForDisplay,
} from "../../types/CommandDisplayFormatter";
import { CliPromptPreparer } from "../../core/harness/shared/CliPromptPreparer";
import { ExecutionPlanBuilder } from "../../core/harness/shared/ExecutionPlanBuilder";
import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";
import {
  HARNESS_IDS,
  MCP_CAPABILITY_KEYS,
  PREVIEW_MUTATION_SCOPES,
  PREVIEW_SCOPES,
  SETTING_SCOPES,
  HOOK_EVENT_ORDER,
  PROMPT_DIAGNOSTIC_CODES,
  PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES,
  WORKTREE_MODES,
} from "../../types/DashboardConstants";
import type { HarnessCapabilityRegistrySnapshot } from "../../types/CompatibilityTypes";
import type { PromptFile, PromptStep } from "../../types/CtrlYokeTypes";
import {
  resolveExecutionProperties,
  type ExecutionPropertyDefaults,
} from "../../types/ExecutionPropertyResolver";
import type { ExecutionPlan } from "../../core/harness/shared/ExecutionPlanBuilder";
import type { PreparedMutation } from "../../core/harness/shared/interfaces/PreparedMutation";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../../utils/ConfigurationUtils";
import { McpRegistryFileManager } from "../../utils/McpRegistryFileManager";
import { McpServerNormalizer } from "../../utils/McpServerNormalizer";
import { CliProviderUtils } from "../../core/harness/shared/CliProviderUtils";
import { pathsEqual } from "../../utils/PathCasing";
import type { ResolverWorkspaceFolder } from "../../platform/WorkspaceRootResolver";

const fsPromises = fs.promises;
let temporaryRoots: string[] = [];

function createDefaults(): ExecutionPropertyDefaults {
  return {
    harness: HARNESS_IDS.CLAUDE_CLI,
    modelsByHarness: { [HARNESS_IDS.CLAUDE_CLI]: "default-model" },
    additionalArgsByHarness: {},
    executionMode: "headless",
    ctrlyokeMcpMode: "native",
    resumeSession: false,
    mcpServers: [],
    hooks: null,
  };
}

function createCapabilities(): HarnessCapabilityRegistrySnapshot {
  const provider = new ClaudeCliProvider();
  const permissions = provider.toolPermissionMapper.capabilities;
  const hooks = provider.capabilities.hooks!;
  const mcp = provider.capabilities.mcp!;
  const promptInputs = provider.capabilities.promptInputs!;
  const state = {
    fidelity: "exact" as const,
    mechanism: "native" as const,
    verification: "verified" as const,
  };
  return {
    schemaVersion: 1,
    enabledDomains: ["permissions", "promptInputs", "hooks", "mcp"],
    harnesses: {
      [HARNESS_IDS.CLAUDE_CLI]: {
        available: true,
        version: "1.0.0",
        descriptor: {
          harnessId: HARNESS_IDS.CLAUDE_CLI,
          permissions,
          promptInputs,
          hooks,
          mcp,
        },
        effective: {
          permissions: {
            mode: state,
            allowedTools: state,
            deniedTools: state,
          },
          promptInputs: { images: state },
          hooks: Object.fromEntries(
            HOOK_EVENT_ORDER.map((event) => [event, state])
          ),
          mcp: { perServerToolFiltering: state },
        },
      },
    },
  } as HarnessCapabilityRegistrySnapshot;
}

function createPromptPreparer(
  buildPromptSections?: (prompt: PromptStep) => Promise<PromptSections>
): CliPromptPreparer {
  return new CliPromptPreparer({
    shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
    buildPromptSections:
      buildPromptSections ??
      (async (prompt) => ({
        skillContent: null,
        agentContent: null,
        directFileRefs: [],
        imageFileRefs: [],
        sourceRuntimeCopies: [],
        sourceRuntimeReadReferences: [],
        excerptContent: null,
        userPromptText: prompt.prompt,
        skippedReferences: [],
      })),
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

function createHarness(
  workspaceRoot?: string,
  buildPromptSections?: (prompt: PromptStep) => Promise<PromptSections>
): ExecutionPreviewHarness {
  const provider = new ClaudeCliProvider();
  return {
    provider,
    promptPreparer: createPromptPreparer(buildPromptSections),
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
  plannedMutations?: PreparedMutation[],
  namedWorkspaceRoots?: readonly ResolverWorkspaceFolder[],
  buildPromptSections?: (prompt: PromptStep) => Promise<PromptSections>,
  capabilities: HarnessCapabilityRegistrySnapshot = createCapabilities(),
  platform: NodeJS.Platform = "linux"
): ExecutionPreviewService {
  const harness = createHarness(workspaceRoot, buildPromptSections);
  if (plannedMutations) {
    harness.executionPlanBuilder.plan = async () =>
      createExecutionPlan(plannedMutations);
  }
  return new ExecutionPreviewService({
    defaults: createDefaults(),
    capabilities,
    getHarness: () => harness,
    workspaceRoot,
    workspaceRoots: workspaceRoot ? [workspaceRoot] : [],
    namedWorkspaceRoots,
    extensionPath: "extension",
    hostCanProvidePty: false,
    platform,
  });
}

async function withTerminalShell<T>(
  shellExecutable: string,
  callback: () => Promise<T>
): Promise<T> {
  const originalGetTerminalSettings = ConfigurationUtils.getTerminalSettings;
  ConfigurationUtils.getTerminalSettings = () => ({
    ...originalGetTerminalSettings(),
    shellExecutable,
  });
  try {
    return await callback();
  } finally {
    ConfigurationUtils.getTerminalSettings = originalGetTerminalSettings;
  }
}

async function initGitRepo(repository: string): Promise<void> {
  execFileSync("git", ["init", repository], { stdio: "ignore" });
  execFileSync("git", [
    "-C",
    repository,
    "config",
    "user.email",
    "test@example.com",
  ]);
  execFileSync("git", [
    "-C",
    repository,
    "config",
    "user.name",
    "ctrlyoke test",
  ]);
  await fsPromises.writeFile(path.join(repository, "README.md"), "base\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "commit", "-m", "base"], {
    stdio: "ignore",
  });
}

suite("ExecutionPreviewService", () => {
  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  });

  test("reports inherited session collisions and group metadata on every offending step", async () => {
    const preview = await createService().build({
      workflow: {
        resumeSession: true,
        sessionId: "shared-session",
        steps: [
          { name: "alpha", prompt: "one" },
          { name: "beta", prompt: "two" },
        ],
        parallelGroups: [
          {
            id: "group",
            startIndex: 0,
            endIndex: 1,
            failFast: true,
          },
        ],
      },
    });

    assert.strictEqual(preview.parallelGroupPreflights[0].effectiveWidth, 6);
    assert.deepStrictEqual(
      preview.steps.map((step) => step.parallelGroupId),
      ["group", "group"]
    );
    for (const step of preview.steps) {
      const collision = step.diagnostics.find(
        (diagnostic) =>
          diagnostic.code ===
          PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.SESSION_COLLISION
      );
      assert.ok(collision);
      assert.match(collision.message, /Step 1 \("alpha"\).*Step 2 \("beta"\)/);
    }
  });

  test("allows different-harness auto-resume sessions at a shared boundary", async () => {
    const capabilities = createCapabilities();
    capabilities.harnesses[HARNESS_IDS.COPILOT_CLI] = {
      ...capabilities.harnesses[HARNESS_IDS.CLAUDE_CLI],
      descriptor: {
        ...capabilities.harnesses[HARNESS_IDS.CLAUDE_CLI].descriptor,
        harnessId: HARNESS_IDS.COPILOT_CLI,
      },
    };
    const preview = await createService(
      undefined,
      undefined,
      undefined,
      undefined,
      capabilities
    ).build({
      workflow: {
        resumeSession: true,
        steps: [
          {
            prompt: "before",
            _runtime: {
              harness: HARNESS_IDS.CLAUDE_CLI,
              model: "model",
              sessionId: "claude-session",
              startedAt: 1,
              completedAt: 2,
            },
          },
          { prompt: "one", harness: HARNESS_IDS.CLAUDE_CLI },
          { prompt: "two", harness: HARNESS_IDS.COPILOT_CLI },
        ],
        parallelGroups: [
          {
            id: "group",
            startIndex: 1,
            endIndex: 2,
            failFast: false,
          },
        ],
      },
    });
    assert.strictEqual(
      preview.diagnostics.some(
        (diagnostic) =>
          diagnostic.code ===
          PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.SESSION_COLLISION
      ),
      false
    );
  });

  test("propagates configured hook compatibility diagnostics to workflow and step preview", async () => {
    const capabilities = createCapabilities();
    const installed = capabilities.harnesses[HARNESS_IDS.CLAUDE_CLI];
    installed.descriptor.hooks!.error = {
      ...installed.descriptor.hooks!.error,
      fidelity: "unsupported",
      mechanism: "none",
    };
    installed.effective!.hooks!.error = {
      fidelity: "unsupported",
      mechanism: "none",
      verification: "verified",
    };

    const preview = await createService(
      undefined,
      undefined,
      undefined,
      undefined,
      capabilities
    ).build({
      workflow: {
        steps: [
          {
            prompt: "uses an error hook",
            hooks: [{ event: "error", command: "node ./hook.js" }],
          },
        ],
      },
    });

    assert.ok(
      preview.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "compatibility.hooks.event.unsupported"
      )
    );
    assert.ok(
      preview.steps[0].diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "compatibility.hooks.event.unsupported"
      )
    );
  });

  test("propagates resolved image compatibility diagnostics to workflow and step preview", async () => {
    const capabilities = createCapabilities();
    const installed = capabilities.harnesses[HARNESS_IDS.CLAUDE_CLI];
    installed.descriptor.promptInputs!.images = {
      fidelity: "unsupported",
      mechanism: "none",
      caveatCode: "promptInputs.noNativeImageAttachment",
    };
    installed.effective!.promptInputs!.images = {
      fidelity: "unsupported",
      mechanism: "none",
      verification: "verified",
    };
    const imagePath = path.join(os.tmpdir(), "preview-image.png");

    const preview = await createService(
      undefined,
      undefined,
      undefined,
      async (prompt) => ({
        skillContent: null,
        agentContent: null,
        directFileRefs: [imagePath],
        imageFileRefs: [imagePath],
        sourceRuntimeCopies: [],
        sourceRuntimeReadReferences: [],
        excerptContent: null,
        userPromptText: prompt.prompt,
        skippedReferences: [],
      }),
      capabilities
    ).build({
      workflow: { steps: [{ prompt: `Review @${imagePath}` }] },
    });

    const diagnostic = preview.steps[0].diagnostics.find(
      (item) => item.code === "compatibility.promptInputs.images.unsupported"
    );
    assert.ok(diagnostic);
    assert.strictEqual(diagnostic.propertyPointer, "/steps/0/prompt");
    assert.strictEqual(diagnostic.sourceTier, "prompt");
    assert.ok(
      preview.diagnostics.some((item) => item.code === diagnostic.code)
    );
  });

  test("keeps translated MCP denials in the provider plan without duplicating analyzer diagnostics", async () => {
    const preview = await createService().build({
      workflow: {
        steps: [
          {
            prompt: "use the filtered server",
            toolPermissions: {
              mode: "custom",
              allowedTools: [],
              deniedTools: [],
            },
            mcpServers: [
              { id: "filtered", command: "node", deniedTools: ["blocked"] },
            ],
          },
        ],
      },
    });

    const step = preview.steps[0];
    assert.deepStrictEqual(step.mcpApplication?.servers[0].toolFilters, [
      "!blocked",
    ]);
    assert.ok(
      step.permissionApplication?.rules.some(
        (rule) => rule.rule === "mcp__filtered__blocked"
      )
    );
    assert.strictEqual(
      step.diagnostics.some(
        (diagnostic) =>
          diagnostic.capability ===
          MCP_CAPABILITY_KEYS.PER_SERVER_TOOL_FILTERING
      ),
      false
    );
  });

  test("resolves authored prompt-file paths at preview time after substitution", async () => {
    const workspaceRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preview-prompt-file-")
    );
    temporaryRoots.push(workspaceRoot);
    const promptPath = path.join(workspaceRoot, "current.prompt.md");
    const sourcePath = path.join(workspaceRoot, "workflow.ctrlyoke.json");
    await fsPromises.writeFile(promptPath, "preview {{name}} contents", "utf8");

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
        section.body?.includes("preview current contents")
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

  test("previews source-runtime resolutions, copies, and disclosure without writing", async () => {
    const executionRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preview-source-runtime-")
    );
    const sourceRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preview-source-runtime-source-")
    );
    temporaryRoots.push(executionRoot, sourceRoot);
    const sourcePath = path.join(sourceRoot, "runtime", "session.log");
    const destinationPath = path.join(executionRoot, "runtime", "session.log");
    await fsPromises.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsPromises.writeFile(sourcePath, "source log\n", "utf8");

    const preview = await createService(
      executionRoot,
      undefined,
      undefined,
      async (prompt) => ({
        skillContent: null,
        agentContent: null,
        directFileRefs: [destinationPath],
        imageFileRefs: [],
        sourceRuntimeCopies: [
          { reference: "@runtime/source.log", sourcePath, destinationPath },
        ],
        sourceRuntimeReadReferences: [
          "@runtime/other.log",
          "@runtime/another.log",
        ],
        excerptContent: null,
        userPromptText: prompt.prompt,
        skippedReferences: [],
      })
    ).build({
      workflow: { steps: [{ prompt: "Review @runtime/session.log" }] },
    });

    const step = preview.steps[0];
    assert.ok(
      step.workspaceMutations.some(
        (mutation) => mutation.path === destinationPath
      )
    );
    assert.strictEqual(fs.existsSync(destinationPath), false);
    assert.strictEqual(
      step.diagnostics.find(
        (diagnostic) =>
          diagnostic.code === PROMPT_DIAGNOSTIC_CODES.SOURCE_RUNTIME_DISCLOSURE
      )?.message,
      `Read from source checkout: @runtime/other.log, @runtime/another.log; Copied into worktree: @runtime/source.log → ${destinationPath}`
    );
    assert.strictEqual(
      step.prompt?.sections.find((section) => section.path === destinationPath)
        ?.path,
      destinationPath
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

  test("uses the same normalized MCP server set as execution planning", async () => {
    const root = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preview-mcp-normalization-")
    );
    const home = path.join(root, "home");
    await fsPromises.mkdir(home, { recursive: true });
    temporaryRoots.push(root);

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    try {
      const server = {
        id: "playwright",
        command: "node",
        args: ["playwright-server.js"],
      };
      const registry = new McpRegistryFileManager(root);
      await registry.addOrUpdate(server, SETTING_SCOPES.WORKSPACE);
      const defaults = createDefaults();
      const rawProperties = resolveExecutionProperties(
        { prompt: "use the service", mcpServers: ["playwright"] },
        { steps: [] },
        { defaults, hostCanProvidePty: false }
      ).properties;
      const executionProperties = await McpServerNormalizer.applyFromRegistry(
        rawProperties,
        root
      );
      let executionServerIds: string[] = [];
      await CliProviderUtils.planMcpConfigBlock(
        {
          promptIndex: 0,
          allPrompts: [],
          resolvedProperties: executionProperties,
        },
        root,
        "extension",
        async (
          _serverPath,
          _workspaceRoot,
          _workingFilePath,
          _env,
          servers
        ) => {
          executionServerIds = (servers ?? []).map((entry) => entry.id);
          return { cliArgs: [], mutations: [], diagnostics: [] };
        }
      );

      const preview = await createService(root).build({
        workflow: {
          steps: [{ prompt: "use the service", mcpServers: ["playwright"] }],
        },
      });

      assert.deepStrictEqual(
        preview.steps[0].resolvedProperties.mcpServerIds,
        executionServerIds
      );
      assert.deepStrictEqual(executionServerIds, ["playwright"]);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
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

  test("previews script steps with the resolved shell and display dialect", async () => {
    const script = "echo preview";

    const pinned = await withTerminalShell("powershell.exe", () =>
      createService(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "linux"
      ).build({
        workflow: { steps: [{ type: "script", script, shell: "cmd.exe" }] },
      })
    );
    assert.strictEqual(pinned.steps[0].command?.executable, "cmd.exe");
    assert.deepStrictEqual(pinned.steps[0].command?.args, ["/d", "/c", script]);
    assert.strictEqual(
      pinned.steps[0].command?.displayShell,
      COMMAND_DISPLAY_SHELLS.CMD
    );
    assert.strictEqual(
      pinned.steps[0].command?.requiresShellVerbatimArgs,
      true
    );

    const configured = await withTerminalShell("bash", () =>
      createService(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "win32"
      ).build({
        workflow: { steps: [{ type: "script", script }] },
      })
    );
    assert.strictEqual(configured.steps[0].command?.executable, "bash");
    assert.deepStrictEqual(configured.steps[0].command?.args, ["-c", script]);
    assert.strictEqual(
      configured.steps[0].command?.displayShell,
      COMMAND_DISPLAY_SHELLS.POSIX
    );
    assert.strictEqual(
      configured.steps[0].command?.requiresShellVerbatimArgs,
      false
    );

    const autoDetected = await withTerminalShell(" ", () =>
      createService(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "win32"
      ).build({
        workflow: { steps: [{ type: "script", script }] },
      })
    );
    const command = autoDetected.steps[0].command;
    assert.ok(command);
    assert.ok(
      command.executable.toLowerCase().endsWith("pwsh.exe") ||
        command.executable.toLowerCase() === "powershell.exe"
    );
    assert.strictEqual(command.displayShell, COMMAND_DISPLAY_SHELLS.POWERSHELL);
    assert.strictEqual(command.requiresShellVerbatimArgs, false);
    assert.strictEqual(command.args[0], "-NoProfile");
    assert.strictEqual(command.args[1], "-Command");
    assert.ok(command.args[2]?.startsWith(script));
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
            expected: "ok",
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

  test("omits the worktree preview when the workflow is not configured to use one", async () => {
    const preview = await createService().build({
      workflow: { steps: [{ prompt: "no worktree here" }] },
    });

    assert.strictEqual(preview.worktree, undefined);
  });

  test("reports worktree ineligibility instead of throwing when the workspace isn't a Git repository", async () => {
    const workspaceRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preview-worktree-ineligible-")
    );
    temporaryRoots.push(workspaceRoot);

    const preview = await createService(workspaceRoot, undefined, [
      { name: "root", fsPath: workspaceRoot },
    ]).build({
      workflow: { worktree: true, steps: [{ prompt: "wants a worktree" }] },
    });

    assert.ok(preview.worktree);
    assert.strictEqual(preview.worktree.mode, WORKTREE_MODES.MANAGED);
    assert.strictEqual(preview.worktree.eligible, false);
    assert.ok(preview.worktree.eligibilityReason);
    // Ineligible means no worktree applies, so the command still runs in the
    // ordinary workspace root rather than a guessed worktree directory.
    assert.ok(pathsEqual(preview.steps[0].command!.cwd, workspaceRoot));
  });

  test("computes a deterministic named-worktree directory when no matching checkout exists yet", async function () {
    const parent = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preview-worktree-named-")
    );
    temporaryRoots.push(parent);
    const workspaceRoot = path.join(parent, "repository");
    await fsPromises.mkdir(workspaceRoot);
    await initGitRepo(workspaceRoot);

    const preview = await createService(workspaceRoot, undefined, [
      { name: "root", fsPath: workspaceRoot },
    ]).build({
      workflow: {
        worktree: "feature/preview-test",
        steps: [{ prompt: "wants a named worktree" }],
      },
    });

    assert.ok(preview.worktree);
    assert.strictEqual(preview.worktree.mode, WORKTREE_MODES.NAMED);
    assert.strictEqual(preview.worktree.branch, "feature/preview-test");
    assert.strictEqual(preview.worktree.eligible, true);
    assert.ok(preview.worktree.plannedDirectory);
    assert.strictEqual(preview.worktree.plannedDirectoryIsExact, false);
    assert.strictEqual(
      preview.steps[0].command!.cwd,
      preview.worktree.plannedDirectory
    );
  });

  test("reports the exact directory when the named branch already has a Git worktree checked out", async function () {
    const parent = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preview-worktree-exact-")
    );
    temporaryRoots.push(parent);
    const workspaceRoot = path.join(parent, "repository");
    await fsPromises.mkdir(workspaceRoot);
    await initGitRepo(workspaceRoot);
    const existingCheckout = path.join(parent, "existing-checkout");
    execFileSync("git", [
      "-C",
      workspaceRoot,
      "worktree",
      "add",
      existingCheckout,
      "-b",
      "feature/already-checked-out",
    ]);

    const preview = await createService(workspaceRoot, undefined, [
      { name: "root", fsPath: workspaceRoot },
    ]).build({
      workflow: {
        worktree: "feature/already-checked-out",
        steps: [{ prompt: "wants the existing worktree" }],
      },
    });

    assert.ok(preview.worktree);
    assert.strictEqual(preview.worktree.plannedDirectoryIsExact, true);
    assert.ok(
      pathsEqual(preview.worktree.plannedDirectory ?? "", existingCheckout)
    );
    assert.ok(pathsEqual(preview.steps[0].command!.cwd, existingCheckout));
  });

  test("classifies mutations under the worktree's own temp directory as run-local, not shared", async function () {
    const parent = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preview-worktree-mutation-")
    );
    temporaryRoots.push(parent);
    const workspaceRoot = path.join(parent, "repository");
    await fsPromises.mkdir(workspaceRoot);
    await initGitRepo(workspaceRoot);
    const existingCheckout = path.join(parent, "existing-checkout");
    execFileSync("git", [
      "-C",
      workspaceRoot,
      "worktree",
      "add",
      existingCheckout,
      "-b",
      "feature/worktree-mutation",
    ]);

    const worktreeTempPath = path.join(
      existingCheckout,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.TEMP_DIR,
      "hook-settings.json"
    );
    const mutations: PreparedMutation[] = [
      {
        path: worktreeTempPath,
        intendedContent: '{"hooks": []}',
        description: "run-local hook settings inside the worktree",
        apply: async () => {},
      },
    ];

    const preview = await createService(workspaceRoot, mutations, [
      { name: "root", fsPath: workspaceRoot },
    ]).build({
      workflow: {
        worktree: "feature/worktree-mutation",
        steps: [{ prompt: "wants the existing worktree" }],
      },
    });

    assert.ok(preview.worktree);
    assert.strictEqual(preview.worktree.plannedDirectoryIsExact, true);
    const mutation = preview.steps[0].workspaceMutations.find((entry) =>
      pathsEqual(entry.path ?? "", worktreeTempPath)
    );
    assert.ok(mutation);
    assert.strictEqual(mutation.scope, PREVIEW_MUTATION_SCOPES.RUN_LOCAL);
    assert.strictEqual(mutation.warning, undefined);
  });

  test("computes a managed-worktree preview without an exact path, noting the run-ID dependency", async function () {
    const parent = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preview-worktree-managed-")
    );
    temporaryRoots.push(parent);
    const workspaceRoot = path.join(parent, "repository");
    await fsPromises.mkdir(workspaceRoot);
    await initGitRepo(workspaceRoot);

    const preview = await createService(workspaceRoot, undefined, [
      { name: "root", fsPath: workspaceRoot },
    ]).build({
      workflow: {
        worktree: true,
        steps: [{ prompt: "wants a managed worktree" }],
      },
    });

    assert.ok(preview.worktree);
    assert.strictEqual(preview.worktree.mode, WORKTREE_MODES.MANAGED);
    assert.strictEqual(preview.worktree.eligible, true);
    assert.strictEqual(preview.worktree.plannedDirectory, undefined);
    assert.ok(preview.worktree.plannedDirectoryNotice);
    // Managed mode can't know its real directory before a run allocates an
    // ID, so the command preview keeps showing the ordinary workspace root.
    assert.ok(pathsEqual(preview.steps[0].command!.cwd, workspaceRoot));
  });
});
