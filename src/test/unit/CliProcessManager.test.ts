import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import {
  CliProcessManager,
  killLiveProcessGroupsOnExit,
} from "../../utils/CliProcessManager";
import { PROCESS_SIGNALS } from "../../types/DashboardConstants";
import { canonicalizeDriveLetter } from "../../utils/PathCasing";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

const REPLACEMENT_CHARACTER = "�";

/**
 * Runs a tiny Node program and returns everything the manager saw. The child
 * writes raw bytes with a gap between writes so the two halves of a multi-byte
 * sequence arrive as separate stdout chunks — the condition that used to
 * corrupt them, back when each chunk was decoded in isolation.
 */
async function spawnByteWriter(script: string): Promise<{
  stdout: string;
  streamed: string[];
}> {
  const manager = new CliProcessManager(process.cwd());
  const streamed: string[] = [];
  const result = await manager.spawn(process.execPath, ["-e", script], {
    onStdout: (chunk) => streamed.push(chunk),
  });

  assert.strictEqual(result.exitCode, 0);
  return { stdout: result.stdout, streamed };
}

suite("CliProcessManager stream decoding", () => {
  test("preserves a multi-byte character split across stdout chunks", async () => {
    const { stdout, streamed } = await spawnByteWriter(
      [
        "process.stdout.write(Buffer.from([0xf0, 0x9f]));",
        "setTimeout(() => process.stdout.write(Buffer.from([0x98, 0x80])), 50);",
      ].join("")
    );

    assert.strictEqual(stdout, "😀");
    assert.strictEqual(streamed.join(""), "😀");
    assert.ok(
      !streamed.some((chunk) => chunk.includes(REPLACEMENT_CHARACTER)),
      `a streamed chunk carried a replacement character: ${JSON.stringify(streamed)}`
    );
  });

  test("flushes an incomplete trailing sequence at process exit", async () => {
    // The decoder holds these two bytes back waiting for the rest of the
    // character, which never comes. Without the explicit flush on close they
    // would be dropped from both the stream and the accumulated output.
    const { stdout, streamed } = await spawnByteWriter(
      "process.stdout.write(Buffer.from([0x61, 0xf0, 0x9f]));"
    );

    assert.strictEqual(stdout, `a${REPLACEMENT_CHARACTER}`);
    assert.strictEqual(streamed.join(""), `a${REPLACEMENT_CHARACTER}`);
  });
});

suite("CliProcessManager stdin", () => {
  const echoStdin =
    "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(s)))";

  test("writes stdinText verbatim and closes stdin", async () => {
    // The prompt OpenCode receives this way must be byte-for-byte what was
    // sent: quotes, spaces in paths and non-ASCII included.
    const text = 'see "C:\\Users\\Jane Doe\\x.prompt.md" — ok\n';
    const manager = new CliProcessManager(process.cwd());
    const result = await manager.spawn(process.execPath, ["-e", echoStdin], {
      stdinText: text,
    });

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(JSON.parse(result.stdout), text);
  });

  test("keeps stdin open for writes from the caller", async () => {
    const manager = new CliProcessManager(process.cwd());
    let writerReady!: import("stream").Writable;
    const result = await manager.spawn(process.execPath, ["-e", echoStdin], {
      onStdinReady: (writer) => {
        writerReady = writer;
        writer.write("first ");
        setTimeout(() => {
          writer.write("second");
          writer.end();
        }, 10);
      },
    });

    assert.ok(writerReady);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(JSON.parse(result.stdout), "first second");
  });

  test("leaves stdin ignored without stdinText", async () => {
    const manager = new CliProcessManager(process.cwd());
    const result = await manager.spawn(process.execPath, ["-e", echoStdin]);

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(JSON.parse(result.stdout), "");
  });

  test("survives a child that exits without reading stdin", async () => {
    const manager = new CliProcessManager(process.cwd());
    const result = await manager.spawn(
      process.execPath,
      ["-e", "process.exit(3)"],
      { stdinText: "x".repeat(4 * 1024 * 1024) }
    );

    assert.strictEqual(result.exitCode, 3);
  });
});

