import * as assert from "assert";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { suite, test } from "mocha";
import { GitCommitter } from "../../git/GitCommitter";

suite("GitCommitter", () => {
  test("does not buffer large git stderr output on a successful commit", async () => {
    const commands: string[][] = [];
    const committer = new GitCommitter({
      spawnProcess: (_command, args, options) => {
        commands.push(args);
        assert.deepStrictEqual(options.stdio, ["ignore", "ignore", "pipe"]);
        const child = new EventEmitter() as EventEmitter & {
          stderr: PassThrough;
        };
        child.stderr = new PassThrough();
        queueMicrotask(() => {
          child.stderr.write(Buffer.alloc(1024 * 1024 + 1, "x"));
          child.emit("close", 0);
        });
        return child as never;
      },
    });

    await committer.commit("large commit", process.cwd());
    assert.deepStrictEqual(commands, [["commit", "-m", "large commit"]]);
  });
});
