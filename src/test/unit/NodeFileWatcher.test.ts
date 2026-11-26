import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, setup, teardown, test } from "mocha";
import { watch, type FSWatcher } from "chokidar";
import {
  NodeFileWatcherFactory,
  type ChokidarWatch,
} from "../../platform/NodeFileWatcher";
import { LogLevel } from "../../utils/Log";
import {
  registerFileWatcherContractTests,
  waitForPathEvent,
  withWatcher,
} from "../helpers/fileWatcherContract";
import { captureLog } from "../helpers/logCapture";

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

registerFileWatcherContractTests(
  "Node file watcher",
  new NodeFileWatcherFactory()
);

suite("Node file watcher exclusions", () => {
  test("does not watch node_modules", async () => {
    await withWatcher(
      new NodeFileWatcherFactory(),
      "**/package.json",
      async (root, watcher) => {
        const ignoredPath = path.join(
          root,
          "node_modules",
          "pkg",
          "package.json"
        );
        await fs.mkdir(path.dirname(ignoredPath), { recursive: true });
        await fs.writeFile(ignoredPath, "{}");
        await assert.rejects(
          waitForPathEvent(
            (listener) => watcher.onDidCreate(listener),
            "create",
            ignoredPath
          ),
          /Timed out waiting for watcher create event/
        );
      }
    );
  });
});

suite("Node file watcher single-file scope", () => {
  test("createForFile does not walk sibling subtrees", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-file-watch-scope-")
    );
    for (let index = 0; index < 5; index += 1) {
      await fs.mkdir(path.join(root, `dir${index}`, "nested"), {
        recursive: true,
      });
    }
    const targetPath = path.join(root, "[id].tsx");
    await fs.writeFile(targetPath, "initial");
    let chokidarWatcher: FSWatcher | undefined;
    const factory = new NodeFileWatcherFactory((paths, options) => {
      chokidarWatcher = watch(paths, options);
      return chokidarWatcher;
    });
    const watcher = factory.createForFile(targetPath);
    try {
      assert.ok(chokidarWatcher);
      await new Promise<void>((resolve) =>
        chokidarWatcher!.once("ready", () => resolve())
      );
      const watchedDirectories = Object.keys(chokidarWatcher.getWatched()).map(
        (directory) => path.resolve(directory)
      );
      assert.ok(
        watchedDirectories.every(
          (directory) => !directory.startsWith(path.join(root, "dir"))
        ),
        `single-file watch walked subdirectories: ${watchedDirectories.join(", ")}`
      );
    } finally {
      watcher.dispose();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

suite("Node file watcher errors", () => {
  let log: ReturnType<typeof captureLog>;
  let chokidarWatchers: FSWatcher[];
  let factory: NodeFileWatcherFactory;

  setup(() => {
    log = captureLog();
    chokidarWatchers = [];
    const capturingWatch: ChokidarWatch = (paths, options) => {
      const chokidarWatcher = watch(paths, options);
      chokidarWatchers.push(chokidarWatcher);
      return chokidarWatcher;
    };
    factory = new NodeFileWatcherFactory(capturingWatch);
  });

  teardown(() => {
    log.restore();
  });

  const watcherLines = () =>
    log.lines.filter((line) => line.message.includes("[NodeFileWatcher]"));

  test("logs a watch error instead of throwing, and keeps watching", async () => {
    await withWatcher(factory, "*.json", async (root, watcher) => {
      assert.strictEqual(chokidarWatchers.length, 1);
      const [chokidarWatcher] = chokidarWatchers;

      assert.doesNotThrow(() =>
        chokidarWatcher.emit(
          "error",
          errnoError("EACCES", "permission denied, scandir 'locked'")
        )
      );

      const lines = watcherLines();
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].level, LogLevel.WARN);
      assert.match(lines[0].message, /EACCES/);
      assert.match(lines[0].message, /permission denied/);
      assert.ok(lines[0].message.includes('"*.json"'));

      const filePath = path.join(root, "after-error.json");
      const created = waitForPathEvent(
        (listener) => watcher.onDidCreate(listener),
        "create",
        filePath
      );
      await fs.writeFile(filePath, "{}");
      await created;
    });
  });

  test("warns once per error code and demotes repeats to debug", async () => {
    await withWatcher(factory, "*.json", async () => {
      const [chokidarWatcher] = chokidarWatchers;
      chokidarWatcher.emit(
        "error",
        errnoError("EMFILE", "too many open files")
      );
      chokidarWatcher.emit(
        "error",
        errnoError("EMFILE", "too many open files")
      );
      chokidarWatcher.emit(
        "error",
        errnoError("EPERM", "operation not permitted")
      );
      chokidarWatcher.emit("error", new Error("no code"));

      assert.deepStrictEqual(
        watcherLines().map((line) => [
          line.level,
          /\((\w+)\)/.exec(line.message)?.[1],
        ]),
        [
          [LogLevel.WARN, "EMFILE"],
          [LogLevel.DEBUG, "EMFILE"],
          [LogLevel.WARN, "EPERM"],
          [LogLevel.WARN, "unknown"],
        ]
      );
    });
  });
});
