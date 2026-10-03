import * as assert from "assert";
import { EventEmitter } from "events";
import { suite, test } from "mocha";
import {
  CLI_CLOSED_PIPE_EXIT_CODE,
  exitQuietlyOnClosedPipe,
  isClosedPipeError,
} from "../../cli/CliClosedPipe";

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code });
}

suite("CliClosedPipe", () => {
  test("exits with the closed-pipe status when the reader goes away", () => {
    const stream = new EventEmitter();
    const exits: number[] = [];
    exitQuietlyOnClosedPipe(stream, (code) => exits.push(code));
    stream.emit("error", errnoError("EPIPE"));
    assert.deepStrictEqual(exits, [CLI_CLOSED_PIPE_EXIT_CODE]);
    assert.strictEqual(CLI_CLOSED_PIPE_EXIT_CODE, 0);
  });

  test("installs one listener per stream and rethrows other stream errors", () => {
    const stream = new EventEmitter();
    const exits: number[] = [];
    exitQuietlyOnClosedPipe(stream, (code) => exits.push(code));
    exitQuietlyOnClosedPipe(stream, (code) => exits.push(code));
    assert.strictEqual(stream.listenerCount("error"), 1);
    assert.throws(() => stream.emit("error", errnoError("EIO")), /write EIO/);
    assert.deepStrictEqual(exits, []);
  });

  test("recognizes only EPIPE as a closed pipe", () => {
    assert.strictEqual(isClosedPipeError(errnoError("EPIPE")), true);
    assert.strictEqual(isClosedPipeError(errnoError("ENOENT")), false);
    assert.strictEqual(isClosedPipeError(undefined), false);
    assert.strictEqual(isClosedPipeError("EPIPE"), false);
  });
});
