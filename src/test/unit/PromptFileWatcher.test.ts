import * as assert from "assert";
import * as path from "path";
import { suite, test } from "mocha";
import { PromptFileWatcher } from "../../core/orchestration/PromptFileWatcher";
import type { PromptQueue } from "../../core/PromptQueue";
import type { FileWatcher, FileWatcherFactory } from "../../core/HostPorts";
import { EXECUTION_STATES } from "../../types/DashboardConstants";

class TestFileWatcher implements FileWatcher {
  private changeListener?: (filePath: string) => void;

  onDidCreate(): { dispose(): void } {
    return { dispose() {} };
  }

  onDidChange(listener: (filePath: string) => void): { dispose(): void } {
    this.changeListener = listener;
    return { dispose: () => (this.changeListener = undefined) };
  }

  onDidDelete(): { dispose(): void } {
    return { dispose() {} };
  }

  dispose(): void {
    this.changeListener = undefined;
  }

  async change(filePath: string): Promise<void> {
    this.changeListener?.(filePath);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

suite("PromptFileWatcher", () => {
  test("reloads MCP appends while an execution is pausing", async () => {
    const workingFilePath = path.join(path.sep, "workspace", "working.json");
    const fileWatcher = new TestFileWatcher();
    const factory: FileWatcherFactory = {
      create: () => fileWatcher,
    };
    const queue = {
      getState: () => ({
        status: EXECUTION_STATES.PAUSING,
        workingFilePath,
      }),
      onDidChangeState: () => ({ dispose() {} }),
    } as unknown as PromptQueue;
    const watcher = new PromptFileWatcher(queue, undefined, factory, () => [
      path.dirname(workingFilePath),
    ]);
    const reloaded: string[] = [];
    watcher.setupFileWatcher(
      workingFilePath,
      async (filePath) => {
        reloaded.push(filePath);
      },
      () => undefined
    );

    try {
      await fileWatcher.change(workingFilePath);
      assert.deepStrictEqual(reloaded, [workingFilePath]);
    } finally {
      watcher.dispose();
    }
  });
});
