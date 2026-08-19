import * as assert from "assert";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { suite, test } from "mocha";
import { WorkflowSerializer } from "../../ui/WorkflowSerializer";
import { configService } from "../../config/CtrlYokeConfigService";
import { CONFIG_KEYS } from "../../utils/ConfigurationUtils";
import { MESSAGE_TYPES } from "../../types/DashboardConstants";
import type {
  WorkflowViewAddress,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { PromptFileResolver } from "../../core/PromptFileResolver";
import { parseAllFileReferences } from "../../utils/FileReferenceParser";
import {
  BUNDLE_MANIFEST_FILE_NAME,
  BUNDLE_MANIFEST_VERSION,
} from "../../utils/WorkflowBundleAnalyzer";

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

class RecordingMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.values.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

interface SchemaNode {
  $ref?: string;
  properties?: Record<string, unknown>;
  allOf?: SchemaNode[];
}

interface WorkflowSchema {
  definitions: Record<string, SchemaNode>;
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
    schema.definitions.executionProperties
  );
  const promptFields = directSchemaPropertyNames(schema.definitions.promptStep);
  const scriptFields = directSchemaPropertyNames(schema.definitions.scriptStep);
  const multiStepWorkflowFields = directSchemaPropertyNames(
    schema.oneOf[1].allOf?.find((node) => node.properties?.steps) ?? {}
  );
  const runtimeOnlyWorkflowFields = new Set([
    "originalFile",
    "workflowName",
    "startedAt",
    "_runtime",
  ]);
  const singleStepWorkflowFields = promptFields.filter(
    (field) => field === "prompt"
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
    ].filter((field) => field !== "_runtime"),
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
    fields.map((field) => [field, schemaSentinel(context, field)])
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

suite("WorkflowSerializer", () => {
  suite("handleSetDefaultTemplate", () => {
    test("should write general.defaultTemplate and notify the webview", async () => {
      const originalSet = configService.set.bind(configService);
      const setCalls: Array<{ key: string; value: unknown; scope: string }> =
        [];
      const messages: any[] = [];

      try {
        configService.set = (async (key, value, scope) => {
          setCalls.push({ key, value, scope });
        }) as typeof configService.set;

        const serializer = new WorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () => undefined,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSetDefaultTemplate("blank");

        assert.deepStrictEqual(setCalls, [
          {
            key: CONFIG_KEYS.GENERAL_DEFAULT_TEMPLATE,
            value: "blank",
            scope: "user",
          },
        ]);
        assert.deepStrictEqual(messages, [
          {
            type: MESSAGE_TYPES.DEFAULT_TEMPLATE_SET,
            templateId: "blank",
          },
        ]);
      } finally {
        configService.set = originalSet;
      }
    });
  });

  suite("handleBrowseTemplateFile", () => {
    test("remembers the selected file's directory for the next native picker", async () => {
      const workspaceRoot = path.join(os.tmpdir(), "ctrlyoke-picker-workspace");
      const selectedFile = path.join(workspaceRoot, "specs", "feature.md");
      const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
      const originalShowOpenDialog = vscode.window.showOpenDialog;
      const dialogOptions: vscode.OpenDialogOptions[] = [];
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
        Object.defineProperty(vscode.window, "showOpenDialog", {
          value: async (options: vscode.OpenDialogOptions) => {
            dialogOptions.push(options);
            callCount += 1;
            return callCount === 1
              ? [vscode.Uri.file(selectedFile)]
              : undefined;
          },
          configurable: true,
        });

        const messages: unknown[] = [];
        const serializer = new WorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () => undefined,
          () => undefined,
          new RecordingMemento()
        );

        await serializer.handleBrowseTemplateFile("spec", ["**/*.md"]);
        await serializer.handleBrowseTemplateFile("spec", ["**/*.md"]);

        assert.strictEqual(
          dialogOptions[0].defaultUri?.fsPath,
          vscode.Uri.file(workspaceRoot).fsPath
        );
        assert.strictEqual(
          dialogOptions[1].defaultUri?.fsPath,
          path.dirname(vscode.Uri.file(selectedFile).fsPath)
        );
        assert.deepStrictEqual(messages, [
          {
            type: MESSAGE_TYPES.TEMPLATE_FILE_SELECTED,
            variable: "spec",
            path: "specs/feature.md",
          },
        ]);
      } finally {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: originalWorkspaceFolders,
          configurable: true,
        });
        Object.defineProperty(vscode.window, "showOpenDialog", {
          value: originalShowOpenDialog,
          configurable: true,
        });
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
        kind: "draft",
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
                retryDelayMs: 2500,
              },
              steps: [
                {
                  prompt: "Step one",
                  errorBehavior: { onError: "continue" },
                  _runtime: { startedAt: 1 },
                },
              ],
              _runtime: { currentIndex: 0, executionState: "idle" },
            },
            null,
            2
          ),
          "utf8"
        );

        const serializer = new WorkflowSerializer(
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
          retryDelayMs: 2500,
        });
        assert.deepStrictEqual(saved.steps[0].errorBehavior, {
          onError: "continue",
        });
        assert.strictEqual(saved.steps[0]._runtime, undefined);
        assert.ok(
          messages.some(
            (message) => message.type === MESSAGE_TYPES.WORKFLOW_SAVED
          )
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
        kind: "draft",
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

        const serializer = new WorkflowSerializer(
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

    test("bundles pasted assets and inlines converted prompt files for a portable round trip", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-serializer-bundle-roundtrip-")
      );
      const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
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
        kind: "draft",
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
        const serializer = new WorkflowSerializer(
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
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: originalWorkspaceFolders,
          configurable: true,
        });
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    test("runs template analysis and refuses generated-store asset references", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-serializer-template-bundle-")
      );
      const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
      const workingFilePath = WorkflowPaths.draftFilePath(
        workspaceRoot,
        "serializer-template-bundle-1" as WorkflowKey
      );
      const address = {
        workflowKey: "serializer-template-bundle-1",
        kind: "draft",
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

        const serializer = new WorkflowSerializer(
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
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: originalWorkspaceFolders,
          configurable: true,
        });
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  });

  suite("addressed save-path checks", () => {
    test("uses the same workspace containment rules for preflight and final save", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-save-path-")
      );
      const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
      const messages: any[] = [];
      const address = {
        workflowKey: "save-path-test-1",
        kind: "draft",
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
        const serializer = new WorkflowSerializer(
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
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: originalWorkspaceFolders,
          configurable: true,
        });
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    test("rejects a save after the client switches to another address", async () => {
      const messages: any[] = [];
      const current = {
        workflowKey: "workflow-current-1",
        kind: "draft",
      } as WorkflowViewAddress;
      const stale = {
        workflowKey: "workflow-stale-1",
        kind: "draft",
      } as WorkflowViewAddress;
      const serializer = new WorkflowSerializer(
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
      const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
      const address = {
        workflowKey: "save-blocker-test-1",
        kind: "draft",
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
        await fs.writeFile(
          workingFilePath,
          JSON.stringify({
            steps: [{ prompt: "Attach @.ctrlyoke/attachments/missing.png" }],
          }),
          "utf8"
        );
        const serializer = new WorkflowSerializer(
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
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: originalWorkspaceFolders,
          configurable: true,
        });
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  });

  suite("addressed save framing", () => {
    test("frames a pending rewind as an intentional run export", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-save-frame-")
      );
      const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
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
          kind: "run",
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
        const serializer = new WorkflowSerializer(
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
        assert.strictEqual(
          dialog.title,
          `Save run ${run.runId} — pending continuation`
        );
        assert.strictEqual(dialog.address.runRef, run.runRef);
        assert.strictEqual(
          dialog.defaultPath,
          path.join(workspaceRoot, "source.ctrlyoke.yaml")
        );
      } finally {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: originalWorkspaceFolders,
          configurable: true,
        });
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  });

  suite("handleGetRecentWorkflows: runNav", () => {
    async function withWorkspace(
      prefix: string,
      run: (workspaceRoot: string) => Promise<void>
    ): Promise<void> {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
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
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: originalWorkspaceFolders,
          configurable: true,
        });
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    }

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
        const serializer = new WorkflowSerializer(
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
            kind: "run",
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
        const serializer = new WorkflowSerializer(
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
            kind: "run",
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
        const serializer = new WorkflowSerializer(
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
          primaryAddress: { workflowKey: lineage.workflowKey, kind: "draft" },
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
              pendingEdit: { kind: "draft" },
            })
          );
          await writeDraftWorkingFile(
            workspaceRoot,
            lineage.workflowKey,
            2_000
          );

          const messages: any[] = [];
          const serializer = new WorkflowSerializer(
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
              kind: "run",
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
});
