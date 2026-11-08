import * as assert from "assert";
import { EventEmitter } from "events";
import { PassThrough, Writable } from "stream";
import { suite, test } from "mocha";
import {
  CodexAppServerClient,
  normalizeCodexModelListPage,
} from "../../core/harness/codex/CodexAppServerClient";
import {
  ClaudeModelCatalogClient,
  normalizeClaudeModelList,
  selectClaudeInitializeModels,
} from "../../core/harness/claude/ClaudeModelCatalogClient";
import type { StdioProbeProcess } from "../../core/harness/shared/StdioProbe";
import type { resolveCliCommand } from "../../core/harness/shared/CliLauncherResolver";

/**
 * A stand-in CLI: every JSON line written to stdin is handed to `reply`,
 * whose returned messages are written back on stdout. With `closeOnInput`
 * the process exits on the first line instead, like a CLI rejecting a flag.
 * `replyDelayMs` holds each reply back, like a CLI slow to answer.
 */
class FakeStdioProcess extends EventEmitter implements StdioProbeProcess {
  readonly stdout = new PassThrough();
  readonly stdin: Writable;
  readonly received: Record<string, unknown>[] = [];
  killCount = 0;

  constructor(
    reply: (message: Record<string, unknown>) => unknown[],
    closeOnInput = false,
    replyDelayMs = 0
  ) {
    super();
    this.stdin = new Writable({
      // Like a child's stdin pipe, which stays open after end(): a later
      // write emits "write after end" instead of failing silently.
      autoDestroy: false,
      write: (chunk, _encoding, callback) => {
        const message = JSON.parse(String(chunk)) as Record<string, unknown>;
        this.received.push(message);
        if (closeOnInput) {
          setImmediate(() => this.emit("close", 1));
        } else {
          const lines = reply(message);
          const writeReply = () => {
            for (const line of lines) {
              this.stdout.write(JSON.stringify(line) + "\n");
            }
          };
          if (replyDelayMs > 0) setTimeout(writeReply, replyDelayMs);
          else writeReply();
        }
        callback();
      },
    });
  }

  kill(): boolean {
    this.killCount += 1;
    return true;
  }
}

const directResolve: typeof resolveCliCommand = async (command, args) => ({
  command,
  args,
  displayCommand: command,
  launcherKind: "direct",
  requiresShellVerbatimArgs: false,
});

