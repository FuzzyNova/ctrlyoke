import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import type {
  Disposable,
  FileWatcher,
  FileWatcherFactory,
} from "../../core/HostPorts";
import { writeFileAtomic } from "../../utils/AtomicFileUtils";
import { pathsEqual } from "../../utils/PathCasing";

const EVENT_TIMEOUT_MS = 5_000;

export function waitForPathEvent(
  register: (listener: (filePath: string) => void) => Disposable,
  eventName: "create" | "change" | "delete",
  expectedPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(
        new Error(
          `Timed out waiting for watcher ${eventName} event for ${expectedPath}`
        )
      );
    }, EVENT_TIMEOUT_MS);
    const handler = (filePath: string): void => {
      if (!pathsEqual(filePath, expectedPath)) return;
      clearTimeout(timeout);
      subscription.dispose();
      resolve();
    };
    const subscription = register(handler);
  });
}

function waitForAnyCreateOrChange(
  watcher: FileWatcher,
  expectedPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      createSubscription.dispose();
      changeSubscription.dispose();
      reject(
        new Error(`Timed out waiting for atomic write of ${expectedPath}`)
      );
    }, EVENT_TIMEOUT_MS);
    const receive = (filePath: string) => {
      if (!pathsEqual(filePath, expectedPath)) return;
      clearTimeout(timeout);
      createSubscription.dispose();
      changeSubscription.dispose();
      resolve();
    };
    const createSubscription = watcher.onDidCreate(receive);
    const changeSubscription = watcher.onDidChange(receive);
  });
}

export async function withWatcher(
  factory: FileWatcherFactory,
  glob: string,
  run: (root: string, watcher: FileWatcher) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-file-watch-"));
  const watcher = factory.create(root, glob);
  try {
    // Give native and VS Code watcher backends time to attach before mutations.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await run(root, watcher);
  } finally {
    watcher.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rm(root, { recursive: true, force: true });
  }
}

export function registerFileWatcherContractTests(
  name: string,
  factory: FileWatcherFactory
): void {
  suite(name, () => {
    test("reports create, change, and delete with absolute paths", async () => {
      await withWatcher(factory, "*.json", async (root, watcher) => {
        const filePath = path.join(root, "workflow.json");
        const create = waitForPathEvent(
          (listener) => watcher.onDidCreate(listener),
          "create",
          filePath
        );
        await fs.writeFile(filePath, "first");
        await create;

        const change = waitForPathEvent(
          (listener) => watcher.onDidChange(listener),
          "change",
          filePath
        );
        await fs.appendFile(filePath, " update");
        await change;

        const remove = waitForPathEvent(
          (listener) => watcher.onDidDelete(listener),
          "delete",
          filePath
        );
        await fs.unlink(filePath);
        await remove;
        assert.ok(path.isAbsolute(filePath));
      });
    });

    test("reports an atomic temp-file rename on the target, never as delete", async () => {
      await withWatcher(factory, "*.json", async (root, watcher) => {
        const targetPath = path.join(root, "workflow.json");
        let deletes = 0;
        watcher.onDidDelete((filePath) => {
          if (pathsEqual(filePath, targetPath)) deletes += 1;
        });
        const atomicWrite = waitForAnyCreateOrChange(watcher, targetPath);
        await writeFileAtomic(targetPath, "complete contents");
        await atomicWrite;
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.strictEqual(deletes, 0);
        assert.strictEqual(
          await fs.readFile(targetPath, "utf8"),
          "complete contents"
        );
      });
    });

    test("filters events by the base-relative glob", async () => {
      await withWatcher(factory, "*.json", async (root, watcher) => {
        const matchedPath = path.join(root, "included.json");
        const unmatchedPath = path.join(root, "ignored.txt");
        const matched = waitForPathEvent(
          (listener) => watcher.onDidCreate(listener),
          "create",
          matchedPath
        );
        let unmatchedEvents = 0;
        watcher.onDidCreate((filePath) => {
          if (pathsEqual(filePath, unmatchedPath)) unmatchedEvents += 1;
        });
        await fs.writeFile(unmatchedPath, "ignored");
        await fs.writeFile(matchedPath, "included");
        await matched;
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.strictEqual(unmatchedEvents, 0);
      });
    });

    test("a basename watch does not report changes in subdirectories", async () => {
      await withWatcher(factory, "target.json", async (root, watcher) => {
        const nestedPath = path.join(root, "nested", "target.json");
        await fs.mkdir(path.dirname(nestedPath));
        await fs.writeFile(nestedPath, "ignored");
        await assert.rejects(
          waitForPathEvent(
            (listener) => watcher.onDidCreate(listener),
            "create",
            nestedPath
          ),
          /Timed out waiting for watcher create event/
        );
      });
    });

    test("dispose stops create, change, and delete events", async () => {
      await withWatcher(factory, "*.json", async (root, watcher) => {
        let eventCount = 0;
        watcher.onDidCreate(() => (eventCount += 1));
        watcher.onDidChange(() => (eventCount += 1));
        watcher.onDidDelete(() => (eventCount += 1));
        watcher.dispose();
        const filePath = path.join(root, "after-dispose.json");
        await fs.writeFile(filePath, "created");
        await fs.appendFile(filePath, " changed");
        await fs.unlink(filePath);
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.strictEqual(eventCount, 0);
      });
    });
  });
}
