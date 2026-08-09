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
});
