import * as vscode from "vscode";

/**
 * VS Code API properties that are live getters. Tests stub them with
 * `Object.defineProperty`; restoring one as a captured `value` instead of its
 * descriptor (see `snapshotProperty` in `test/helpers/propertySnapshot.ts`)
 * freezes it for every later test file in the shard, which then fails far from
 * the cause.
 */
const LIVE_GETTERS = [
  [vscode.workspace, "workspaceFolders", "vscode.workspace.workspaceFolders"],
  [vscode.workspace, "textDocuments", "vscode.workspace.textDocuments"],
  [vscode.window, "activeTextEditor", "vscode.window.activeTextEditor"],
  [vscode.window, "visibleTextEditors", "vscode.window.visibleTextEditors"],
] as const;

/**
 * Names every live getter that is no longer a getter, or [] when all are
 * intact. Run after each test, it pins a leak on the test that caused it.
 */
export function findFrozenVsCodeGetters(): string[] {
  return LIVE_GETTERS.filter(
    ([target, key]) => !Object.getOwnPropertyDescriptor(target, key)?.get
  ).map(([, , name]) => name);
}

/** Mocha root hooks that fail the test which left a VS Code getter frozen. */
export const vscodeGetterGuardHooks = {
  afterEach(this: Mocha.Context): void {
    const frozen = findFrozenVsCodeGetters();
    if (frozen.length > 0) {
      throw new Error(
        `${this.currentTest?.fullTitle() ?? "This test"} left ${frozen.join(", ")} replaced by a fixed value. Restore stubs with snapshotProperty (test/helpers/propertySnapshot.ts), not by redefining the captured value.`
      );
    }
  },
};
