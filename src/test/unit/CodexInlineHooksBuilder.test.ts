import * as assert from "assert";
import {
  buildCodexInlineHooks,
  canonicalizeJson,
  CODEX_INLINE_HOOK_COMMAND_LINE_BUDGET,
  computeCodexTrustedHash,
  CODEX_INLINE_HOOK_SOURCE_PATH,
  getCodexInlineHookSourcePath,
  getCodexEventKeyLabel,
} from "../../core/harness/codex/CodexInlineHooksBuilder";

function commandHook(command: string): Record<string, string> {
  return { type: "command", command };
}

function trustEntryContains(
  trustArgs: string[],
  event: string,
  groupIndex: number,
  handlerIndex: number,
  hash: string
): boolean {
  const key = `${CODEX_INLINE_HOOK_SOURCE_PATH}:${getCodexEventKeyLabel(event)}:${groupIndex}:${handlerIndex}`;
  return trustArgs[1].includes(
    `${JSON.stringify(key)} = { "trusted_hash" = ${JSON.stringify(hash)} }`
  );
}

suite("CodexInlineHooksBuilder", () => {
  test("emits one inline override per event in deterministic order", () => {
    const result = buildCodexInlineHooks({
      Stop: [
        {
          matcher: "ignored for Stop",
          hooks: [commandHook("stop.js")],
        },
      ],
      SessionStart: [
        {
          matcher: "^start$",
          hooks: [commandHook("start.js")],
        },
      ],
      PreToolUse: [
        {
          matcher: "^Bash$",
          hooks: [commandHook("pre.js")],
        },
      ],
    });

    assert.deepStrictEqual(result.hookArgs, [
      "-c",
      'hooks.PreToolUse=[{ "hooks" = [{ "command" = "pre.js", "type" = "command" }], "matcher" = "^Bash$" }]',
      "-c",
      'hooks.SessionStart=[{ "hooks" = [{ "command" = "start.js", "type" = "command" }], "matcher" = "^start$" }]',
      "-c",
      'hooks.Stop=[{ "hooks" = [{ "command" = "stop.js", "type" = "command" }], "matcher" = "ignored for Stop" }]',
    ]);
  });

  test("builds trust keys for every emitted event and handler", () => {
    const hooks = {
      Stop: [{ hooks: [commandHook("stop.js")] }],
      SessionStart: [{ matcher: "^start$", hooks: [commandHook("start.js")] }],
      PreToolUse: [
        {
          matcher: "^Bash$",
          hooks: [commandHook("pre-0.js"), commandHook("pre-1.js")],
        },
      ],
      PostToolUse: [{ matcher: "^Bash$", hooks: [commandHook("post.js")] }],
      UserPromptSubmit: [
        { matcher: "ignored", hooks: [commandHook("prompt.js")] },
      ],
      PermissionRequest: [
        { matcher: "^Bash$", hooks: [commandHook("permission.js")] },
      ],
    };

    const result = buildCodexInlineHooks(hooks);

    assert.strictEqual(result.trustArgs[0], "-c");
    for (const [event, groupIndex, handlerIndex] of [
      ["Stop", 0, 0],
      ["SessionStart", 0, 0],
      ["PreToolUse", 0, 0],
      ["PreToolUse", 0, 1],
      ["PostToolUse", 0, 0],
      ["UserPromptSubmit", 0, 0],
      ["PermissionRequest", 0, 0],
    ] as const) {
      const key = `${CODEX_INLINE_HOOK_SOURCE_PATH}:${getCodexEventKeyLabel(event)}:${groupIndex}:${handlerIndex}`;
      assert.ok(result.trustArgs[1].includes(`${JSON.stringify(key)} = {`));
    }

    assert.ok(
      trustEntryContains(
        result.trustArgs,
        "Stop",
        0,
        0,
        computeCodexTrustedHash("Stop", undefined, "stop.js", 600)
      )
    );
    assert.ok(
      trustEntryContains(
        result.trustArgs,
        "UserPromptSubmit",
        0,
        0,
        computeCodexTrustedHash("UserPromptSubmit", undefined, "prompt.js", 600)
      )
    );
    assert.ok(
      trustEntryContains(
        result.trustArgs,
        "PreToolUse",
        0,
        1,
        computeCodexTrustedHash("PreToolUse", "^Bash$", "pre-1.js", 600)
      )
    );
    assert.ok(
      trustEntryContains(
        result.trustArgs,
        "SessionStart",
        0,
        0,
        computeCodexTrustedHash("SessionStart", "^start$", "start.js", 600)
      )
    );
  });

  test("asserts when an emitted handler has no trust key", () => {
    assert.throws(
      () =>
        buildCodexInlineHooks({
          Stop: [
            {
              hooks: [{ type: "unsupported", command: "stop.js" }],
            },
          ],
        }),
      /emitted 1 handlers but computed 0 trust keys/
    );
  });

  test("uses the platform-specific synthetic key source", () => {
    assert.strictEqual(
      getCodexInlineHookSourcePath("win32"),
      String.raw`C:\<session-flags>\config.toml`
    );
    assert.strictEqual(
      getCodexInlineHookSourcePath("linux"),
      "/<session-flags>/config.toml"
    );

    const result = buildCodexInlineHooks(
      { Stop: [{ hooks: [commandHook("stop.js")] }] },
      { platform: "linux" }
    );
    assert.ok(
      result.trustArgs[1].includes(
        '"/<session-flags>/config.toml:stop:0:0" = {'
      )
    );
  });

  test("rejects inline hooks that exceed the command-line safety budget", () => {
    assert.ok(CODEX_INLINE_HOOK_COMMAND_LINE_BUDGET < 32_767);
    assert.throws(
      () =>
        buildCodexInlineHooks(
          { Stop: [{ hooks: [commandHook("x".repeat(200))] }] },
          { maxCommandLineLength: 100 }
        ),
      /exceeding the 100-byte safety budget.*Reduce the number or length of Codex hooks/
    );
  });

  test("keeps the pinned Codex stop hash vector stable", () => {
    assert.strictEqual(
      computeCodexTrustedHash("Stop", undefined, "node notify.js", 600),
      "sha256:0ebcbdd8847fe1a96312a63a510310024b16d5ff7ea1d379bcdf158651310ba7"
    );
  });

  test("canonicalizes object keys in UTF-8 byte order", () => {
    const canonical = canonicalizeJson({ ä: 3, a: 2, Z: 1 }) as Record<
      string,
      unknown
    >;

    assert.deepStrictEqual(Object.keys(canonical), ["Z", "a", "ä"]);
  });
});
