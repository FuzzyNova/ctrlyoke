import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { suite, test, setup, teardown } from "mocha";
import { SecretGrantsTrustStore } from "../../config/SecretGrantsTrustStore";
import { promptBatchApprovalForPendingWorkspaceSecretGrants } from "../../ui/SecretGrantsTrustPrompt";
import type { PromptFile } from "../../types/CtrlYokeTypes";

suite("SecretGrantsTrustPrompt", () => {
  let tempDir: string;
  let store: SecretGrantsTrustStore;
  let originalIsTrusted: boolean;
  let originalShowQuickPick: typeof vscode.window.showQuickPick;
  let originalShowInformationMessage: typeof vscode.window.showInformationMessage;

  setup(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-secret-grants-prompt-")
    );
    store = new SecretGrantsTrustStore(path.join(tempDir, "trust.json"));
    originalIsTrusted = vscode.workspace.isTrusted;
    originalShowQuickPick = vscode.window.showQuickPick;
    originalShowInformationMessage = vscode.window.showInformationMessage;
    Object.defineProperty(vscode.workspace, "isTrusted", {
      configurable: true,
      value: true,
    });
  });

  teardown(() => {
    Object.defineProperty(vscode.workspace, "isTrusted", {
      configurable: true,
      value: originalIsTrusted,
    });
    Object.defineProperty(vscode.window, "showQuickPick", {
      configurable: true,
      value: originalShowQuickPick,
    });
    Object.defineProperty(vscode.window, "showInformationMessage", {
      configurable: true,
      value: originalShowInformationMessage,
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const workflow: PromptFile = {
    steps: [
      { prompt: "deploy", secrets: ["FIRST_TOKEN", "SECOND_TOKEN"] },
      { prompt: "verify", secrets: ["SECOND_TOKEN", "THIRD_TOKEN"] },
    ],
  };

  test("shows all pending names in one picker and persists checked/unchecked decisions", async () => {
    let pickerCalls = 0;
    let shownNames: string[] = [];
    let shownPicked: boolean[] = [];
    let shownOptions: vscode.QuickPickOptions | undefined;
    Object.defineProperty(vscode.window, "showQuickPick", {
      configurable: true,
      value: async (
        items: readonly vscode.QuickPickItem[],
        options?: vscode.QuickPickOptions
      ) => {
        pickerCalls += 1;
        shownNames = items.map((item) => item.label);
        shownPicked = items.map((item) => item.picked ?? false);
        shownOptions = options;
        return [items[0]];
      },
    });
    Object.defineProperty(vscode.window, "showInformationMessage", {
      configurable: true,
      value: async () => undefined,
    });

    await promptBatchApprovalForPendingWorkspaceSecretGrants(
      workflow,
      tempDir,
      store
    );

    assert.strictEqual(pickerCalls, 1);
    assert.deepStrictEqual(shownNames, [
      "FIRST_TOKEN",
      "SECOND_TOKEN",
      "THIRD_TOKEN",
    ]);
    assert.deepStrictEqual(shownPicked, [true, true, true]);
    assert.strictEqual(shownOptions?.canPickMany, true);
    assert.strictEqual(shownOptions?.ignoreFocusOut, true);
    assert.strictEqual(store.getDecision(tempDir, "FIRST_TOKEN"), "allow");
    assert.strictEqual(store.getDecision(tempDir, "SECOND_TOKEN"), "deny");
    assert.strictEqual(store.getDecision(tempDir, "THIRD_TOKEN"), "deny");
  });

  test("leaves every name pending when the picker is dismissed", async () => {
    let pickerCalls = 0;
    Object.defineProperty(vscode.window, "showQuickPick", {
      configurable: true,
      value: async () => {
        pickerCalls += 1;
        return undefined;
      },
    });

    await promptBatchApprovalForPendingWorkspaceSecretGrants(
      workflow,
      tempDir,
      store
    );

    assert.strictEqual(pickerCalls, 1);
    assert.deepStrictEqual(
      store.getPendingGrants(tempDir, [
        "FIRST_TOKEN",
        "SECOND_TOKEN",
        "THIRD_TOKEN",
      ]),
      ["FIRST_TOKEN", "SECOND_TOKEN", "THIRD_TOKEN"]
    );
  });

  test("does not prompt in an untrusted workspace", async () => {
    let pickerCalls = 0;
    Object.defineProperty(vscode.workspace, "isTrusted", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(vscode.window, "showQuickPick", {
      configurable: true,
      value: async () => {
        pickerCalls += 1;
        return undefined;
      },
    });

    await promptBatchApprovalForPendingWorkspaceSecretGrants(
      workflow,
      tempDir,
      store
    );

    assert.strictEqual(pickerCalls, 0);
    assert.deepStrictEqual(
      store.getPendingGrants(tempDir, [
        "FIRST_TOKEN",
        "SECOND_TOKEN",
        "THIRD_TOKEN",
      ]),
      ["FIRST_TOKEN", "SECOND_TOKEN", "THIRD_TOKEN"]
    );
  });
});
