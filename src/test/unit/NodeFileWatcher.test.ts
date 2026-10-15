import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { suite, test } from "mocha";
import { NodeFileWatcherFactory } from "../../platform/NodeFileWatcher";
import {
  registerFileWatcherContractTests,
  waitForPathEvent,
  withWatcher,
} from "../helpers/fileWatcherContract";

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
