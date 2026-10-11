import * as assert from "assert";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import * as vscode from "vscode";
import { suite, test } from "mocha";
import { WorkflowSerializer } from "../../ui/WorkflowSerializer";
import type { DashboardHostActions, KeyValueStore } from "../../core/HostPorts";
import { configService } from "../../config/CtrlYokeConfigService";
import { CONFIG_KEYS } from "../../utils/ConfigurationUtils";
import {
  CLEAR_HISTORY_CONFIRMATION_PHRASE,
  EMPTY_TRASH_CONFIRMATION_PHRASE,
  EXECUTION_STATES,
  HISTORY_TRASH_ACTIONS,
  MESSAGE_TYPES,
  SETTING_SCOPES,
  TEMPLATE_VARIABLE_DEFAULT_SOURCES,
  PROMPT_PROPERTIES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "../../types/DashboardConstants";
import type { WorkflowOrchestrator } from "../../core/WorkflowOrchestrator";
import type {
  WorkflowViewAddress,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { WorkflowActivityTracker } from "../../core/orchestration/WorkflowActivityTracker";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { PromptFileResolver } from "../../core/PromptFileResolver";
import { PromptFileParser } from "../../core/PromptFileParser";
import { parseAllFileReferences } from "../../utils/FileReferenceParser";
import {
  BUNDLE_MANIFEST_FILE_NAME,
  BUNDLE_MANIFEST_VERSION,
} from "../../utils/WorkflowBundleAnalyzer";
import { snapshotProperty } from "../helpers/propertySnapshot";

/** Minimal in-memory vscode.Memento stub for tests that don't exercise persistence. */
function fakeWorkspaceState(): any {
  const store = new Map<string, unknown>();
  return {
    get: (key: string, defaultValue?: unknown) =>
      store.has(key) ? store.get(key) : defaultValue,
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
}

class RecordingMemento implements KeyValueStore {
  private readonly values = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.values.keys()];
  }

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function createWorkflowSerializer(
  postMessage: (message: any) => void,
  templateManager: any,
  getManager: () => WorkflowOrchestrator | undefined,
  getOutputHistoryManager: () => any,
  workspaceState: KeyValueStore,
  actions: Pick<
    DashboardHostActions,
    "selectWorkspacePath" | "openWorkspaceTarget" | "openContentPreview"
  > = {
    openWorkspaceTarget: async () => ({ status: "opened" }),
  }
): WorkflowSerializer {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    fsPath: folder.uri.fsPath,
  }));
  return new WorkflowSerializer(
    postMessage,
    templateManager,
    getManager,
    getOutputHistoryManager,
    workspaceState,
    {
      actions,
      getWorkspaceRoot: () => roots[0]?.fsPath,
      getNamedRoots: () => roots,
      getTrustedRoots: () => roots.map(({ fsPath }) => fsPath),
    }
  );
}

interface SchemaNode {
  $ref?: string;
  properties?: Record<string, unknown>;
  allOf?: SchemaNode[];
}

interface WorkflowSchema {
  $defs: Record<string, SchemaNode>;
  oneOf: SchemaNode[];
}

function directSchemaPropertyNames(node: SchemaNode): string[] {
  const names = new Set<string>(Object.keys(node.properties ?? {}));
  for (const child of node.allOf ?? []) {
    for (const name of directSchemaPropertyNames(child)) {
      names.add(name);
    }
  }
  return [...names];
}

function schemaBackedFieldNames(): {
  workflow: string[];
  step: string[];
} {
  const schemaPath = path.resolve(
    __dirname,
    "../../../schemas/workflow-schema.json"
  );
  const schema = JSON.parse(
    fsSync.readFileSync(schemaPath, "utf8")
  ) as WorkflowSchema;
  const executionFields = directSchemaPropertyNames(
    schema.$defs.executionProperties
  );
  const promptFields = directSchemaPropertyNames(schema.$defs.promptStep);
  const scriptFields = directSchemaPropertyNames(schema.$defs.scriptStep);
  const multiStepWorkflowFields = directSchemaPropertyNames(
    schema.oneOf[1].allOf?.find((node) => node.properties?.steps) ?? {}
  );
  const runtimeOnlyWorkflowFields = new Set([
    "startedAt",
    "definitionRevision",
    "_runtime",
    "parallelGroups",
  ]);
  const singleStepWorkflowFields = promptFields.filter(
    (field) => field === PROMPT_PROPERTIES.PROMPT
  );

  return {
    workflow: [
      ...new Set([
        ...singleStepWorkflowFields,
        ...executionFields,
        ...multiStepWorkflowFields,
      ]),
    ].filter((field) => !runtimeOnlyWorkflowFields.has(field)),
    step: [
      ...new Set([...executionFields, ...promptFields, ...scriptFields]),
    ].filter(
      (field) =>
        field !== "_runtime" &&
        // `returns` is declared only to reject itself (`not: {}`) so a stale key
        // errors by name; it was renamed to `expected` and must never persist.
        field !== "returns"
    ),
  };
}

function schemaSentinel(context: string, field: string): string {
  return `${context}-${field}`;
}

function buildSchemaBackedStep(
  fields: string[],
  context: string,
  type: "prompt" | "script"
): Record<string, unknown> {
  const step: Record<string, unknown> = Object.fromEntries(
    fields
      .filter((field) => type !== "prompt" || field !== "timeoutSec")
      .map((field) => [
        field,
        field === "timeoutSec" ? 0.5 : schemaSentinel(context, field),
      ])
  );
  step.type = type;
  step._runtime = { startedAt: 123, terminalStatus: "completed" };
  return step;
}

/** Promotes one complete run under an already-created lineage, writing the working
 * file, manifest, and empty events log the finalize step requires. */
async function createPromotedRun(
  repository: WorkflowLineageRepository,
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  startedAt: number
): Promise<{
  runRef: ReturnType<typeof WorkflowPaths.formatRunRef>;
  runId: number;
}> {
  const run = await repository.allocateRun(workspaceRoot, workflowKey);
  await fs.writeFile(
    run.stagingRunFilePath,
    JSON.stringify({
      workflowName: "Recent workflows test",
      definitionRevision: 1,
      startedAt,
      lastModifiedAt: startedAt,
      steps: [{ prompt: "hello" }],
      _runtime: { currentIndex: 0, executionState: "completed" },
    })
  );
  await fs.writeFile(
    path.join(run.stagingRunDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: "2.2.0",
      storageKind: "timeline",
      workflowId: "test",
      runId: run.runId,
      startedAt,
      executionState: "completed",
      definitionRevision: 1,
      stepCount: 1,
      eventCount: 0,
      nextSequence: 0,
      lastUpdatedAt: startedAt,
    })
  );
  await fs.writeFile(path.join(run.stagingRunDir, "events.jsonl"), "");
  await repository.finalizeAllocatedRun(workspaceRoot, workflowKey, run);
  return { runRef: run.runRef, runId: run.runId };
}

/** Writes a minimal draft working file directly (bypassing WorkingFileManager). */
async function writeDraftWorkingFile(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  startedAt: number
): Promise<void> {
  await fs.mkdir(WorkflowPaths.draftDir(workspaceRoot, workflowKey), {
    recursive: true,
  });
  await fs.writeFile(
    WorkflowPaths.draftFilePath(workspaceRoot, workflowKey),
    JSON.stringify({
      workflowName: "Recent workflows draft test",
      definitionRevision: 1,
      startedAt,
      lastModifiedAt: startedAt,
      steps: [{ prompt: "hello" }],
      _runtime: { currentIndex: 0, executionState: "idle" },
    })
  );
}

