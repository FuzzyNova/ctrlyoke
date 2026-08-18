import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { PromptEditorSupportService } from "../../ui/PromptEditorSupportService";
import { createWebviewClientContext } from "../../ui/WebviewClientContext";
import { MESSAGE_TYPES } from "../../types/DashboardConstants";
import { pathsEqual } from "../../utils/PathCasing";

suite("PromptEditorSupportService", () => {
  let workspaceRoot: string;
  let originalWorkspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-editor-support-")
    );
    originalWorkspaceFolders = vscode.workspace.workspaceFolders;
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      value: [
        {
          uri: vscode.Uri.file(workspaceRoot),
          name: "test-workspace",
          index: 0,
        },
      ],
    });
  });

  teardown(async () => {
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      value: originalWorkspaceFolders,
    });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("reports empty prompt files with the request sequence and resolved path", async () => {
    const promptFile = path.join(
      workspaceRoot,
      ".ctrlyoke",
      "prompts",
      "empty.prompt.md"
    );
    await fs.mkdir(path.dirname(promptFile), { recursive: true });
    await fs.writeFile(promptFile, " \n\t ", "utf8");

    const emitted: unknown[] = [];
    const service = new PromptEditorSupportService(
      () => workspaceRoot,
      () => undefined,
      () => undefined
    );
    await service.handleFileRefValidation(
      createWebviewClientContext("test-client", (message) => {
        emitted.push(message);
      }),
      "./.ctrlyoke/prompts/empty.prompt.md",
      42,
      { workflowKey: "test", kind: "draft" }
    );

    const validation = emitted[0] as {
      type: string;
      seq: number;
      filePath: string;
      exists: boolean;
      isEmpty: boolean;
      resolvedPath: string;
    };
    assert.strictEqual(validation.type, MESSAGE_TYPES.FILE_REF_VALIDATION);
    assert.strictEqual(validation.seq, 42);
    assert.strictEqual(
      validation.filePath,
      "./.ctrlyoke/prompts/empty.prompt.md"
    );
    assert.strictEqual(validation.exists, true);
    assert.strictEqual(validation.isEmpty, true);
    assert.ok(
      pathsEqual(validation.resolvedPath, promptFile),
      `expected ${validation.resolvedPath} to resolve to ${promptFile}`
    );
  });

  test("reports zero-byte prompt files as empty too", async () => {
    const promptFile = path.join(
      workspaceRoot,
      ".ctrlyoke",
      "prompts",
      "zero.prompt.md"
    );
    await fs.mkdir(path.dirname(promptFile), { recursive: true });
    await fs.writeFile(promptFile, "", "utf8");

    const emitted: unknown[] = [];
    const service = new PromptEditorSupportService(
      () => workspaceRoot,
      () => undefined,
      () => undefined
    );
    await service.handleFileRefValidation(
      createWebviewClientContext("test-client", (message) => {
        emitted.push(message);
      }),
      "./.ctrlyoke/prompts/zero.prompt.md",
      43
    );

    assert.strictEqual((emitted[0] as { exists: boolean }).exists, true);
    assert.strictEqual((emitted[0] as { isEmpty: boolean }).isEmpty, true);
    assert.strictEqual((emitted[0] as { seq: number }).seq, 43);
  });

  test("validates relocated workflow-relative context references", async () => {
    const workflowPath = path.join(
      workspaceRoot,
      "bundles",
      "workflow.ctrlyoke.yaml"
    );
    const assetPath = path.join(
      workspaceRoot,
      "bundles",
      "workflow.assets",
      "shot.png"
    );
    await fs.mkdir(path.dirname(assetPath), { recursive: true });
    await fs.writeFile(assetPath, "asset", "utf8");

    const emitted: unknown[] = [];
    const service = new PromptEditorSupportService(
      () => workspaceRoot,
      () =>
        ({
          getViewSourceDefinitionPath: async () => workflowPath,
        }) as any,
      () => undefined
    );

    await service.handleContextRefsValidation(
      createWebviewClientContext("test-client", (message) => {
        emitted.push(message);
      }),
      [{ id: "asset", type: "file", path: "./workflow.assets/shot.png" }]
    );

    const result = emitted[0] as {
      results: Array<{ exists: boolean; message?: string }>;
    };
    assert.deepStrictEqual(result.results, [{ id: "asset", exists: true }]);
  });

  test("explains when a relative context reference has no workflow location", async () => {
    const emitted: unknown[] = [];
    const service = new PromptEditorSupportService(
      () => workspaceRoot,
      () => undefined,
      () => undefined
    );

    await service.handleContextRefsValidation(
      createWebviewClientContext("test-client", (message) => {
        emitted.push(message);
      }),
      [{ id: "asset", type: "file", path: "./workflow.assets/shot.png" }]
    );

    const result = emitted[0] as {
      results: Array<{ exists: boolean; message?: string }>;
    };
    assert.strictEqual(result.results[0].exists, false);
    assert.match(
      result.results[0].message ?? "",
      /relative to the workflow file, which has no known location/i
    );
  });

  test("guides old workspace run-history refs to path-independent priorContext", async () => {
    const emitted: unknown[] = [];
    const service = new PromptEditorSupportService(
      () => workspaceRoot,
      () => undefined,
      () => undefined
    );

    await service.handleContextRefsValidation(
      createWebviewClientContext("test-client", (message) => {
        emitted.push(message);
      }),
      [
        {
          id: "old-run",
          type: "file",
          path: "@.ctrlyoke/.runs/workflow/run/manifest.json",
        },
      ]
    );

    const result = emitted[0] as {
      results: Array<{ exists: boolean; message?: string }>;
    };
    assert.strictEqual(result.results[0].exists, false);
    assert.match(result.results[0].message ?? "", /priorContext/);
    assert.match(result.results[0].message ?? "", /workflowKey/);
    assert.match(result.results[0].message ?? "", /runRef/);
  });

  test("emits script completions through the requesting client context", async () => {
    const emitted: unknown[] = [];
    const service = new PromptEditorSupportService(
      () => workspaceRoot,
      () => undefined,
      () => undefined
    );

    await service.handleScriptCompletionRequest(
      createWebviewClientContext("browser:1", (message) => {
        emitted.push(message);
      }),
      "git st",
      6,
      101
    );

    const response = emitted[0] as {
      type: string;
      items: Array<{ insertText: string }>;
      from: number;
      seq: number;
    };
    assert.strictEqual(
      response.type,
      MESSAGE_TYPES.SCRIPT_COMPLETIONS_RESPONSE
    );
    assert.strictEqual(response.from, 0);
    assert.strictEqual(response.seq, 101);
    assert.ok(response.items.some((item) => item.insertText === "git status"));
  });

  test("emits empty script items when the completion source fails", async () => {
    const emitted: unknown[] = [];
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      vscode.workspace,
      "workspaceFolders"
    );
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      get: () => {
        throw new Error("workspace lookup failed");
      },
    });

    try {
      const service = new PromptEditorSupportService(
        () => workspaceRoot,
        () => undefined,
        () => undefined
      );
      await service.handleScriptCompletionRequest(
        createWebviewClientContext("test-client", (message) => {
          emitted.push(message);
        }),
        "npm ",
        4,
        102
      );
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          vscode.workspace,
          "workspaceFolders",
          originalDescriptor
        );
      }
    }

    const response = emitted[0] as {
      type: string;
      items: unknown[];
      from: number;
      seq: number;
    };
    assert.strictEqual(
      response.type,
      MESSAGE_TYPES.SCRIPT_COMPLETIONS_RESPONSE
    );
    assert.deepStrictEqual(response.items, []);
    assert.strictEqual(response.from, 4);
    assert.strictEqual(response.seq, 102);
  });
});
