import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { CodexCliProvider } from "../../core/harness/codex/CodexCliProvider";
import { CLI_EVENT_TYPES, HARNESS_IDS } from "../../types/DashboardConstants";
import type {
  CliEvent,
  FileEditData,
  FileWriteData,
  UniversalCliOutput,
} from "../../types/CliOutputTypes";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeWorkflowContext(resumeSession?: boolean): {
  promptIndex: number;
  allPrompts: never[];
  resolvedProperties: { resumeSession?: boolean };
} {
  return {
    promptIndex: 0,
    allPrompts: [],
    resolvedProperties: { resumeSession },
  };
}

// ============================================================================

suite("CodexCliProvider", () => {
  suite("buildCliSuffix", () => {
    const provider = new CodexCliProvider();

    test("returns ['resume', sessionId] when resumeSession=true and sessionId is set", () => {
      const result = provider.buildCliSuffix(
        "thread_abc123",
        makeWorkflowContext(true)
      );
      assert.deepStrictEqual(result, ["resume", "thread_abc123"]);
    });

    test("returns [] when resumeSession=true but sessionId is undefined", () => {
      const result = provider.buildCliSuffix(
        undefined,
        makeWorkflowContext(true)
      );
      assert.deepStrictEqual(result, []);
    });

    test("returns [] when resumeSession=false", () => {
      const result = provider.buildCliSuffix(
        "thread_abc123",
        makeWorkflowContext(false)
      );
      assert.deepStrictEqual(result, []);
    });

    test("returns [] when resumeSession is undefined", () => {
      const result = provider.buildCliSuffix(
        "thread_abc123",
        makeWorkflowContext(undefined)
      );
      assert.deepStrictEqual(result, []);
    });

    test("returns [] when workflowContext is undefined", () => {
      const result = provider.buildCliSuffix("thread_abc123", undefined);
      assert.deepStrictEqual(result, []);
    });
  });

  suite("buildCliArgs resume ordering", () => {
    const provider = new CodexCliProvider();

    test("does not include 'resume' token in buildCliArgs output when resumeSession=true", async () => {
      // The "resume" subcommand must NOT be added by buildCliArgs — it belongs in
      // buildCliSuffix so it appears after all global flags (hooks, permissions).
      const args = await provider.buildCliArgs(
        {} as any,
        true, // interactive
        "/ext",
        "/workspace",
        "thread_abc123",
        makeWorkflowContext(true) as any
      );
      assert.ok(
        !args.includes("resume"),
        `buildCliArgs must not include 'resume' (got: ${JSON.stringify(args)})`
      );
    });

    test("combined arg order puts resume after hook args", () => {
      // Simulate the CliIntegration assembly: baseArgs → hookArgs pushed → suffix appended
      const baseArgs = ["--model", "gpt-5.2-codex", "--add-dir", "/workspace"];
      const hookArgs = ["--enable", "hooks", "-c", "hooks.state={...}"];
      const permissionArgs = ["--approval-policy=auto"];

      baseArgs.push(...hookArgs);
      baseArgs.push(...permissionArgs);

      const suffixArgs = provider.buildCliSuffix(
        "thread_abc123",
        makeWorkflowContext(true)
      );
      baseArgs.push(...suffixArgs);

      const resumeIndex = baseArgs.indexOf("resume");
      const enableIndex = baseArgs.indexOf("--enable");
      const configIndex = baseArgs.indexOf("-c");

      assert.ok(resumeIndex > -1, "resume must be present");
      assert.ok(enableIndex > -1, "--enable must be present");
      assert.ok(configIndex > -1, "-c must be present");

      assert.ok(
        resumeIndex > enableIndex,
        `'resume' (index ${resumeIndex}) must appear after '--enable' (index ${enableIndex})`
      );
      assert.ok(
        resumeIndex > configIndex,
        `'resume' (index ${resumeIndex}) must appear after '-c' (index ${configIndex})`
      );

      // Session ID immediately follows "resume"
      assert.strictEqual(
        baseArgs[resumeIndex + 1],
        "thread_abc123",
        "session ID must immediately follow 'resume'"
      );
    });

    test("interactive resumed command puts global hook trust before resume and prompt after session ID", () => {
      const baseArgs = ["--model", "gpt-5.2-codex", "--add-dir", "/workspace"];
      const hookArgs = ["--enable", "hooks", "-c", "hooks.state={...}"];
      const permissionArgs = ["--approval-policy=auto"];

      baseArgs.push(...hookArgs);
      baseArgs.push(...permissionArgs);
      baseArgs.push(
        ...provider.buildCliSuffix("thread_abc123", makeWorkflowContext(true))
      );

      const result = provider.buildInteractiveArgs(baseArgs, "continue work");

      assert.deepStrictEqual(result, [
        "--model",
        "gpt-5.2-codex",
        "--add-dir",
        "/workspace",
        "--enable",
        "hooks",
        "-c",
        "hooks.state={...}",
        "--approval-policy=auto",
        "resume",
        "thread_abc123",
        "continue work",
      ]);
    });

    test("interactive new-session command puts prompt after global args", () => {
      const result = provider.buildInteractiveArgs(
        ["--model", "gpt-5.2-codex", "--enable", "hooks"],
        "start work"
      );

      assert.deepStrictEqual(result, [
        "--model",
        "gpt-5.2-codex",
        "--enable",
        "hooks",
        "start work",
      ]);
    });
  });

  suite("buildNotificationHookArgs", () => {
    const provider = new CodexCliProvider();

    test("enables hooks with inline trust state and no bypass flag", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "codex-hook-args-")
      );
      const workingFilePath = path.join(workspaceRoot, ".ctrlyoke", "wf.json");

      try {
        const args = await provider.buildNotificationHookArgs(
          "/ext",
          workspaceRoot,
          0,
          workingFilePath,
          undefined,
          []
        );

        assert.deepStrictEqual(args.slice(0, 2), ["--enable", "hooks"]);
        assert.ok(
          !args.includes("--dangerously-bypass-hook-trust"),
          "hook trust bypass should not be emitted when inline trust state is present"
        );
        assert.ok(
          args.includes("-c"),
          "inline hooks.state trust override should remain for compatibility"
        );
      } finally {
        await provider.cleanupWorkspaceArtifacts(
          workspaceRoot,
          workingFilePath
        );
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    test("does not preserve stale ctrlyoke notification hooks as the baseline", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "codex-stale-hook-baseline-")
      );
      const workingFilePath = path.join(workspaceRoot, ".ctrlyoke", "wf.json");
      const codexDir = path.join(workspaceRoot, ".codex");
      const hooksPath = path.join(codexDir, "hooks.json");
      await fs.mkdir(codexDir, { recursive: true });
      await fs.writeFile(
        hooksPath,
        JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      'node "/old/out/scripts/ctrlyoke-codex-notify.js" "/old/notifications"',
                  },
                ],
              },
            ],
          },
        })
      );

      try {
        await provider.buildNotificationHookArgs(
          "/ext",
          workspaceRoot,
          0,
          workingFilePath,
          undefined,
          []
        );
        const activeHooks = JSON.parse(await fs.readFile(hooksPath, "utf8"));
        assert.strictEqual(activeHooks.hooks.Stop.length, 1);

        await provider.cleanupWorkspaceArtifacts(
          workspaceRoot,
          workingFilePath
        );
        await assert.rejects(fs.access(hooksPath), /ENOENT/);
      } finally {
        await provider.cleanupWorkspaceArtifacts(
          workspaceRoot,
          workingFilePath
        );
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    test("preserves user-owned Codex hooks while discarding stale ctrlyoke groups", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "codex-mixed-hook-baseline-")
      );
      const workingFilePath = path.join(workspaceRoot, ".ctrlyoke", "wf.json");
      const codexDir = path.join(workspaceRoot, ".codex");
      const hooksPath = path.join(codexDir, "hooks.json");
      const userGroup = {
        matcher: "",
        hooks: [{ type: "command", command: "echo user-hook" }],
      };
      await fs.mkdir(codexDir, { recursive: true });
      await fs.writeFile(
        hooksPath,
        JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      'node "/old/out/scripts/ctrlyoke-codex-notify.js" "/old/notifications"',
                  },
                ],
              },
              userGroup,
            ],
          },
        })
      );

      try {
        await provider.buildNotificationHookArgs(
          "/ext",
          workspaceRoot,
          0,
          workingFilePath,
          undefined,
          []
        );
        await provider.cleanupWorkspaceArtifacts(
          workspaceRoot,
          workingFilePath
        );

        const restored = JSON.parse(await fs.readFile(hooksPath, "utf8"));
        assert.deepStrictEqual(restored.hooks.Stop, [userGroup]);
      } finally {
        await provider.cleanupWorkspaceArtifacts(
          workspaceRoot,
          workingFilePath
        );
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  });

  suite("augmentParsedOutput file edit diffs", () => {
    const SESSION_ID = "019f9e95-e555-7581-8607-548358026bb6";
    const EDITED_PATH = "src/temp.txt";

    /** A `patch_apply_end` log line for one file, in Codex's session-log shape. */
    function patchApplyEnd(change: Record<string, unknown>): string {
      return JSON.stringify({
        timestamp: "2026-07-26T13:21:04.938Z",
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "call_abc",
          success: true,
          status: "completed",
          changes: { [EDITED_PATH]: change },
        },
      });
    }

    /** A headless file event as `CodexResponseParser` emits it: path only, no body. */
    function fileEvent(type: string, status: string): CliEvent {
      return {
        type,
        timestamp: 1,
        data: {
          path: EDITED_PATH,
          status,
          ...(type === CLI_EVENT_TYPES.FILE_WRITE && { content: "" }),
        },
      } as CliEvent;
    }

    const fileEditEvent = (status: string) =>
      fileEvent(CLI_EVENT_TYPES.FILE_EDIT, status);

    function outputWith(events: CliEvent[]): UniversalCliOutput {
      return {
        events,
        metadata: {
          sessionId: SESSION_ID,
          harness: HARNESS_IDS.CODEX_CLI,
        },
      } as UniversalCliOutput;
    }

    /**
     * Write a Codex session log at the location `findLogFileBySessionId`
     * searches, under a throwaway home directory.
     */
    async function withSessionLog<T>(
      lines: string[],
      run: () => Promise<T>
    ): Promise<T> {
      const tempHome = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-codex-home-")
      );
      const previousHome = process.env.HOME;
      const previousUserProfile = process.env.USERPROFILE;
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;

      const sessionDir = path.join(
        tempHome,
        ".codex",
        "sessions",
        "2026",
        "07",
        "26"
      );
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(
        path.join(
          sessionDir,
          `rollout-2026-07-26T08-20-51-${SESSION_ID}.jsonl`
        ),
        lines.join("\n") + "\n",
        "utf8"
      );

      try {
        return await run();
      } finally {
        process.env.HOME = previousHome;
        process.env.USERPROFILE = previousUserProfile;
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    }

    function patchOf(output: UniversalCliOutput, index: number) {
      return (output.events[index].data as FileEditData).structuredPatch;
    }

    test("restores update hunks from the session log's unified_diff", async () => {
      const provider = new CodexCliProvider();
      await withSessionLog(
        [
          patchApplyEnd({
            type: "update",
            unified_diff:
              "@@ -482,2 +482,3 @@\n context\n-old line\n+new line\n+added line\n",
          }),
        ],
        async () => {
          const result = await provider.augmentParsedOutput(
            outputWith([fileEditEvent("completed")])
          );

          assert.deepStrictEqual(patchOf(result, 0), [
            {
              oldStart: 482,
              oldLines: 2,
              newStart: 482,
              newLines: 3,
              lines: [" context", "-old line", "+new line", "+added line"],
            },
          ]);
        }
      );
    });

    test("restores written content on a FILE_WRITE add", async () => {
      const provider = new CodexCliProvider();
      await withSessionLog(
        [patchApplyEnd({ type: "add", content: "one\ntwo\n" })],
        async () => {
          const result = await provider.augmentParsedOutput(
            outputWith([fileEvent(CLI_EVENT_TYPES.FILE_WRITE, "completed")])
          );

          assert.strictEqual(
            (result.events[0].data as FileWriteData).content,
            "one\ntwo\n"
          );
        }
      );
    });

    test("a delete consumes its slot so later changes stay aligned", async () => {
      const provider = new CodexCliProvider();
      await withSessionLog(
        [
          patchApplyEnd({ type: "delete", content: "gone\n" }),
          patchApplyEnd({
            type: "update",
            unified_diff: "@@ -1,1 +1,1 @@\n-back\n+again\n",
          }),
        ],
        async () => {
          // FILE_DELETE carries no body, but must still advance the path's
          // cursor or the following update would receive the delete's entry.
          const result = await provider.augmentParsedOutput(
            outputWith([
              fileEvent(CLI_EVENT_TYPES.FILE_DELETE, "completed"),
              fileEditEvent("completed"),
            ])
          );

          assert.strictEqual(patchOf(result, 0), undefined);
          assert.deepStrictEqual(patchOf(result, 1)?.[0].lines, [
            "-back",
            "+again",
          ]);
        }
      );
    });

    test("pairs repeated changes to one path positionally", async () => {
      const provider = new CodexCliProvider();
      await withSessionLog(
        [
          patchApplyEnd({
            type: "update",
            unified_diff: "@@ -1,1 +1,1 @@\n-first\n+second\n",
          }),
          patchApplyEnd({
            type: "update",
            unified_diff: "@@ -5,1 +5,1 @@\n-third\n+fourth\n",
          }),
        ],
        async () => {
          // An INITIATED event describes the same change as the COMPLETED event
          // that follows it, so it must not consume a queue slot of its own.
          const result = await provider.augmentParsedOutput(
            outputWith([
              fileEditEvent("initiated"),
              fileEditEvent("completed"),
              fileEditEvent("initiated"),
              fileEditEvent("completed"),
            ])
          );

          assert.deepStrictEqual(patchOf(result, 0), patchOf(result, 1));
          assert.deepStrictEqual(patchOf(result, 2), patchOf(result, 3));
          assert.strictEqual(patchOf(result, 0)?.[0].lines[0], "-first");
          assert.strictEqual(patchOf(result, 2)?.[0].lines[0], "-third");
        }
      );
    });

    test("matches an absolute event path against a relative logged path", async () => {
      const provider = new CodexCliProvider();
      await withSessionLog(
        [
          patchApplyEnd({
            type: "update",
            unified_diff: "@@ -1,1 +1,1 @@\n-only\n+only2\n",
          }),
        ],
        async () => {
          const absoluteEvent = {
            type: CLI_EVENT_TYPES.FILE_EDIT,
            timestamp: 1,
            data: {
              path: path.join(os.tmpdir(), "repo", EDITED_PATH),
              status: "completed",
            } as FileEditData,
          } as CliEvent;

          const result = await provider.augmentParsedOutput(
            outputWith([absoluteEvent])
          );

          assert.strictEqual(patchOf(result, 0)?.[0].lines[0], "-only");
        }
      );
    });

    test("leaves an event that already carries hunks untouched", async () => {
      const provider = new CodexCliProvider();
      await withSessionLog(
        [
          patchApplyEnd({
            type: "update",
            unified_diff: "@@ -1,1 +1,1 @@\n-log\n+log2\n",
          }),
        ],
        async () => {
          const existing = [
            {
              oldStart: 9,
              oldLines: 1,
              newStart: 9,
              newLines: 1,
              lines: ["-kept", "+kept2"],
            },
          ];
          const event = {
            type: CLI_EVENT_TYPES.FILE_EDIT,
            timestamp: 1,
            data: {
              path: EDITED_PATH,
              status: "completed",
              structuredPatch: existing,
            } as FileEditData,
          } as CliEvent;

          const result = await provider.augmentParsedOutput(
            outputWith([event])
          );

          assert.deepStrictEqual(patchOf(result, 0), existing);
        }
      );
    });

    test("returns the output unchanged when the log records no patches", async () => {
      const provider = new CodexCliProvider();
      await withSessionLog(
        [
          JSON.stringify({
            type: "event_msg",
            payload: { type: "task_start" },
          }),
        ],
        async () => {
          const output = outputWith([fileEditEvent("completed")]);
          const result = await provider.augmentParsedOutput(output);

          assert.strictEqual(result.events, output.events);
          assert.strictEqual(patchOf(result, 0), undefined);
        }
      );
    });
  });
});
