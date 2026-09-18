import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import type { FileWatcher, FileWatcherFactory } from "../../core/HostPorts";
import { pathsEqual } from "../../utils/PathCasing";

const EVENT_TIMEOUT_MS = 5_000;

export interface FileWatcherContractDriver {
  factory: FileWatcherFactory;
  emitCreate(filePath: string): Promise<void>;
  emitChange(filePath: string): Promise<void>;
  emitDelete(filePath: string): Promise<void>;
  dispose(): void;
}

function waitForPathEvent(
  eventName: string,
  register: (listener: (filePath: string) => void) => void,
  expectedPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for watcher ${eventName} event for ${expectedPath}`
        )
      );
    }, EVENT_TIMEOUT_MS);

    register((filePath) => {
      if (!pathsEqual(filePath, expectedPath)) return;
      clearTimeout(timeout);
      resolve();
    });
  });
}

export function registerFileWatcherContractTests(
  name: string,
  createDriver: (root: string) => FileWatcherContractDriver
): void {
  suite(name, () => {
    test("normalizes and routes create, change, and delete events", async () => {
      const root = path.resolve(os.tmpdir(), "ctrlyoke-file-watcher-contract");
      const basePath = `${root}${path.sep}nested${path.sep}..`;
      const filePath = path.normalize(path.resolve(root, "workflow.json"));
      const driver = createDriver(root);
      let watcher: FileWatcher | undefined;

      try {
        watcher = driver.factory.create(basePath, "*.json");
        const createEvent = waitForPathEvent(
          "create",
          (listener) => {
            watcher?.onDidCreate(listener);
          },
          filePath
        );
        const changeEvent = waitForPathEvent(
          "change",
          (listener) => {
            watcher?.onDidChange(listener);
          },
          filePath
        );
        const deleteEvent = waitForPathEvent(
          "delete",
          (listener) => {
            watcher?.onDidDelete(listener);
          },
          filePath
        );

        await driver.emitCreate(filePath);
        await createEvent;
        await driver.emitChange(filePath);
        await changeEvent;
        await driver.emitDelete(filePath);
        await deleteEvent;

        assert.ok(path.isAbsolute(filePath));
      } finally {
        watcher?.dispose();
        driver.dispose();
      }
    });

    test("disposes event subscriptions and the underlying watcher", async () => {
      const root = path.resolve(os.tmpdir(), "ctrlyoke-file-watcher-dispose");
      const filePath = path.join(root, "after-dispose.json");
      const driver = createDriver(root);
      let watcher: FileWatcher | undefined;
      let eventCount = 0;

      try {
        watcher = driver.factory.create(root, "*.json");
        watcher.onDidCreate(() => {
          eventCount += 1;
        });
        watcher.dispose();
        await driver.emitCreate(filePath);
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.strictEqual(eventCount, 0);
      } finally {
        watcher?.dispose();
        driver.dispose();
      }
    });
  });
}