/** Runs `run` with a temp directory as the only VS Code workspace folder. */
async function withWorkspace(
  prefix: string,
  run: (workspaceRoot: string) => Promise<void>
): Promise<void> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const restoreWorkspaceFolders = snapshotProperty(
    vscode.workspace,
    "workspaceFolders"
  );
  try {
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      value: [
        {
          uri: vscode.Uri.file(workspaceRoot),
          name: prefix,
          index: 0,
        },
      ],
      configurable: true,
    });
    await run(workspaceRoot);
  } finally {
    restoreWorkspaceFolders();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

suite("WorkflowSerializer", () => {
  test("loads the template catalog without opening the new-workflow modal", async () => {
    const messages: any[] = [];
    const serializer = createWorkflowSerializer(
      (message) => messages.push(message),
      {
        getAvailableTemplates: async () => [
          {
            id: "sample",
            name: "Sample",
            description: "Description",
            variables: [{ name: "topic", type: "text", default: "hello" }],
            isBuiltIn: true,
          },
        ],
      },
      () => undefined,
      () => undefined,
      fakeWorkspaceState()
    );

    await serializer.handleTemplateCatalogRequest();

    assert.deepStrictEqual(messages, [
      {
        type: MESSAGE_TYPES.TEMPLATE_CATALOG_LOADED,
        templates: [
          {
            id: "sample",
            name: "Sample",
            description: "Description",
            variables: [{ name: "topic", type: "text", default: "hello" }],
            isBuiltIn: true,
            source: undefined,
          },
        ],
      },
    ]);
  });

  suite("handleSetDefaultTemplate", () => {
    test("writes or clears at the requested scope and reports the effective value", async () => {
      const originalSet = configService.set;
      const originalGet = configService.get;
      const originalGetScoped = configService.getScoped;
      const setCalls: Array<{ key: string; value: unknown; scope: string }> =
        [];
      const messages: any[] = [];
      const scoped: Record<string, Record<string, any>> = {
        [SETTING_SCOPES.USER]: {
          general: { defaultTemplate: "user-template" },
        },
        [SETTING_SCOPES.WORKSPACE]: {},
      };

      try {
        configService.set = (async (key, value, scope) => {
          setCalls.push({ key, value, scope });
          const settings = scoped[scope];
          if (key === CONFIG_KEYS.GENERAL_DEFAULT_TEMPLATE) {
            if (value === undefined) delete settings.general?.defaultTemplate;
            else settings.general = { ...settings.general, defaultTemplate: value };
          }
        }) as typeof configService.set;
        configService.getScoped = ((key, scope) =>
          scoped[scope][key]) as typeof configService.getScoped;
        configService.get = ((key) => {
          if (key !== CONFIG_KEYS.GENERAL) return originalGet.call(configService, key);
          return {
            defaultTemplate:
              scoped[SETTING_SCOPES.WORKSPACE].general?.defaultTemplate ??
              scoped[SETTING_SCOPES.USER].general?.defaultTemplate ??
              "blank",
          };
        }) as typeof configService.get;

        const serializer = createWorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () => undefined,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSetDefaultTemplate(
          "user-template",
          SETTING_SCOPES.WORKSPACE
        );

        assert.deepStrictEqual(setCalls, [
          {
            key: CONFIG_KEYS.GENERAL_DEFAULT_TEMPLATE,
            value: undefined,
            scope: SETTING_SCOPES.WORKSPACE,
          },
        ]);
        assert.deepStrictEqual(messages, [
          {
            type: MESSAGE_TYPES.DEFAULT_TEMPLATE_SET,
            templateId: "user-template",
            defaultTemplateId: "user-template",
            defaultTemplateSource: TEMPLATE_VARIABLE_DEFAULT_SOURCES.USER,
            scope: SETTING_SCOPES.WORKSPACE,
          },
        ]);

        setCalls.length = 0;
        messages.length = 0;
        await serializer.handleSetDefaultTemplate(
          "workspace-template",
          SETTING_SCOPES.WORKSPACE
        );
        assert.deepStrictEqual(setCalls, [
          {
            key: CONFIG_KEYS.GENERAL_DEFAULT_TEMPLATE,
            value: "workspace-template",
            scope: SETTING_SCOPES.WORKSPACE,
          },
        ]);
        assert.deepStrictEqual(messages, [
          {
            type: MESSAGE_TYPES.DEFAULT_TEMPLATE_SET,
            templateId: "workspace-template",
            defaultTemplateId: "workspace-template",
            defaultTemplateSource: TEMPLATE_VARIABLE_DEFAULT_SOURCES.WORKSPACE,
            scope: SETTING_SCOPES.WORKSPACE,
          },
        ]);
      } finally {
        configService.set = originalSet;
        configService.get = originalGet;
        configService.getScoped = originalGetScoped;
      }
    });

    test("clearing the User value equal to the schema default reports the schema default", async () => {
      const originalSet = configService.set;
      const originalGet = configService.get;
      const originalGetScoped = configService.getScoped;
      const messages: any[] = [];
      let writtenValue: unknown = "previous";
      const scoped: Record<string, Record<string, any>> = {
        [SETTING_SCOPES.USER]: { general: { defaultTemplate: "previous" } },
        [SETTING_SCOPES.WORKSPACE]: {},
      };
      try {
        configService.set = (async (_key, value) => {
          writtenValue = value;
          if (value === undefined) delete scoped[SETTING_SCOPES.USER].general;
        }) as typeof configService.set;
        configService.getScoped = ((_key, scope) =>
          scoped[scope][_key]) as typeof configService.getScoped;
        configService.get = ((key) => key === CONFIG_KEYS.GENERAL
          ? { defaultTemplate: scoped[SETTING_SCOPES.USER].general?.defaultTemplate ?? "blank" }
          : originalGet.call(configService, key)) as typeof configService.get;
        const serializer = createWorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () => undefined,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSetDefaultTemplate("blank", SETTING_SCOPES.USER);

        assert.strictEqual(writtenValue, undefined);
        assert.deepStrictEqual(messages[0], {
          type: MESSAGE_TYPES.DEFAULT_TEMPLATE_SET,
          templateId: "blank",
          defaultTemplateId: "blank",
          defaultTemplateSource: TEMPLATE_VARIABLE_DEFAULT_SOURCES.TEMPLATE,
          scope: SETTING_SCOPES.USER,
        });
      } finally {
        configService.set = originalSet;
        configService.get = originalGet;
        configService.getScoped = originalGetScoped;
      }
    });
  });

  suite("handleSetTemplateVariableDefaults", () => {
    const singleVariableTemplate = {
      id: "single-template",
      name: "Single template",
      description: "",
      path: null,
      isBuiltIn: true,
      variables: [
        { name: "value", type: "text", default: "authored", authoredDefault: "authored" },
      ],
    };
    const pairTemplate = {
      id: "pair-template",
      name: "Pair template",
      description: "",
      path: null,
      isBuiltIn: true,
      variables: [
        {
          name: "harness",
          type: "harness",
          default: "claude-cli",
          authoredDefault: "claude-cli",
        },
        {
          name: "model",
          type: "model",
          harness: "harness",
          default: "claude-sonnet-4-5",
          authoredDefault: "claude-sonnet-4-5",
        },
      ],
    };

    test("clears an authored value saved at User scope", async () => {
      const originalSet = configService.set;
      const originalGetScoped = configService.getScoped;
      const writes: unknown[] = [];
      const scoped: Record<string, Record<string, any>> = {
        [SETTING_SCOPES.USER]: { templates: { variableDefaults: {} } },
        [SETTING_SCOPES.WORKSPACE]: {},
      };
      try {
        configService.getScoped = ((_key, scope) =>
          scoped[scope][_key]) as typeof configService.getScoped;
        configService.set = (async (_key, value) => {
          writes.push(value);
        }) as typeof configService.set;
        const manager = {
          getTemplateInfo: async () => singleVariableTemplate,
          getAvailableTemplates: async () => [singleVariableTemplate],
        };
        const serializer = createWorkflowSerializer(
          () => undefined,
          manager,
          () => undefined,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSetTemplateVariableDefaults(
          "single-template",
          { value: "authored" },
          SETTING_SCOPES.USER
        );

        assert.deepStrictEqual(writes, [{}]);
      } finally {
        configService.set = originalSet;
        configService.getScoped = originalGetScoped;
      }
    });

    test("stores an authored value at Workspace when a different User value exists", async () => {
      const originalSet = configService.set;
      const originalGetScoped = configService.getScoped;
      const writes: unknown[] = [];
      const scoped: Record<string, Record<string, any>> = {
        [SETTING_SCOPES.USER]: {
          templates: { variableDefaults: { "single-template": { value: "user" } } },
        },
        [SETTING_SCOPES.WORKSPACE]: { templates: { variableDefaults: {} } },
      };
      try {
        configService.getScoped = ((key, scope) =>
          scoped[scope][key]) as typeof configService.getScoped;
        configService.set = (async (_key, value) => {
          writes.push(value);
        }) as typeof configService.set;
        const manager = {
          getTemplateInfo: async () => singleVariableTemplate,
          getAvailableTemplates: async () => [singleVariableTemplate],
        };
        const serializer = createWorkflowSerializer(
          () => undefined,
          manager,
          () => undefined,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSetTemplateVariableDefaults(
          "single-template",
          { value: "authored" },
          SETTING_SCOPES.WORKSPACE
        );

        assert.deepStrictEqual(writes, [
          { "single-template": { value: "authored" } },
        ]);
      } finally {
        configService.set = originalSet;
        configService.getScoped = originalGetScoped;
      }
    });

    test("stores a linked pair when the harness matches authored but the model changed", async () => {
      const originalSet = configService.set;
      const originalGetScoped = configService.getScoped;
      const saved: Record<string, Record<string, any>> = {};
      const messages: any[] = [];
      const scoped: Record<string, Record<string, any>> = {
        [SETTING_SCOPES.USER]: { templates: { variableDefaults: {} } },
        [SETTING_SCOPES.WORKSPACE]: {},
      };
      try {
        configService.getScoped = ((key, scope) =>
          scoped[scope][key]) as typeof configService.getScoped;
        configService.set = (async (_key, value, scope) => {
          saved[scope] = value as Record<string, Record<string, any>>;
          scoped[scope].templates = { variableDefaults: value };
        }) as typeof configService.set;
        const manager = {
          getTemplateInfo: async () => pairTemplate,
          getAvailableTemplates: async () => [
            { ...pairTemplate, variables: pairTemplate.variables.map((variable) => ({ ...variable })) },
          ],
        };
        const serializer = createWorkflowSerializer(
          (message) => messages.push(message),
          manager,
          () => undefined,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSetTemplateVariableDefaults(
          "pair-template",
          { harness: "claude-cli", model: "custom-model" },
          SETTING_SCOPES.USER
        );

        assert.deepStrictEqual(saved[SETTING_SCOPES.USER], {
          "pair-template": {
            harness: "claude-cli",
            model: "custom-model",
          },
        });
        assert.strictEqual(
          messages[0].type,
          MESSAGE_TYPES.TEMPLATE_VARIABLE_DEFAULTS_SET
        );
        assert.deepStrictEqual(messages[0].variableNames, ["harness", "model"]);
        assert.strictEqual(messages[0].scope, SETTING_SCOPES.USER);
      } finally {
        configService.set = originalSet;
        configService.getScoped = originalGetScoped;
      }
    });

    test("removes the template key after clearing its last variable and re-sends templates", async () => {
      const originalSet = configService.set;
      const originalGetScoped = configService.getScoped;
      const messages: any[] = [];
      const settings: Record<string, any> = {
        [SETTING_SCOPES.USER]: {
          templates: { variableDefaults: { "pair-template": { harness: "codex-cli" } } },
        },
        [SETTING_SCOPES.WORKSPACE]: {},
      };
      try {
        configService.getScoped = ((key, scope) =>
          settings[scope][key]) as typeof configService.getScoped;
        configService.set = (async (_key, value, scope) => {
          settings[scope].templates = { variableDefaults: value };
        }) as typeof configService.set;
        const manager = {
          getTemplateInfo: async () => pairTemplate,
          getAvailableTemplates: async () => [pairTemplate],
        };
        const serializer = createWorkflowSerializer(
          (message) => messages.push(message),
          manager,
          () => undefined,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSetTemplateVariableDefaults(
          "pair-template",
          { harness: "antigravity-cli" },
          SETTING_SCOPES.USER
        );
        await serializer.handleSetTemplateVariableDefaults(
          "pair-template",
          { harness: null },
          SETTING_SCOPES.USER
        );

        assert.deepStrictEqual(settings[SETTING_SCOPES.USER].templates, {
          variableDefaults: {},
        });
        assert.strictEqual(messages.length, 2);
        assert.strictEqual(
          messages[1].type,
          MESSAGE_TYPES.TEMPLATE_VARIABLE_DEFAULTS_SET
        );
        assert.strictEqual(messages[1].templates.length, 1);
        assert.strictEqual(messages[1].templates[0].id, "pair-template");
      } finally {
        configService.set = originalSet;
        configService.getScoped = originalGetScoped;
      }
    });
  });

  suite("handleBrowseTemplateFile", () => {
    test("remembers the selected file's directory for the next native picker", async () => {
      const workspaceRoot = path.join(os.tmpdir(), "ctrlyoke-picker-workspace");
      const selectedFile = path.join(workspaceRoot, "specs", "feature.md");
      const normalizedWorkspaceRoot = workspaceRoot.replace(
        /^([A-Z]):/,
        (_drive, letter: string) => `${letter.toLowerCase()}:`
      );
      const normalizedSelectedFile = selectedFile.replace(
        /^([A-Z]):/,
        (_drive, letter: string) => `${letter.toLowerCase()}:`
      );
      const restoreWorkspaceFolders = snapshotProperty(
        vscode.workspace,
        "workspaceFolders"
      );
      const requests: any[] = [];
      let callCount = 0;

      try {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: [
            {
              uri: vscode.Uri.file(workspaceRoot),
              name: "picker-workspace",
              index: 0,
            },
          ],
          configurable: true,
        });
        const actions: Pick<
          DashboardHostActions,
          "selectWorkspacePath" | "openWorkspaceTarget"
        > = {
          openWorkspaceTarget: async () => ({ status: "opened" }),
          selectWorkspacePath: async (request) => {
            requests.push(request);
            callCount += 1;
            return callCount === 1 ? normalizedSelectedFile : undefined;
          },
        };

        const messages: unknown[] = [];
        const serializer = createWorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () => undefined,
          () => undefined,
          new RecordingMemento(),
          actions
        );

        await serializer.handleBrowseTemplateFile("spec", ["**/*.md"]);
        await serializer.handleBrowseTemplateFile("spec", ["**/*.md"]);

        assert.strictEqual(requests[0].defaultPath, normalizedWorkspaceRoot);
        assert.strictEqual(
          requests[1].defaultPath,
          path.dirname(normalizedSelectedFile)
        );
        assert.deepStrictEqual(requests[0].filters, {
          "Spec / Design Files": ["md"],
          "All Files": ["*"],
        });
        assert.deepStrictEqual(messages, [
          {
            type: MESSAGE_TYPES.TEMPLATE_FILE_SELECTED,
            variable: "spec",
            path: "specs/feature.md",
          },
        ]);
      } finally {
        restoreWorkspaceFolders();
      }
    });
  });

  suite("handleSaveWorkflow", () => {
    test("should persist errorBehavior at workflow and step level", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-serializer-")
      );
      const workingFilePath = path.join(tempDir, "input.ctrlyoke.json");
      const outputPath = path.join(tempDir, "saved.ctrlyoke.json");
      const messages: any[] = [];
      const address = {
        workflowKey: "serializer-test-1",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      } as WorkflowViewAddress;

      try {
        await fs.writeFile(
          workingFilePath,
          JSON.stringify(
            {
              workflowName: "serializer-test",
              startedAt: Date.now(),
              errorBehavior: {
                onError: "retry",
                maxRetries: 2,
                retryDelaySec: 2.5,
              },
              steps: [
                {
                  prompt: "Step one",
                  errorBehavior: { onError: "continue" },
                  _runtime: { startedAt: 1 },
                },
              ],
              _runtime: {
                currentIndex: 0,
                executionState: "idle",
                activeParallelGroup: {
                  groupId: "live-group",
                  admission: "accepting",
                },
              },
            },
            null,
            2
          ),
          "utf8"
        );

        const serializer = createWorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () =>
            ({
              getQueueState: () => ({ workingFilePath }),
              getViewAddress: () => address,
            }) as any,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSaveWorkflow(
          "save-test",
          address,
          outputPath,
          "json"
        );

        const saved = JSON.parse(await fs.readFile(outputPath, "utf8"));
        assert.deepStrictEqual(saved.errorBehavior, {
          onError: "retry",
          maxRetries: 2,
          retryDelaySec: 2.5,
        });
        assert.deepStrictEqual(saved.steps[0].errorBehavior, {
          onError: "continue",
        });
        assert.strictEqual(saved.steps[0]._runtime, undefined);
        assert.strictEqual(saved._runtime, undefined);
        assert.strictEqual(saved.$schema, undefined);
        assert.ok(
          messages.some(
            (message) => message.type === MESSAGE_TYPES.WORKFLOW_SAVED
          )
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("preserves multiline scripts as YAML block scalars", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-serializer-multiline-")
      );
      const workingFilePath = path.join(tempDir, "input.ctrlyoke.json");
      const outputPath = path.join(tempDir, "saved.ctrlyoke.yaml");
      const address = {
        workflowKey: "serializer-multiline-test-1",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      } as WorkflowViewAddress;
      const scripts = [
        "a\nb",
        "a\nb\n",
        "line with trailing space \nnext",
        "first\n  indented",
        "first\n\nthird",
      ];

      try {
        await fs.writeFile(
          workingFilePath,
          JSON.stringify({
            steps: scripts.map((script) => ({ type: "script", script })),
          }),
          "utf8"
        );

        const serializer = createWorkflowSerializer(
          () => undefined,
          {} as any,
          () =>
            ({
              getQueueState: () => ({ workingFilePath }),
              getViewAddress: () => address,
            }) as any,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSaveWorkflow(
          "multiline-save",
          address,
          outputPath,
          "yaml"
        );

        const serialized = await fs.readFile(outputPath, "utf8");
        assert.ok(!serialized.includes("yaml-language-server"));
        assert.strictEqual(
          [...serialized.matchAll(/^    script: \|[-+]?\r?$/gm)].length,
          scripts.length
        );
        const parsed = yaml.load(serialized) as {
          steps: Array<{ script: string }>;
        };
        assert.deepStrictEqual(
          parsed.steps.map((step) => step.script),
          scripts
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("round trips every schema-backed field through Save As and templates", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-serializer-schema-")
      );
      const workingFilePath = path.join(tempDir, "input.ctrlyoke.json");
      const outputPath = path.join(tempDir, "saved.ctrlyoke.json");
      const messages: any[] = [];
      const address = {
        workflowKey: "serializer-schema-test-1",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      } as WorkflowViewAddress;
      const schemaFields = schemaBackedFieldNames();
      const promptStep = buildSchemaBackedStep(
        schemaFields.step,
        "prompt-step",
        "prompt"
      );
      const scriptStep = buildSchemaBackedStep(
        schemaFields.step,
        "script-step",
        "script"
      );
      const workingFile: Record<string, unknown> = Object.fromEntries(
        schemaFields.workflow.map((field) => [
          field,
          schemaSentinel("workflow", field),
        ])
      );
      workingFile.steps = [promptStep, scriptStep];
      workingFile.finalStep = promptStep;
      workingFile.vars = { workflowVariable: "value" };
      workingFile.originalFile = "source.ctrlyoke.yaml";
      workingFile.workflowName = "Runtime workflow name";
      workingFile.startedAt = 456;
      workingFile._runtime = {
        currentIndex: 1,
        executionState: "completed",
      };

      let templateWorkflow: Record<string, unknown> | undefined;
      const templatePath = path.join(tempDir, "template.ctrlyoke.json");

      try {
        await fs.writeFile(
          workingFilePath,
          JSON.stringify(workingFile),
          "utf8"
        );

        const serializer = createWorkflowSerializer(
          (message) => messages.push(message),
          {
            saveWorkflowAsTemplate: async (
              _name: string,
              _scope: string,
              workflow: Record<string, unknown>
            ) => {
              templateWorkflow = workflow;
              return templatePath;
            },
            getAvailableTemplates: async () => [
              { id: "schema-template", path: templatePath },
            ],
          } as any,
          () =>
            ({
              getQueueState: () => ({ workingFilePath }),
              getViewAddress: () => address,
            }) as any,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSaveWorkflow(
          "schema-save",
          address,
          outputPath,
          "json"
        );
        await serializer.handleSaveWorkflowAsTemplate(
          "schema-template",
          address,
          "Schema template",
          "workspace",
          "json"
        );

        const saved = JSON.parse(
          await fs.readFile(outputPath, "utf8")
        ) as Record<string, any>;
        assert.ok(templateWorkflow);

        for (const field of schemaFields.workflow) {
          if (field === "steps" || field === "finalStep") {
            continue;
          }
          assert.deepStrictEqual(saved[field], workingFile[field], field);
          assert.deepStrictEqual(
            templateWorkflow?.[field],
            workingFile[field],
            field
          );
        }
        for (const [index, sourceStep] of [promptStep, scriptStep].entries()) {
          for (const field of schemaFields.step) {
            assert.deepStrictEqual(
              saved.steps[index][field],
              sourceStep[field],
              `saved step ${index}.${field}`
            );
            assert.deepStrictEqual(
              (templateWorkflow?.steps as any[])[index][field],
              sourceStep[field],
              `template step ${index}.${field}`
            );
          }
        }

        assert.strictEqual(saved.originalFile, undefined);
        assert.strictEqual(saved.workflowName, undefined);
        assert.strictEqual(saved.startedAt, undefined);
        assert.strictEqual(saved._runtime, undefined);
        assert.strictEqual(saved.steps[0]._runtime, undefined);
        assert.strictEqual(saved.steps[1]._runtime, undefined);
        assert.strictEqual(saved.finalStep._runtime, undefined);
        assert.strictEqual((templateWorkflow as any)?._runtime, undefined);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("reconstructs authored parallel items without persisting normalized groups", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-serializer-parallel-")
      );
      const workingFilePath = path.join(tempDir, "input.ctrlyoke.json");
      const outputPath = path.join(tempDir, "saved.ctrlyoke.json");
      const address = {
        workflowKey: "serializer-parallel-test-1",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      } as WorkflowViewAddress;
      const parallelGroups = [
        {
          id: "first-group",
          startIndex: 1,
          endIndex: 2,
          failFast: false,
        },
        {
          id: "second-group",
          startIndex: 4,
          endIndex: 5,
          failFast: true,
        },
      ];

      try {
        await fs.writeFile(
          workingFilePath,
          JSON.stringify({
            workflowName: "parallel serializer test",
            steps: [
              { prompt: "before" },
              { prompt: "first member" },
              { type: "script", script: "npm test" },
              { prompt: "between" },
              { prompt: "second member" },
              { prompt: "second member two" },
            ],
            parallelGroups,
          }),
          "utf8"
        );

        const serializer = createWorkflowSerializer(
          () => undefined,
          {} as any,
          () =>
            ({
              getQueueState: () => ({ workingFilePath }),
              getViewAddress: () => address,
            }) as any,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSaveWorkflow(
          "parallel-save",
          address,
          outputPath,
          "json"
        );

        const saved = JSON.parse(await fs.readFile(outputPath, "utf8")) as {
          schemaVersion: number;
          steps: Array<Record<string, unknown>>;
          parallelGroups?: unknown;
        };
        assert.strictEqual(saved.schemaVersion, 1);
        assert.strictEqual(saved.parallelGroups, undefined);
        assert.deepStrictEqual(saved.steps[1], {
          parallel: [
            { prompt: "first member" },
            { type: "script", script: "npm test" },
          ],
          failFast: false,
        });
        assert.deepStrictEqual(saved.steps[3], {
          parallel: [
            { prompt: "second member" },
            { prompt: "second member two" },
          ],
          failFast: true,
        });

        const parsed = await new PromptFileParser().parsePromptFile(outputPath);
        assert.ok(parsed);
        assert.deepStrictEqual(
          parsed.parallelGroups?.map(({ startIndex, endIndex, failFast }) => ({
            startIndex,
            endIndex,
            failFast,
          })),
          parallelGroups.map(({ startIndex, endIndex, failFast }) => ({
            startIndex,
            endIndex,
            failFast,
          }))
        );
        assert.notStrictEqual(parsed.parallelGroups?.[0]?.id, "first-group");
        assert.notStrictEqual(parsed.parallelGroups?.[1]?.id, "second-group");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("bundles pasted assets and inlines converted prompt files for a portable round trip", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-serializer-bundle-roundtrip-")
      );
      const restoreWorkspaceFolders = snapshotProperty(
        vscode.workspace,
        "workspaceFolders"
      );
      const workingFilePath = WorkflowPaths.draftFilePath(
        workspaceRoot,
        "serializer-bundle-roundtrip-1" as WorkflowKey
      );
      const outputPath = path.join(
        workspaceRoot,
        "exports",
        "portable.ctrlyoke.json"
      );
      const loadedPath = path.join(
        workspaceRoot,
        "loaded",
        "portable.ctrlyoke.json"
      );
      const address = {
        workflowKey: "serializer-bundle-roundtrip-1",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      } as WorkflowViewAddress;

      try {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: [
            {
              uri: vscode.Uri.file(workspaceRoot),
              name: "bundle-roundtrip",
              index: 0,
            },
          ],
          configurable: true,
        });
        await fs.mkdir(path.join(workspaceRoot, ".ctrlyoke", "prompts"), {
          recursive: true,
        });
        await fs.mkdir(path.join(workspaceRoot, ".ctrlyoke", "attachments"), {
          recursive: true,
        });
        await fs.mkdir(path.dirname(workingFilePath), { recursive: true });
        await fs.writeFile(
          path.join(
            workspaceRoot,
            ".ctrlyoke",
            "prompts",
            "converted.prompt.md"
          ),
          "converted prompt body",
          "utf8"
        );
        await fs.writeFile(
          path.join(workspaceRoot, ".ctrlyoke", "attachments", "pasted.png"),
          Buffer.from([137, 80, 78, 71])
        );
        await fs.writeFile(
          workingFilePath,
          JSON.stringify({
            steps: [
              { prompt: "./.ctrlyoke/prompts/converted.prompt.md" },
              { prompt: "Review @.ctrlyoke/attachments/pasted.png" },
            ],
          }),
          "utf8"
        );

        const messages: any[] = [];
        const serializer = createWorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () =>
            ({
              getQueueState: () => ({ workingFilePath }),
              getViewAddress: () => address,
              getViewSourceDefinitionPath: async () =>
                path.join(workspaceRoot, "authored", "source.ctrlyoke.yaml"),
            }) as any,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleCheckSavePath(
          "bundle-roundtrip-check",
          outputPath,
          address
        );
        const preview = messages.find(
          (message) => message.type === MESSAGE_TYPES.SAVE_PATH_CHECKED
        );
        assert.ok(preview?.bundlePreview?.planFingerprint);

        await fs.writeFile(
          path.join(workspaceRoot, ".ctrlyoke", "attachments", "pasted.png"),
          Buffer.from([137, 80, 78, 71, 1])
        );
        await serializer.handleSaveWorkflow(
          "bundle-roundtrip-stale-save",
          address,
          outputPath,
          "json",
          undefined,
          "panel",
          preview.bundlePreview.planFingerprint
        );
        const staleSave = messages.find(
          (message) =>
            message.type === MESSAGE_TYPES.SAVE_PATH_CHECKED &&
            message.requestId === "bundle-roundtrip-stale-save"
        );
        assert.strictEqual(staleSave?.planChanged, true);
        assert.strictEqual(
          await fs
            .access(outputPath)
            .then(() => true)
            .catch(() => false),
          false
        );
        assert.strictEqual(
          await fs
            .access(path.join(workspaceRoot, "exports", "portable.assets"))
            .then(() => true)
            .catch(() => false),
          false
        );

        await serializer.handleCheckSavePath(
          "bundle-roundtrip-refresh",
          outputPath,
          address
        );
        const refreshed = messages.find(
          (message) =>
            message.type === MESSAGE_TYPES.SAVE_PATH_CHECKED &&
            message.requestId === "bundle-roundtrip-refresh"
        );

        await serializer.handleSaveWorkflow(
          "bundle-roundtrip-save",
          address,
          outputPath,
          "json",
          undefined,
          "panel",
          refreshed.bundlePreview.planFingerprint
        );
        await fs.mkdir(path.dirname(loadedPath), { recursive: true });
        await fs.copyFile(outputPath, loadedPath);
        await fs.cp(
          path.join(workspaceRoot, "exports", "portable.assets"),
          path.join(workspaceRoot, "loaded", "portable.assets"),
          { recursive: true }
        );

        const loaded = JSON.parse(await fs.readFile(loadedPath, "utf8")) as {
          steps: Array<{ prompt: string }>;
        };
        assert.strictEqual(loaded.steps[0].prompt, "converted prompt body");
        const references = parseAllFileReferences(loaded.steps[1].prompt);
        const resolver = new PromptFileResolver({ workspaceRoot });
        for (const reference of references) {
          const resolution = await resolver.resolvePath(
            reference.path,
            loadedPath
          );
          assert.strictEqual(
            resolution.status,
            "resolved",
            `reference did not resolve: ${reference.path}`
          );
        }
        assert.ok(
          loaded.steps[1].prompt.includes("./portable.assets/pasted.png")
        );
        assert.ok(
          await fs.stat(
            path.join(workspaceRoot, "exports", "portable.assets", "pasted.png")
          )
        );
        assert.ok(
          await fs.stat(
            path.join(
              workspaceRoot,
              "exports",
              "portable.assets",
              ".ctrlyoke-assets.json"
            )
          )
        );
      } finally {
        restoreWorkspaceFolders();
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    test("runs template analysis and refuses generated-store asset references", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-serializer-template-bundle-")
      );
      const restoreWorkspaceFolders = snapshotProperty(
        vscode.workspace,
        "workspaceFolders"
      );
      const workingFilePath = WorkflowPaths.draftFilePath(
        workspaceRoot,
        "serializer-template-bundle-1" as WorkflowKey
      );
      const address = {
        workflowKey: "serializer-template-bundle-1",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      } as WorkflowViewAddress;
      const messages: any[] = [];
      let saved = false;

      try {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: [
            {
              uri: vscode.Uri.file(workspaceRoot),
              name: "template-bundle",
              index: 0,
            },
          ],
          configurable: true,
        });
        await fs.mkdir(path.join(workspaceRoot, ".ctrlyoke", "prompts"), {
          recursive: true,
        });
        await fs.mkdir(path.join(workspaceRoot, ".ctrlyoke", "attachments"), {
          recursive: true,
        });
        await fs.mkdir(path.dirname(workingFilePath), { recursive: true });
        await fs.writeFile(
          path.join(
            workspaceRoot,
            ".ctrlyoke",
            "prompts",
            "template.prompt.md"
          ),
          "template body",
          "utf8"
        );
        await fs.writeFile(
          path.join(workspaceRoot, ".ctrlyoke", "attachments", "image.png"),
          "image",
          "utf8"
        );
        const inheritedAssets = path.join(
          workspaceRoot,
          "workflows",
          "fix-tests.assets"
        );
        await fs.mkdir(inheritedAssets, { recursive: true });
        await fs.writeFile(
          path.join(inheritedAssets, "inherited.png"),
          "inherited image",
          "utf8"
        );
        await fs.writeFile(
          path.join(inheritedAssets, BUNDLE_MANIFEST_FILE_NAME),
          JSON.stringify({
            version: BUNDLE_MANIFEST_VERSION,
            owner: "fix-tests.ctrlyoke.yaml",
            files: ["inherited.png"],
          }),
          "utf8"
        );
        await fs.writeFile(
          workingFilePath,
          JSON.stringify({
            steps: [
              { prompt: "./.ctrlyoke/prompts/template.prompt.md" },
              { prompt: "Attach @.ctrlyoke/attachments/image.png" },
              { prompt: "Attach @./fix-tests.assets/inherited.png" },
            ],
          }),
          "utf8"
        );

        const serializer = createWorkflowSerializer(
          (message) => messages.push(message),
          {
            saveWorkflowAsTemplate: async () => {
              saved = true;
              return "template-path";
            },
            getAvailableTemplates: async () => [],
          } as any,
          () =>
            ({
              getQueueState: () => ({ workingFilePath }),
              getViewAddress: () => address,
              getViewSourceDefinitionPath: async () =>
                path.join(workspaceRoot, "workflows", "source.ctrlyoke.yaml"),
            }) as any,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSaveWorkflowAsTemplate(
          "template-bundle-save",
          address,
          "Portable template",
          "workspace",
          "json"
        );

        assert.strictEqual(saved, false);
        const failure = messages.find(
          (message) => message.type === MESSAGE_TYPES.WORKFLOW_SAVE_FAILED
        );
        assert.ok(failure);
        assert.match(
          failure.error,
          /steps\[1\].*\.ctrlyoke\/attachments\/image\.png/i
        );
        assert.match(
          failure.error,
          /steps\[2\].*bundle-managed asset.*\.\/fix-tests\.assets\/inherited\.png/i
        );
      } finally {
        restoreWorkspaceFolders();
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  });

  suite("addressed save-path checks", () => {
    test("uses the same workspace containment rules for preflight and final save", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-save-path-")
      );
      const restoreWorkspaceFolders = snapshotProperty(
        vscode.workspace,
        "workspaceFolders"
      );
      const messages: any[] = [];
      const address = {
        workflowKey: "save-path-test-1",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      } as WorkflowViewAddress;

      try {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: [
            {
              uri: vscode.Uri.file(workspaceRoot),
              name: "save-path-test",
              index: 0,
            },
          ],
          configurable: true,
        });
        const serializer = createWorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () =>
            ({
              getViewAddress: () => address,
              getQueueState: () => ({ workingFilePath: "unused" }),
            }) as any,
          () => undefined,
          fakeWorkspaceState()
        );

        await fs.mkdir(path.join(workspaceRoot, "exports"), {
          recursive: true,
        });
        await writeDraftWorkingFile(
          workspaceRoot,
          address.workflowKey,
          Date.now()
        );
        await fs.writeFile(
          path.join(workspaceRoot, "exports", "existing.ctrlyoke.yaml"),
          "steps: []\n"
        );

        await serializer.handleCheckSavePath(
          "check-existing",
          "exports/existing.ctrlyoke.yaml",
          address
        );
        const existing = messages.pop();
        assert.strictEqual(existing.type, MESSAGE_TYPES.SAVE_PATH_CHECKED);
        assert.strictEqual(existing.requestId, "check-existing");
        assert.strictEqual(existing.path, "exports/existing.ctrlyoke.yaml");
        assert.deepStrictEqual(existing.address, address);
        assert.strictEqual(existing.exists, true);
        assert.strictEqual(existing.bundlePreview.copyCount, 0);
        assert.strictEqual(existing.bundlePreview.inlineCount, 0);

        await serializer.handleCheckSavePath(
          "check-escape",
          "../outside.ctrlyoke.yaml",
          address
        );
        const escaped = messages.pop();
        assert.strictEqual(escaped.type, MESSAGE_TYPES.SAVE_PATH_CHECKED);
        assert.strictEqual(escaped.exists, false);
        assert.match(escaped.error, /inside the open workspace/i);
      } finally {
        restoreWorkspaceFolders();
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    test("rejects a save after the client switches to another address", async () => {
      const messages: any[] = [];
      const current = {
        workflowKey: "workflow-current-1",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      } as WorkflowViewAddress;
      const stale = {
        workflowKey: "workflow-stale-1",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      } as WorkflowViewAddress;
      const serializer = createWorkflowSerializer(
        (message) => messages.push(message),
        {} as any,
        () =>
          ({
            getViewAddress: () => current,
            getQueueState: () => ({ workingFilePath: "unused" }),
          }) as any,
        () => undefined,
        fakeWorkspaceState()
      );

      await serializer.handleCheckSavePath(
        "stale-check",
        "workflow.ctrlyoke.yaml",
        stale
      );
      assert.deepStrictEqual(messages.pop(), {
        type: MESSAGE_TYPES.SAVE_PATH_CHECKED,
        requestId: "stale-check",
        path: "workflow.ctrlyoke.yaml",
        address: stale,
        exists: false,
        error: "The viewed workflow changed.",
      });
    });

    test("rejects bundle blockers without writing the workflow", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-save-blocker-")
      );
      const restoreWorkspaceFolders = snapshotProperty(
        vscode.workspace,
        "workspaceFolders"
      );
      const address = {
        workflowKey: "save-blocker-test-1",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      } as WorkflowViewAddress;
      const outputPath = path.join(
        workspaceRoot,
        "exports",
        "blocked.ctrlyoke.yaml"
      );
      const workingFilePath = WorkflowPaths.draftFilePath(
        workspaceRoot,
        address.workflowKey
      );
      const messages: any[] = [];

      try {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: [
            {
              uri: vscode.Uri.file(workspaceRoot),
              name: "save-blocker-test",
              index: 0,
            },
          ],
          configurable: true,
        });
        await fs.mkdir(path.dirname(workingFilePath), { recursive: true });
        const assetsDirectory = path.join(
          workspaceRoot,
          "exports",
          "blocked.assets"
        );
        await fs.mkdir(assetsDirectory, { recursive: true });
        await fs.writeFile(
          path.join(assetsDirectory, BUNDLE_MANIFEST_FILE_NAME),
          JSON.stringify({
            version: BUNDLE_MANIFEST_VERSION,
            owner: "blocked.ctrlyoke.json",
            files: [],
          }),
          "utf8"
        );
        await fs.writeFile(
          path.join(workspaceRoot, "exports", "blocked.ctrlyoke.json"),
          "{}",
          "utf8"
        );
        await fs.writeFile(
          workingFilePath,
          JSON.stringify({ steps: [{ prompt: "No generated references" }] }),
          "utf8"
        );
        const serializer = createWorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () =>
            ({
              getViewAddress: () => address,
              getQueueState: () => ({ workingFilePath }),
            }) as any,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleCheckSavePath(
          "blocked-preview",
          outputPath,
          address
        );
        const preview = messages.find(
          (message) => message.requestId === "blocked-preview"
        );
        assert.ok(preview?.bundlePreview?.blockers.length > 0);
        assert.ok(
          preview.bundlePreview.blockers.some((blocker: { message: string }) =>
            blocker.message.includes("blocked.ctrlyoke.json")
          )
        );

        await serializer.handleSaveWorkflow(
          "blocked-save",
          address,
          outputPath,
          "yaml",
          undefined,
          "panel",
          preview.bundlePreview.planFingerprint
        );
        assert.ok(
          messages.some(
            (message) =>
              message.type === MESSAGE_TYPES.WORKFLOW_SAVE_FAILED &&
              message.requestId === "blocked-save"
          )
        );
        assert.strictEqual(
          await fs
            .access(outputPath)
            .then(() => true)
            .catch(() => false),
          false
        );
      } finally {
        restoreWorkspaceFolders();
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  });

  suite("addressed save framing", () => {
    test("frames a pending rewind as an intentional run export", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-save-frame-")
      );
      const restoreWorkspaceFolders = snapshotProperty(
        vscode.workspace,
        "workspaceFolders"
      );
      const messages: any[] = [];

      try {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: [
            {
              uri: vscode.Uri.file(workspaceRoot),
              name: "save-frame-test",
              index: 0,
            },
          ],
          configurable: true,
        });
        const repository = new WorkflowLineageRepository();
        const lineage = await repository.createLineage(
          workspaceRoot,
          "pending-save",
          "Pending save",
          path.join(workspaceRoot, "source.ctrlyoke.yaml")
        );
        const run = await repository.allocateRun(
          workspaceRoot,
          lineage.workflowKey
        );
        const address = {
          workflowKey: lineage.workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: run.runRef,
        } as WorkflowViewAddress;
        const startedAt = Date.UTC(2026, 6, 20);
        await fs.writeFile(
          run.stagingRunFilePath,
          JSON.stringify({
            workflowName: "Pending save",
            definitionRevision: 2,
            steps: [],
            _runtime: {
              currentIndex: 0,
              executionState: "completed",
              pendingRewind: {
                fromStepIndex: 1,
                baseDefinitionRevision: 1,
              },
            },
          })
        );
        await fs.writeFile(
          path.join(run.stagingRunDir, "manifest.json"),
          JSON.stringify({
            schemaVersion: "2.2.0",
            storageKind: "timeline",
            workflowId: "test",
            runId: run.runId,
            startedAt,
            executionState: "completed",
            definitionRevision: 2,
            stepCount: 0,
            eventCount: 0,
            nextSequence: 0,
            lastUpdatedAt: startedAt,
          })
        );
        await fs.writeFile(path.join(run.stagingRunDir, "events.jsonl"), "");
        await repository.finalizeAllocatedRun(
          workspaceRoot,
          lineage.workflowKey,
          run
        );
        const serializer = createWorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () =>
            ({
              getViewAddress: () => address,
              getQueueState: () => ({ workingFilePath: "unused" }),
            }) as any,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSaveWorkflowRequest("save-pending", address);
        const dialog = messages.pop();
        assert.strictEqual(
          dialog.type,
          MESSAGE_TYPES.SAVE_WORKFLOW_DIALOG_DATA
        );
        assert.strictEqual(dialog.title, "Save Pending save");
        assert.strictEqual(
          dialog.subtitle,
          `Run ${run.runId} — pending continuation`
        );
        assert.strictEqual(dialog.address.runRef, run.runRef);
        assert.strictEqual(
          dialog.defaultPath,
          path.join(workspaceRoot, "source.ctrlyoke.yaml")
        );
      } finally {
        restoreWorkspaceFolders();
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  });

  suite("handleGetRecentWorkflows: runNav", () => {
    test("a single promoted run with no draft reports runCount 1 and no drill affordance beyond it", async () => {
      await withWorkspace("ctrlyoke-recent-single-", async (workspaceRoot) => {
        const repository = new WorkflowLineageRepository();
        const lineage = await repository.createLineage(
          workspaceRoot,
          "wf-recent-single",
          "Recent Single"
        );
        const { runRef, runId } = await createPromotedRun(
          repository,
          workspaceRoot,
          lineage.workflowKey,
          1_000
        );

        const messages: any[] = [];
        const serializer = createWorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () => undefined,
          () => undefined,
          fakeWorkspaceState()
        );
        await serializer.handleGetRecentWorkflows();

        const message = messages.pop();
        assert.strictEqual(message.type, MESSAGE_TYPES.RECENT_WORKFLOWS);
        assert.strictEqual(message.workflows.length, 1);
        assert.strictEqual(
          message.workflows[0].runDirectory,
          WorkflowPaths.runDir(workspaceRoot, lineage.workflowKey, runRef)
        );
        assert.deepStrictEqual(message.workflows[0].runNav, {
          primaryAddress: {
            workflowKey: lineage.workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef,
          },
          primaryRunId: runId,
          runCount: 1,
          hasDraft: false,
        });
      });
    });

    test("multiple promoted runs report the total count and the latest run's id", async () => {
      await withWorkspace("ctrlyoke-recent-multi-", async (workspaceRoot) => {
        const repository = new WorkflowLineageRepository();
        const lineage = await repository.createLineage(
          workspaceRoot,
          "wf-recent-multi",
          "Recent Multi"
        );
        await createPromotedRun(
          repository,
          workspaceRoot,
          lineage.workflowKey,
          1_000
        );
        const { runRef: latestRunRef, runId: latestRunId } =
          await createPromotedRun(
            repository,
            workspaceRoot,
            lineage.workflowKey,
            2_000
          );

        const messages: any[] = [];
        const serializer = createWorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () => undefined,
          () => undefined,
          fakeWorkspaceState()
        );
        await serializer.handleGetRecentWorkflows();

        const message = messages.pop();
        assert.strictEqual(
          message.workflows[0].runDirectory,
          WorkflowPaths.runDir(workspaceRoot, lineage.workflowKey, latestRunRef)
        );
        assert.deepStrictEqual(message.workflows[0].runNav, {
          primaryAddress: {
            workflowKey: lineage.workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: latestRunRef,
          },
          primaryRunId: latestRunId,
          runCount: 2,
          hasDraft: false,
        });
      });
    });

    test("a fresh lineage with no promoted run reports a draft-only row", async () => {
      await withWorkspace("ctrlyoke-recent-draft-", async (workspaceRoot) => {
        const repository = new WorkflowLineageRepository();
        const lineage = await repository.createLineage(
          workspaceRoot,
          "wf-recent-draft",
          "Recent Draft"
        );
        await writeDraftWorkingFile(workspaceRoot, lineage.workflowKey, 1_000);

        const messages: any[] = [];
        const serializer = createWorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () => undefined,
          () => undefined,
          fakeWorkspaceState()
        );
        await serializer.handleGetRecentWorkflows();

        const message = messages.pop();
        assert.strictEqual(
          message.workflows[0].runDirectory,
          WorkflowPaths.draftDir(workspaceRoot, lineage.workflowKey)
        );
        assert.deepStrictEqual(message.workflows[0].runNav, {
          primaryAddress: {
            workflowKey: lineage.workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
          },
          primaryRunId: undefined,
          runCount: 0,
          hasDraft: true,
          draftDirectory: WorkflowPaths.draftDir(
            workspaceRoot,
            lineage.workflowKey
          ),
        });
      });
    });

    test("a run extended after its promotion outranks a lineage whose descriptor changed more recently", async () => {
      await withWorkspace(
        "ctrlyoke-recent-extended-",
        async (workspaceRoot) => {
          const repository = new WorkflowLineageRepository();
          const extended = await repository.createLineage(
            workspaceRoot,
            "wf-extended",
            "Extended"
          );
          const { runRef } = await createPromotedRun(
            repository,
            workspaceRoot,
            extended.workflowKey,
            1_000
          );
          const untouched = await repository.createLineage(
            workspaceRoot,
            "wf-untouched",
            "Untouched"
          );
          await writeDraftWorkingFile(
            workspaceRoot,
            untouched.workflowKey,
            1_000
          );
          const untouchedDescriptor = await repository.readDescriptor(
            workspaceRoot,
            untouched.workflowKey
          );

          // Appending to and continuing a run writes only its working file —
          // never the descriptor — so its activity must still count as recency.
          const continuedAt = untouchedDescriptor.lastModifiedAt + 60_000;
          const runFilePath = WorkflowPaths.runFilePath(
            workspaceRoot,
            extended.workflowKey,
            runRef
          );
          const runFile = JSON.parse(await fs.readFile(runFilePath, "utf8"));
          runFile.steps.push({
            prompt: "appended",
            _runtime: {
              startedAt: continuedAt - 1_000,
              completedAt: continuedAt,
            },
          });
          runFile._runtime.executionEndTime = continuedAt;
          await fs.writeFile(runFilePath, JSON.stringify(runFile));

          const messages: any[] = [];
          const serializer = createWorkflowSerializer(
            (message) => messages.push(message),
            {} as any,
            () => undefined,
            () => undefined,
            fakeWorkspaceState()
          );
          await serializer.handleGetRecentWorkflows();

          const workflows = messages.pop().workflows;
          assert.deepStrictEqual(
            workflows.map((workflow: any) => workflow.address.workflowKey),
            [extended.workflowKey, untouched.workflowKey]
          );
          assert.strictEqual(workflows[0].lastModifiedAt, continuedAt);
          assert.strictEqual(
            workflows[1].lastModifiedAt,
            untouchedDescriptor.lastModifiedAt
          );
        }
      );
    });

    test("a promoted run plus a seeded draft reports hasDraft alongside the run count", async () => {
      await withWorkspace(
        "ctrlyoke-recent-run-draft-",
        async (workspaceRoot) => {
          const repository = new WorkflowLineageRepository();
          const lineage = await repository.createLineage(
            workspaceRoot,
            "wf-recent-run-draft",
            "Recent Run Plus Draft"
          );
          const { runRef, runId } = await createPromotedRun(
            repository,
            workspaceRoot,
            lineage.workflowKey,
            1_000
          );
          await repository.updateDescriptor(
            workspaceRoot,
            lineage.workflowKey,
            (descriptor) => ({
              ...descriptor,
              pendingEdit: { kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
            })
          );
          await writeDraftWorkingFile(
            workspaceRoot,
            lineage.workflowKey,
            2_000
          );

          const messages: any[] = [];
          const serializer = createWorkflowSerializer(
            (message) => messages.push(message),
            {} as any,
            () => undefined,
            () => undefined,
            fakeWorkspaceState()
          );
          await serializer.handleGetRecentWorkflows();

          const message = messages.pop();
          assert.strictEqual(
            message.workflows[0].runDirectory,
            WorkflowPaths.runDir(workspaceRoot, lineage.workflowKey, runRef)
          );
          // latestRunRef is still set, so the row's primary/displayed address stays
          // the run — hasDraft is what signals a separately reachable draft exists.
          assert.deepStrictEqual(message.workflows[0].runNav, {
            primaryAddress: {
              workflowKey: lineage.workflowKey,
              kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
              runRef,
            },
            primaryRunId: runId,
            runCount: 1,
            hasDraft: true,
            draftDirectory: WorkflowPaths.draftDir(
              workspaceRoot,
              lineage.workflowKey
            ),
          });
        }
      );
    });
  });
  suite("history deletes go to Recently deleted", () => {
    function createSerializer(
      messages: any[],
      isLineageExecuting: (workflowKey: WorkflowKey) => boolean = () => false,
      refreshRunViewsForLineages?: (
        workflowKeys: readonly WorkflowKey[],
        send: (message: unknown) => void,
        clientId: string,
        preferLatestRunForDraft: boolean
      ) => Promise<void>,
      forgetRunActivity?: (workflowKey: WorkflowKey) => void
    ): WorkflowSerializer {
      return createWorkflowSerializer(
        (message) => messages.push(message),
        {} as any,
        () =>
          ({
            isLineageExecuting,
            getWorkflowSummaries: () => [],
            refreshRunViewsForLineages,
            forgetRunActivity,
          }) as unknown as WorkflowOrchestrator,
        () => undefined,
        fakeWorkspaceState()
      );
    }

    async function cleanUpStateRoot(workspaceRoot: string): Promise<void> {
      await fs.rm(path.dirname(WorkflowPaths.runsRoot(workspaceRoot)), {
        recursive: true,
        force: true,
      });
    }

    test("Clear all history is refused without its confirmation phrase", async () => {
      await withWorkspace("ctrlyoke-clear-refused-", async (workspaceRoot) => {
        const repository = new WorkflowLineageRepository();
        const lineage = await repository.createLineage(
          workspaceRoot,
          "wf-keep",
          "Keep"
        );
        const messages: any[] = [];
        try {
          const moved =
            await createSerializer(messages).handleClearWorkflowHistory(
              undefined
            );

          assert.strictEqual(moved.size, 0);
          assert.deepStrictEqual(
            await repository.listLineageKeys(workspaceRoot),
            [lineage.workflowKey]
          );
          assert.strictEqual(
            messages[0].type,
            MESSAGE_TYPES.WORKFLOW_ACTION_FAILED
          );
        } finally {
          await cleanUpStateRoot(workspaceRoot);
        }
      });
    });

    test("Clear all history with the phrase moves idle workflows and keeps executing ones", async () => {
      await withWorkspace("ctrlyoke-clear-all-", async (workspaceRoot) => {
        const repository = new WorkflowLineageRepository();
        const idle = await repository.createLineage(
          workspaceRoot,
          "wf-idle",
          "Idle"
        );
        const paused = await repository.createLineage(
          workspaceRoot,
          "wf-paused",
          "Paused"
        );
        const messages: any[] = [];
        try {
          const moved = await createSerializer(
            messages,
            (workflowKey) => workflowKey === paused.workflowKey
          ).handleClearWorkflowHistory(CLEAR_HISTORY_CONFIRMATION_PHRASE);

          assert.deepStrictEqual([...moved], [idle.workflowKey]);
          assert.deepStrictEqual(
            await repository.listLineageKeys(workspaceRoot),
            [paused.workflowKey]
          );
          const trashed = messages.find(
            (message) => message.type === MESSAGE_TYPES.HISTORY_TRASHED
          );
          assert.ok(trashed, "the client should get an Undo toast");
          assert.deepStrictEqual(trashed.skippedLive, [paused.workflowKey]);
        } finally {
          await cleanUpStateRoot(workspaceRoot);
        }
      });
    });

    test("removing an executing workflow is refused and the list is resent", async () => {
      await withWorkspace("ctrlyoke-remove-live-", async (workspaceRoot) => {
        const repository = new WorkflowLineageRepository();
        const lineage = await repository.createLineage(
          workspaceRoot,
          "wf-live",
          "Live"
        );
        const messages: any[] = [];
        try {
          const removed = await createSerializer(
            messages,
            () => true
          ).handleRemoveWorkflowHistory({
            workflowKey: lineage.workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
          });

          assert.strictEqual(removed, false);
          assert.deepStrictEqual(
            await repository.listLineageKeys(workspaceRoot),
            [lineage.workflowKey]
          );
          assert.deepStrictEqual(
            messages.map((message) => message.type),
            [
              MESSAGE_TYPES.WORKFLOW_ACTION_FAILED,
              MESSAGE_TYPES.RECENT_WORKFLOWS,
            ]
          );
          assert.match(messages[0].error, /Stop it before deleting it/);
        } finally {
          await cleanUpStateRoot(workspaceRoot);
        }
      });
    });

    test("a restore puts the workflow back and resends the list", async () => {
      await withWorkspace("ctrlyoke-restore-", async (workspaceRoot) => {
        const repository = new WorkflowLineageRepository();
        const lineage = await repository.createLineage(
          workspaceRoot,
          "wf-restore",
          "Restore"
        );
        const messages: any[] = [];
        const tracker = new WorkflowActivityTracker(() => undefined);
        const activity = {
          id: "failed-run-a",
          workflowKey: lineage.workflowKey,
          runRef: "run-a" as never,
          workflowName: "Restore",
          currentStep: 0,
          totalSteps: 1,
          finalStepRunning: false,
        };
        tracker.observe({
          ...activity,
          executionState: EXECUTION_STATES.RUNNING,
        });
        tracker.observe({
          ...activity,
          executionState: EXECUTION_STATES.ERROR,
        });
        tracker.observe({
          ...activity,
          id: "failed-run-b",
          runRef: "run-b" as never,
          executionState: EXECUTION_STATES.RUNNING,
        });
        tracker.observe({
          ...activity,
          id: "failed-run-b",
          runRef: "run-b" as never,
          executionState: EXECUTION_STATES.ERROR,
        });
        const serializer = createSerializer(
          messages,
          () => false,
          undefined,
          (workflowKey) => tracker.forgetRun(workflowKey)
        );
        try {
          const removed = await serializer.handleRemoveWorkflowHistory({
            workflowKey: lineage.workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
          });
          assert.strictEqual(removed, true);
          assert.deepStrictEqual(tracker.buildSummary([]).unseenFailures, []);
          const trashed = messages.find(
            (message) => message.type === MESSAGE_TYPES.HISTORY_TRASHED
          );
          assert.ok(trashed);
          messages.length = 0;

          await serializer.handleHistoryTrashAction(
            HISTORY_TRASH_ACTIONS.RESTORE,
            { entryId: trashed.entryId }
          );

          assert.deepStrictEqual(
            await repository.listLineageKeys(workspaceRoot),
            [lineage.workflowKey]
          );
          assert.deepStrictEqual(
            messages.map((message) => message.type),
            [
              MESSAGE_TYPES.HISTORY_TRASH_RESULT,
              MESSAGE_TYPES.RECENT_WORKFLOWS,
              MESSAGE_TYPES.HISTORY_TRASH_LIST,
            ]
          );
          assert.strictEqual(messages[0].ok, true);
          assert.deepStrictEqual(messages[2].entries, []);
        } finally {
          tracker.dispose();
          await cleanUpStateRoot(workspaceRoot);
        }
      });
    });

    test("restore refreshes views for the restored workflow keys", async () => {
      await withWorkspace(
        "ctrlyoke-restore-refresh-",
        async (workspaceRoot) => {
          const repository = new WorkflowLineageRepository();
          const lineage = await repository.createLineage(
            workspaceRoot,
            "wf-restore-refresh",
            "Restore refresh"
          );
          const messages: any[] = [];
          let refreshedKeys: readonly WorkflowKey[] = [];
          try {
            const serializer = createSerializer(
              messages,
              () => false,
              async (keys, send, _clientId, preferLatestRunForDraft) => {
                refreshedKeys = keys;
                assert.strictEqual(preferLatestRunForDraft, true);
                send({
                  type: MESSAGE_TYPES.RUN_VIEW_LOADED,
                  workflowKey: lineage.workflowKey,
                  runs: [{ runRef: "run-restored" }],
                });
              }
            );
            await serializer.handleRemoveWorkflowHistory({
              workflowKey: lineage.workflowKey,
              kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
            });
            const trashed = messages.find(
              (message) => message.type === MESSAGE_TYPES.HISTORY_TRASHED
            );
            assert.ok(trashed);
            messages.length = 0;

            await serializer.handleHistoryTrashAction(
              HISTORY_TRASH_ACTIONS.RESTORE,
              { entryId: trashed.entryId }
            );

            assert.deepStrictEqual(refreshedKeys, [lineage.workflowKey]);
            const loaded = messages.find(
              (message) => message.type === MESSAGE_TYPES.RUN_VIEW_LOADED
            );
            assert.deepStrictEqual(loaded.runs, [{ runRef: "run-restored" }]);
          } finally {
            await cleanUpStateRoot(workspaceRoot);
          }
        }
      );
    });

    test("emptying Recently deleted needs its own phrase", async () => {
      await withWorkspace("ctrlyoke-empty-", async (workspaceRoot) => {
        const repository = new WorkflowLineageRepository();
        const lineage = await repository.createLineage(
          workspaceRoot,
          "wf-empty",
          "Empty"
        );
        const messages: any[] = [];
        const serializer = createSerializer(messages);
        try {
          await serializer.handleRemoveWorkflowHistory({
            workflowKey: lineage.workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
          });
          messages.length = 0;

          await serializer.handleHistoryTrashAction(
            HISTORY_TRASH_ACTIONS.EMPTY,
            { confirmation: CLEAR_HISTORY_CONFIRMATION_PHRASE }
          );
          assert.strictEqual(messages[0].ok, false);
          assert.strictEqual(messages[1].entries.length, 1);

          messages.length = 0;
          await serializer.handleHistoryTrashAction(
            HISTORY_TRASH_ACTIONS.EMPTY,
            { confirmation: EMPTY_TRASH_CONFIRMATION_PHRASE }
          );
          assert.strictEqual(messages[0].ok, true);
          assert.deepStrictEqual(messages[1].entries, []);
        } finally {
          await cleanUpStateRoot(workspaceRoot);
        }
      });
    });
  });
});
