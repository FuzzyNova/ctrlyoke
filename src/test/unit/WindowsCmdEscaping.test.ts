import * as assert from "assert";
import { suite, test } from "mocha";
import {
  buildCmdExeVerbatimArgs,
  escapeCmdArgument,
  escapeCmdMetaChars,
} from "../../core/harness/shared/WindowsCmdEscaping";

suite("WindowsCmdEscaping", () => {
  test("escapes cmd.exe redirection metacharacters with a caret", () => {
    assert.strictEqual(
      escapeCmdMetaChars("<session-flags>"),
      "^<session-flags^>"
    );
  });

  test("leaves plain text untouched", () => {
    assert.strictEqual(escapeCmdMetaChars("hooks.Stop"), "hooks.Stop");
  });

  test("escapeCmdArgument quotes and caret-escapes metachars, including embedded quotes", () => {
    const arg =
      'hooks.state={ "C:\\<session-flags>\\config.toml:stop:0:0" = 1 }';
    const escaped = escapeCmdArgument(arg, false);

    // Must not contain a bare, un-caret-escaped '<' or '>' — that is exactly
    // what cmd.exe reinterprets as redirection (the reported bug).
    assert.ok(
      !/(?<!\^)[<>]/.test(escaped),
      `unescaped metachar survived: ${escaped}`
    );
    assert.ok(escaped.includes("^<session-flags^>"));
    // Embedded double quotes must be backslash-escaped for the CRT-style
    // argv parser the target program (node.exe) will eventually apply.
    assert.ok(escaped.includes('\\^"'));
  });

  test("doubles caret-escaping for shims under node_modules/.bin", () => {
    const shimPath = "C:\\repo\\node_modules\\.bin\\tool.cmd";
    const args = buildCmdExeVerbatimArgs(shimPath, ["<x>"]);
    const payload = args.join(" ");

    // Single escaping (^<) would still be visible as a literal caret in the
    // once-more-reinterpreted string; doubled escaping survives the shim's
    // own internal cmd.exe re-invocation.
    assert.ok(payload.includes("^^^<x^^^>"), payload);
  });

  test("does not double-escape a plain (non node_modules/.bin) shim", () => {
    const shimPath = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";
    const args = buildCmdExeVerbatimArgs(shimPath, ["<x>"]);
    const payload = args.join(" ");

    assert.ok(payload.includes("^<x^>"), payload);
    assert.ok(!payload.includes("^^<"), payload);
  });

  test("builds a /d /s /c payload wrapping the whole escaped command line in one outer quote pair", () => {
    const args = buildCmdExeVerbatimArgs("C:\\npm\\codex.cmd", [
      "--model",
      "gpt-5.6-sol",
    ]);

    assert.deepStrictEqual(args.slice(0, 3), ["/d", "/s", "/c"]);
    const payload = args[3];
    assert.ok(payload.startsWith('"'));
    assert.ok(payload.endsWith('"'));
  });

  test("regression: the exact Codex inline-hooks trust-key shape that broke cmd.exe", () => {
    // Reproduces the argument from the reported failure: a `-c hooks.state=...`
    // override whose synthetic key source is Codex's own literal
    // "C:\<session-flags>\config.toml" constant. This must reach node.exe
    // byte-for-byte, and must never expose a bare '<' or '>' to cmd.exe.
    const trustArg =
      'hooks.state={ "C:\\\\<session-flags>\\\\config.toml:session_start:0:0" = { "trusted_hash" = "sha256:abc" } }';
    const args = buildCmdExeVerbatimArgs(
      "C:\\Users\\natha\\AppData\\Roaming\\npm\\codex.cmd",
      ["-c", trustArg]
    );
    const payload = args.join(" ");

    assert.ok(
      !/(?<!\^)[<>]/.test(payload),
      `unescaped metachar survived: ${payload}`
    );
  });
});