suite("CliProcessManager working directory", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = makeTempDir("cy-cli-pwd-");
  });

  teardown(() => {
    removeTempDir(tmpDir);
  });

  test("points the child's PWD at its cwd, not the parent's stale PWD", async () => {
    // OpenCode resolves its project from PWD, so a stale value inherited from
    // the parent made it run against the wrong directory tree.
    const manager = new CliProcessManager(process.cwd());
    const result = await manager.spawn(
      process.execPath,
      ["-e", "process.stdout.write(process.env.PWD ?? '')"],
      {
        cwd: tmpDir,
        env: { ...process.env, PWD: path.join(tmpDir, "stale-parent-dir") },
      }
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, canonicalizeDriveLetter(tmpDir));
  });
});

suite("CliProcessManager teardown", () => {
  test("exit hook kills live group leaders and forgets closed ones", async function () {
    if (process.platform === "win32") this.skip();

    const killedPids: number[] = [];
    const manager = new CliProcessManager(
      process.cwd(),
      undefined,
      undefined,
      (pid, signal) => {
        assert.strictEqual(signal, PROCESS_SIGNALS.KILL);
        killedPids.push(pid);
      }
    );
    const closed = await manager.spawn(process.execPath, [
      "-e",
      "process.exit(0)",
    ]);
    assert.strictEqual(closed.exitCode, 0);

    const livePromise = manager.spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    killLiveProcessGroupsOnExit();

    assert.strictEqual(killedPids.length, 1);
    assert.ok(killedPids[0] < 0, "exit hook should signal a process group");
    await manager.cancel();
    await livePromise;
  });

  test("disposeAsync waits for SIGTERM to escalate and the child to close", async () => {
    const signals: NodeJS.Signals[] = [];
    const manager = new CliProcessManager(
      process.cwd(),
      undefined,
      (pid, signal, callback) => {
        signals.push(signal as NodeJS.Signals);
        if (signal === PROCESS_SIGNALS.KILL) {
          try {
            process.kill(pid, PROCESS_SIGNALS.KILL);
          } catch {
            // The child may have exited between the escalation check and kill.
          }
        }
        callback?.();
      }
    );
    const resultPromise = manager.spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await manager.disposeAsync();
    const result = await resultPromise;
    assert.deepStrictEqual(signals, [
      PROCESS_SIGNALS.TERMINATE,
      PROCESS_SIGNALS.KILL,
    ]);
    assert.strictEqual(result.terminationSignal, PROCESS_SIGNALS.KILL);
  });

  test("disposeProcess sends SIGTERM first", async () => {
    const signals: NodeJS.Signals[] = [];
    const manager = new CliProcessManager(
      process.cwd(),
      undefined,
      (pid, signal, callback) => {
        signals.push(signal as NodeJS.Signals);
        try {
          process.kill(pid, signal as NodeJS.Signals);
          callback?.();
        } catch (error) {
          callback?.(error as Error);
        }
      }
    );
    const resultPromise = manager.spawn(process.execPath, [
      "-e",
      "setTimeout(() => {}, 10000)",
    ]);

    await new Promise((resolve) => setTimeout(resolve, 100));
    manager.disposeProcess();
    const result = await resultPromise;

    assert.deepStrictEqual(signals, [PROCESS_SIGNALS.TERMINATE]);
    assert.strictEqual(result.terminatedByManager, true);
    assert.strictEqual(result.terminationSignal, PROCESS_SIGNALS.TERMINATE);
  });

  test("disposeProcess terminates an interactive child with the default kill path", async () => {
    // spawnInteractive children are not detached, so they share this process
    // group; a `-pid` group kill would fail with ESRCH and leave them running.
    const manager = new CliProcessManager(process.cwd());
    const exit = manager.spawnInteractive(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      process.cwd()
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    const started = Date.now();
    manager.disposeProcess();
    const result = await exit;

    assert.strictEqual(result.terminatedByManager, true);
    assert.ok(
      Date.now() - started < 2000,
      "SIGTERM should end the child before SIGKILL escalation"
    );
  });

  test("escalates a timed-out child after another child becomes current", async () => {
    const killCalls: Array<{ pid: number; signal: string | number }> = [];
    const manager = new CliProcessManager(
      process.cwd(),
      undefined,
      (pid, signal, callback) => {
        killCalls.push({ pid, signal: signal ?? "" });
        if (signal === PROCESS_SIGNALS.KILL) {
          try {
            process.kill(pid, PROCESS_SIGNALS.KILL);
          } catch {
            // The child may have exited between the manager's check and kill.
          }
        }
        callback?.();
      }
    );

    const unresponsiveScript =
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    const timedOutChild = manager.spawn(
      process.execPath,
      ["-e", unresponsiveScript],
      {
        timeout: 200,
      }
    );
    await assert.rejects(timedOutChild, /Process timeout/);
    const nextChild = manager.spawn(process.execPath, [
      "-e",
      unresponsiveScript,
    ]);

    try {
      await new Promise((resolve) => setTimeout(resolve, 3500));
      const firstPid = killCalls.find(
        (call) => call.signal === PROCESS_SIGNALS.TERMINATE
      )?.pid;
      assert.ok(firstPid, "timed-out child should have received SIGTERM");
      assert.ok(
        killCalls.some(
          (call) =>
            call.pid === firstPid && call.signal === PROCESS_SIGNALS.KILL
        ),
        "timed-out child should receive SIGKILL after the escalation delay"
      );
    } finally {
      await manager.cancel();
      await nextChild;
    }
  });

  test("closing one child does not clear another child's escalation timer", async () => {
    const killCalls: Array<{ pid: number; signal: string | number }> = [];
    const manager = new CliProcessManager(
      process.cwd(),
      undefined,
      (pid, signal, callback) => {
        killCalls.push({ pid, signal: signal ?? "" });
        if (signal === PROCESS_SIGNALS.KILL) {
          try {
            process.kill(pid, PROCESS_SIGNALS.KILL);
          } catch {
            // The child may have exited between the manager's check and kill.
          }
        }
        callback?.();
      }
    );

    const unresponsiveScript =
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    const firstChild = manager.spawn(
      process.execPath,
      ["-e", unresponsiveScript],
      {
        timeout: 200,
      }
    );
    await assert.rejects(firstChild, /Process timeout/);
    const secondChild = manager.spawn(
      process.execPath,
      ["-e", unresponsiveScript],
      {
        timeout: 200,
      }
    );
    await assert.rejects(secondChild, /Process timeout/);

    await new Promise((resolve) => setTimeout(resolve, 3500));
    const termPids = killCalls
      .filter((call) => call.signal === PROCESS_SIGNALS.TERMINATE)
      .map((call) => call.pid);
    const killPids = killCalls
      .filter((call) => call.signal === PROCESS_SIGNALS.KILL)
      .map((call) => call.pid);

    assert.strictEqual(
      termPids.length,
      2,
      "both children should receive SIGTERM"
    );
    assert.ok(
      termPids.every((pid) => killPids.includes(pid)),
      "closing the first child should not cancel the second child's SIGKILL"
    );
  });

  test("escalates a shell descendant after the shell exits on SIGTERM", async function () {
    if (process.platform === "win32") this.skip();

    const markerPath = path.join(makeTempDir("cy-cli-descendant-"), "survived");
    const manager = new CliProcessManager(process.cwd());
    const script = [
      "process.on('SIGTERM', () => {});",
      `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'alive'), 4500);`,
      "setInterval(() => {}, 1000);",
    ].join(" ");

    try {
      await assert.rejects(
        manager.spawn(
          "bash",
          ["-c", `node -e ${JSON.stringify(script)}; wait`],
          { timeout: 500 }
        ),
        /Process timeout/
      );
      await new Promise((resolve) => setTimeout(resolve, 4800));
      assert.ok(!fs.existsSync(markerPath), "descendant should be SIGKILLed");
    } finally {
      fs.rmSync(path.dirname(markerPath), { recursive: true, force: true });
      await manager.cancel();
    }
  });
});
