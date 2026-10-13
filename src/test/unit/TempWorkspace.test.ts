import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

suite("removeTempDir", () => {
  test("removes a directory junction without deleting through it", () => {
    const outside = makeTempDir("ctrlyoke-junction-target-");
    const workspace = makeTempDir("ctrlyoke-junction-workspace-");
    try {
      fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
      fs.mkdirSync(path.join(workspace, "node_modules"));
      fs.symlinkSync(
        outside,
        path.join(workspace, "node_modules", "linked"),
        process.platform === "win32" ? "junction" : "dir"
      );

      removeTempDir(workspace);

      assert.strictEqual(fs.existsSync(workspace), false);
      assert.deepStrictEqual(fs.readdirSync(outside), ["keep.txt"]);
    } finally {
      removeTempDir(workspace);
      removeTempDir(outside);
    }
  });
});
