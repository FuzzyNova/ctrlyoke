import * as assert from "assert";
import { suite, test } from "mocha";
import { handleCliError } from "../../cli/CliExitCode";

suite("CLI error output contract baseline", () => {
  test("unexpected errors use the current text prefix and usage exit code", () => {
    const stderr: string[] = [];
    const exits: number[] = [];
    handleCliError(
      new Error("baseline failure"),
      (message) => stderr.push(message),
      (code) => exits.push(code)
    );

    assert.deepStrictEqual(stderr, ["Error: baseline failure"]);
    assert.deepStrictEqual(exits, [2]);
  });

  test("non-Error values retain the existing fallback message", () => {
    const stderr: string[] = [];
    const exits: number[] = [];
    handleCliError("baseline failure", (message) => stderr.push(message), (code) => exits.push(code));

    assert.deepStrictEqual(stderr, ["Error: baseline failure"]);
    assert.deepStrictEqual(exits, [2]);
  });
});