suite("Harness model discovery", () => {
  suite("Codex model/list", () => {
    test("normalizes models, keeping Codex's labels and hidden flag", () => {
      const page = normalizeCodexModelListPage({
        data: [
          {
            id: "gpt-6.1-sol",
            model: "gpt-6.1-sol",
            displayName: "GPT-6.1-Sol",
          },
          { id: "gpt-reserve", displayName: "GPT-Reserve", hidden: true },
          { model: "no-label" },
          { displayName: "no id" },
          "not an object",
        ],
        nextCursor: "page-2",
      });
      assert.deepStrictEqual(page, {
        models: [
          { value: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
          { value: "gpt-reserve", label: "GPT-Reserve", hidden: true },
          { value: "no-label", label: "no-label" },
        ],
        nextCursor: "page-2",
      });
    });

    test("treats a malformed response as no models", () => {
      assert.deepStrictEqual(normalizeCodexModelListPage(null), { models: [] });
      assert.deepStrictEqual(normalizeCodexModelListPage({ data: "x" }), {
        models: [],
      });
    });

    test("asks for hidden models, follows the cursor and tears down", async () => {
      let process: FakeStdioProcess | undefined;
      const client = new CodexAppServerClient({
        resolveCommand: directResolve,
        spawnProcess: () => {
          process = new FakeStdioProcess((message) => {
            if (message.id === undefined) return [];
            if (message.method !== "model/list") {
              return [{ id: message.id, result: {} }];
            }
            const params = message.params as { cursor?: string };
            return [
              {
                id: message.id,
                result: params.cursor
                  ? { data: [{ model: "gpt-reserve", hidden: true }] }
                  : {
                      data: [
                        { model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol" },
                      ],
                      nextCursor: "next",
                    },
              },
            ];
          });
          return process;
        },
      });

      const models = await client.listModels();

      assert.deepStrictEqual(models, [
        { value: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
        { value: "gpt-reserve", label: "gpt-reserve", hidden: true },
      ]);
      const listRequests = process!.received.filter(
        (message) => message.method === "model/list"
      );
      assert.deepStrictEqual(
        listRequests.map((message) => message.params),
        [{ includeHidden: true }, { includeHidden: true, cursor: "next" }]
      );
      assert.strictEqual(process!.killCount, 1);
    });

    test("rejects when Codex refuses model/list", async () => {
      const client = new CodexAppServerClient({
        resolveCommand: directResolve,
        spawnProcess: () =>
          new FakeStdioProcess((message) =>
            message.id === undefined
              ? []
              : message.method === "model/list"
                ? [{ id: message.id, error: { code: -32601 } }]
                : [{ id: message.id, result: {} }]
          ),
      });
      await assert.rejects(client.listModels(), /rejected model\/list/);
    });

    test("stops writing once a slow Codex outlives the probe's timeout", async () => {
      // Codex answers initialize after the probe timed out and tore it down.
      // The probe must not then send `initialized` on the ended stdin: that
      // write fails with "write after end" as an uncaught error.
      let process: FakeStdioProcess | undefined;
      const client = new CodexAppServerClient({
        resolveCommand: directResolve,
        timeoutMs: 20,
        spawnProcess: () => {
          process = new FakeStdioProcess(
            (message) =>
              message.id === undefined ? [] : [{ id: message.id, result: {} }],
            false,
            60
          );
          return process;
        },
      });
      await assert.rejects(client.listModels(), /timed out/);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.deepStrictEqual(
        process!.received.map((message) => message.method),
        ["initialize"]
      );
    });

    test("survives a stdin write error from a CLI that exited", async () => {
      // A CLI that exits early makes the next stdin write fail (EPIPE). The
      // probe fails through the process's own close, never an uncaught error.
      const client = new CodexAppServerClient({
        resolveCommand: directResolve,
        spawnProcess: () => {
          const process = new FakeStdioProcess(() => []);
          setImmediate(() => {
            process.stdin.emit("error", new Error("write EPIPE"));
            process.emit("close", 1);
          });
          return process;
        },
      });
      await assert.rejects(client.listModels(), /closed before replying/);
    });
  });

  suite("Claude initialize", () => {
    const initializeReply = (message: Record<string, unknown>) => [
      { type: "system", subtype: "init" },
      {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: {
            account: { email: "must-not-escape@example.com" },
            models: [
              { value: "default", displayName: "Default (recommended)" },
              { value: "opus", displayName: "Opus 5.5" },
              { value: "claude-opus-4-6", displayName: "Opus 4.6" },
            ],
          },
        },
      },
    ];

    test("drops Claude's default pseudo-model, keeps its labels and hides pinned versions", () => {
      assert.deepStrictEqual(
        normalizeClaudeModelList([
          { value: "default", displayName: "Default" },
          { value: "sonnet", displayName: "Sonnet 5.5" },
          { value: "claude-haiku-4-5-20251001" },
          { displayName: "no value" },
        ]),
        [
          { value: "sonnet", label: "Sonnet 5.5" },
          {
            value: "claude-haiku-4-5-20251001",
            label: "claude-haiku-4-5-20251001",
            hidden: true,
          },
        ]
      );
      assert.deepStrictEqual(normalizeClaudeModelList(undefined), []);
    });

    test("selects only the reply to its own initialize request", () => {
      assert.strictEqual(
        selectClaudeInitializeModels({ type: "system" }),
        undefined
      );
      assert.strictEqual(
        selectClaudeInitializeModels({
          type: "control_response",
          response: { request_id: "someone-else", response: { models: [] } },
        }),
        undefined
      );
      assert.throws(
        () =>
          selectClaudeInitializeModels({
            type: "control_response",
            response: { subtype: "error", request_id: "ctrlyoke-models" },
          }),
        /rejected/
      );
    });

    test("lists models without sending a prompt and discards the account", async () => {
      let spawnedArgs: readonly string[] = [];
      let process: FakeStdioProcess | undefined;
      const client = new ClaudeModelCatalogClient({
        resolveCommand: directResolve,
        spawnProcess: (_command, args) => {
          spawnedArgs = args;
          process = new FakeStdioProcess(initializeReply);
          return process;
        },
      });

      const models = await client.listModels();

      assert.deepStrictEqual(models, [
        { value: "opus", label: "Opus 5.5" },
        { value: "claude-opus-4-6", label: "Opus 4.6", hidden: true },
      ]);
      assert.ok(spawnedArgs.includes("--safe-mode"));
      assert.ok(spawnedArgs.includes("--no-session-persistence"));
      // The only thing written is the initialize control request: no turn.
      assert.deepStrictEqual(
        process!.received.map((message) => message.type),
        ["control_request"]
      );
      assert.strictEqual(
        JSON.stringify(models).includes("must-not-escape"),
        false
      );
      assert.strictEqual(process!.killCount, 1);
    });

    test("asks again without --safe-mode when an older Claude rejects it", async () => {
      const attempts: (readonly string[])[] = [];
      const client = new ClaudeModelCatalogClient({
        resolveCommand: directResolve,
        spawnProcess: (_command, args) => {
          attempts.push(args);
          return new FakeStdioProcess(
            initializeReply,
            args.includes("--safe-mode")
          );
        },
      });

      const models = await client.listModels();

      assert.strictEqual(attempts.length, 2);
      assert.strictEqual(attempts[1].includes("--safe-mode"), false);
      assert.strictEqual(models.length, 2);
    });

    test("does not retry a probe that timed out", async () => {
      let attempts = 0;
      const client = new ClaudeModelCatalogClient({
        resolveCommand: directResolve,
        timeoutMs: 20,
        spawnProcess: () => {
          attempts++;
          return new FakeStdioProcess(() => []);
        },
      });
      await assert.rejects(client.listModels(), /timed out/);
      assert.strictEqual(attempts, 1);
    });
  });
});
