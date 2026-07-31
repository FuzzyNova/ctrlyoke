import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { configService } from "../../config/CtrlYokeConfigService";
import type { ConfigBackend } from "../../config/CtrlYokeConfigService";
import { AntigravityCliProvider } from "../../core/harness/antigravity/AntigravityCliProvider";
import { SettingsJsonMcpTracker } from "../../core/harness/shared/SettingsJsonMcpTracker";
import type { PartialCtrlYokeSettings } from "../../types/CtrlYokeSettings";

function makeBackend(data: PartialCtrlYokeSettings): ConfigBackend {
  return { getAll: () => data, set: async () => {} };
}

suite("AntigravityCliProvider", () => {
  let tempHome: string;
  let workspaceRoot: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  const extensionPath = "C:\\extension root";

  setup(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-provider-home-"));
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agy-provider-workspace-")
    );
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    await fs.mkdir(path.join(tempHome, ".gemini", "config"), {
      recursive: true,
    });
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));
    SettingsJsonMcpTracker.resetAll();
  });

  teardown(async () => {
    SettingsJsonMcpTracker.resetAll();
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  function settingsPath(): string {
    return path.join(tempHome, ".gemini", "antigravity-cli", "settings.json");
  }

  async function buildArgs(provider: AntigravityCliProvider) {
    return provider.buildCliArgs(
      {} as never,
      false,
      extensionPath,
      workspaceRoot,
      undefined,
      {
        promptIndex: 0,
        allPrompts: [],
        workingFilePath: path.join(workspaceRoot, "workflow.md"),
      }
    );
  }

  function stubSessionRecovery(
    provider: AntigravityCliProvider,
    cachedSessionId: string | null,
    logSessionId: string | null
  ) {
    const calls = {
      cache: 0,
      discover: 0,
      extract: 0,
    };
    provider.logParser.readSessionIdFromLastConversations = async () => {
      calls.cache += 1;
      return cachedSessionId ?? undefined;
    };
    provider.logParser.discoverSessionLog = async () => {
      calls.discover += 1;
      return logSessionId ? "session.log" : null;
    };
    provider.logParser.extractSessionIdFromLogPath = async () => {
      calls.extract += 1;
      return logSessionId ?? undefined;
    };
    return calls;
  }

  async function publishSnapshot(
    provider: AntigravityCliProvider,
    conversationId: string,
    writtenAt: number,
    contextWindow?: Record<string, unknown>
  ) {
    const env = provider.getHeadlessSpawnEnv();
    const token = env.CTRLYOKE_AGY_STATUSLINE_TOKEN;
    const directory = env.CTRLYOKE_AGY_STATUSLINE_DIR;
    assert.ok(token);
    assert.ok(directory);

    const snapshotPath = path.join(directory, `agy-statusline-${token}.json`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      snapshotPath,
      JSON.stringify({
        conversation_id: conversationId,
        ...(contextWindow ? { context_window: contextWindow } : {}),
        _ctrlyoke: { sequence: 1, writtenAt },
      })
    );
  }

  async function waitForSnapshot(provider: AntigravityCliProvider) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (provider.getLatestStatuslineSnapshot()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("statusline snapshot was not observed by the sidecar");
  }

  test("retains hook artifacts while its process can receive injected turns", () => {
    const provider = new AntigravityCliProvider();

    assert.strictEqual(provider.shouldRetainWorkflowArtifactsForReuse(), true);
  });

  test("routes headless output through the transcript log parser", () => {
    const provider = new AntigravityCliProvider();

    assert.strictEqual(provider.headlessSource, "log");
    assert.ok(provider.logParser);
    assert.ok(provider.extractSessionIdFromLogs);
  });

  test("uses stream-json only for headless arguments", () => {
    const provider = new AntigravityCliProvider();

    assert.deepStrictEqual(
      provider.buildHeadlessArgs(["--model", "gemini-3.6-flash-low"], "prompt"),
      [
        "--print",
        "prompt",
        "--output-format",
        "stream-json",
        "--model",
        "gemini-3.6-flash-low",
      ]
    );
    assert.deepStrictEqual(
      provider.buildInteractiveArgs(
        ["--model", "gemini-3.6-flash-low"],
        "prompt"
      ),
      ["--prompt-interactive", "prompt", "--model", "gemini-3.6-flash-low"]
    );
  });

  suite("extractSessionIdFromStdout", () => {
    const initEvent = JSON.stringify({
      event: "init",
      conversation_id: "73b9d054-1234-5678-9abc-0123456789ab",
      init: {
        model: "gemini-3.6-flash-low",
        cwd: "C:/workspace",
        tools: ["run_command"],
        permission_mode: "default",
      },
    });

    test("returns the init event conversation ID", () => {
      const provider = new AntigravityCliProvider();
      const capturedAgentResponseEvent =
        '{"event":"step_update","step_update":{"conversation_id":"73b9d054-...","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":0.7197045,"usage":{"input_tokens":17831,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":17832}}}';

      assert.strictEqual(
        provider.extractSessionIdFromStdout?.(
          `${capturedAgentResponseEvent}\n${initEvent}`
        ),
        "73b9d054-1234-5678-9abc-0123456789ab"
      );
    });

    test("returns undefined for a truncated JSON line", () => {
      const provider = new AntigravityCliProvider();

      assert.strictEqual(
        provider.extractSessionIdFromStdout?.(initEvent.slice(0, -4)),
        undefined
      );
    });

    test("tolerates interleaved non-JSON noise", () => {
      const provider = new AntigravityCliProvider();

      assert.strictEqual(
        provider.extractSessionIdFromStdout?.(
          `warning from agy\nnot-json\n${initEvent}\nprogress`
        ),
        "73b9d054-1234-5678-9abc-0123456789ab"
      );
    });
  });

  test("regenerates the token for every prompt and forwards it to both spawn modes", async () => {
    const provider = new AntigravityCliProvider();
    const inheritedKey = "CTRLYOKE_AGY_PROVIDER_TEST_ENV";
    process.env[inheritedKey] = "preserve-me";

    try {
      await buildArgs(provider);
      const firstHeadless = provider.getHeadlessSpawnEnv();
      const firstInteractive = provider.getInteractiveSpawnEnv();
      await buildArgs(provider);
      const secondHeadless = provider.getHeadlessSpawnEnv();

      assert.ok(firstHeadless.CTRLYOKE_AGY_STATUSLINE_TOKEN);
      assert.ok(firstHeadless.CTRLYOKE_AGY_STATUSLINE_DIR);
      assert.strictEqual(
        firstInteractive.CTRLYOKE_AGY_STATUSLINE_TOKEN,
        firstHeadless.CTRLYOKE_AGY_STATUSLINE_TOKEN
      );
      assert.strictEqual(firstInteractive[inheritedKey], "preserve-me");
      assert.ok(secondHeadless.CTRLYOKE_AGY_STATUSLINE_TOKEN);
      assert.notStrictEqual(
        secondHeadless.CTRLYOKE_AGY_STATUSLINE_TOKEN,
        firstHeadless.CTRLYOKE_AGY_STATUSLINE_TOKEN
      );
    } finally {
      delete process.env[inheritedKey];
      await provider.cleanupWorkspaceArtifacts(
        workspaceRoot,
        path.join(workspaceRoot, "workflow.md")
      );
    }
  });

  test("registers an unquoted forward-slash command and forwards the baseline command", async () => {
    await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
    await fs.writeFile(
      settingsPath(),
      JSON.stringify({
        statusLine: { type: "command", command: "node user-statusline.js" },
        theme: "dark",
      })
    );
    const provider = new AntigravityCliProvider();

    try {
      await buildArgs(provider);
      const settings = JSON.parse(await fs.readFile(settingsPath(), "utf8"));
      assert.strictEqual(
        settings.statusLine.command,
        "node C:/extension root/out/scripts/ctrlyoke-antigravity-statusline.js"
      );
      assert.ok(!settings.statusLine.command.includes('"'));
      assert.strictEqual(
        provider.getHeadlessSpawnEnv().CTRLYOKE_AGY_STATUSLINE_FORWARD,
        "node user-statusline.js"
      );
    } finally {
      await provider.cleanupWorkspaceArtifacts(
        workspaceRoot,
        path.join(workspaceRoot, "workflow.md")
      );
    }

    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath(), "utf8")),
      {
        statusLine: { type: "command", command: "node user-statusline.js" },
        theme: "dark",
      }
    );
  });

  test("does not write settings or statusline env when tracking is disabled", async () => {
    const original = { theme: "dark" };
    await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
    await fs.writeFile(settingsPath(), JSON.stringify(original));
    configService.setUserBackend(
      makeBackend({ permissions: { antigravityStatusLineTracking: false } })
    );
    const provider = new AntigravityCliProvider();

    await buildArgs(provider);

    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath(), "utf8")),
      original
    );
    assert.strictEqual(
      provider.getHeadlessSpawnEnv().CTRLYOKE_AGY_STATUSLINE_TOKEN,
      undefined
    );
    assert.strictEqual(
      provider.getInteractiveSpawnEnv().CTRLYOKE_AGY_STATUSLINE_DIR,
      undefined
    );

    provider.observeHeadlessStdout(
      '{"event":"step_update","step_update":{"step_type":"agent_response","usage":{"input_tokens":1,"output_tokens":2,"thinking_tokens":3,"total_tokens":3}}}\n'
    );
    assert.strictEqual(
      provider.logParser.extractResponse([
        { type: "response.text", line: "answer" },
      ]).metadata.usage,
      undefined
    );
  });

  test("resets stream-json usage for each prompt", async () => {
    const provider = new AntigravityCliProvider();
    const streamEvent =
      '{"event":"step_update","step_update":{"step_type":"agent_response","usage":{"input_tokens":1,"output_tokens":2,"thinking_tokens":3,"total_tokens":3}}}\n';

    provider.observeHeadlessStdout(streamEvent);
    assert.strictEqual(
      provider.logParser.extractResponse([
        { type: "response.text", line: "answer" },
      ]).metadata.usage?.reasoningOutputTokens,
      3
    );

    try {
      await buildArgs(provider);
      assert.strictEqual(
        provider.logParser.extractResponse([
          { type: "response.text", line: "next answer" },
        ]).metadata.usage,
        undefined
      );
    } finally {
      await provider.cleanupWorkspaceArtifacts(
        workspaceRoot,
        path.join(workspaceRoot, "workflow.md")
      );
    }
  });

  suite("augmentParsedOutput", () => {
    test("patches missing completed-response usage from the latest snapshot", async () => {
      const provider = new AntigravityCliProvider();
      try {
        await buildArgs(provider);
        const sidecar = provider.startExecutionSidecar({
          workspaceRoot,
          model: "gemini-3.6-flash-low",
          onStreamingEvents: () => {},
          onContextWindowUpdate: () => {},
        });
        assert.ok(sidecar);
        await publishSnapshot(provider, "snapshot-session-id", 2_000, {
          total_input_tokens: 1_000,
          total_output_tokens: 200,
          context_window_size: 10_000,
          current_usage: {
            input_tokens: 120,
            output_tokens: 7,
            cache_creation_input_tokens: 40,
            cache_read_input_tokens: 30,
          },
        });
        await waitForSnapshot(provider);

        const output = await provider.augmentParsedOutput({
          events: [],
          metadata: { model: "gemini-3.6-flash-low" },
        });

        assert.strictEqual(output.metadata.usage?.inputTokens, 120);
        assert.strictEqual(output.metadata.usage?.outputTokens, 200);
        assert.strictEqual(output.metadata.usage?.cachedInputTokens, 30);
        assert.strictEqual(output.metadata.usage?.cacheCreatedTokens, 40);
        assert.strictEqual(
          output.metadata.usage?.contextWindowUsedTokens,
          1_200
        );
        assert.strictEqual(output.metadata.usage?.contextWindowSize, 10_000);
        sidecar.stop();
      } finally {
        await provider.cleanupWorkspaceArtifacts(
          workspaceRoot,
          path.join(workspaceRoot, "workflow.md")
        );
      }
    });

    test("does not overwrite usage values already produced by the parser", async () => {
      const provider = new AntigravityCliProvider();
      try {
        await buildArgs(provider);
        const sidecar = provider.startExecutionSidecar({
          workspaceRoot,
          model: "gemini-3.6-flash-low",
          onStreamingEvents: () => {},
          onContextWindowUpdate: () => {},
        });
        assert.ok(sidecar);
        await publishSnapshot(provider, "snapshot-session-id", 2_000, {
          total_input_tokens: 1_000,
          total_output_tokens: 200,
          context_window_size: 10_000,
          current_usage: {
            input_tokens: 120,
            output_tokens: 7,
            cache_creation_input_tokens: 40,
            cache_read_input_tokens: 30,
          },
        });
        await waitForSnapshot(provider);

        const existingUsage = {
          inputTokens: 8,
          outputTokens: 9,
          totalTokens: 17,
          cachedInputTokens: 10,
          cacheCreatedTokens: 11,
          contextWindowUsedTokens: 12,
          contextWindowSize: 13,
        };
        const output = await provider.augmentParsedOutput({
          events: [],
          metadata: { usage: existingUsage },
        });

        assert.deepStrictEqual(output.metadata.usage, existingUsage);
        sidecar.stop();
      } finally {
        await provider.cleanupWorkspaceArtifacts(
          workspaceRoot,
          path.join(workspaceRoot, "workflow.md")
        );
      }
    });
  });

  suite("extractSessionIdFromLogs", () => {
    test("returns a fresh snapshot conversation ID before recovery", async () => {
      const provider = new AntigravityCliProvider();
      const calls = stubSessionRecovery(provider, "cached-id", "log-id");

      try {
        await buildArgs(provider);
        const currentSidecar = provider.startExecutionSidecar({
          workspaceRoot,
          model: "gemini-3.6-flash-low",
          onStreamingEvents: () => {},
          onContextWindowUpdate: () => {},
        });
        assert.ok(currentSidecar);
        const startTime = new Date(1_000);
        await publishSnapshot(provider, "snapshot-session-id", 2_000);
        await waitForSnapshot(provider);

        const result = await provider.extractSessionIdFromLogs(
          "prompt",
          startTime,
          workspaceRoot
        );

        assert.strictEqual(result, "snapshot-session-id");
        assert.deepStrictEqual(calls, { cache: 0, discover: 0, extract: 0 });
        currentSidecar.stop();
      } finally {
        await provider.cleanupWorkspaceArtifacts(
          workspaceRoot,
          path.join(workspaceRoot, "workflow.md")
        );
      }
    });

    test("falls back to cache then log scraping when no snapshot is available", async () => {
      const provider = new AntigravityCliProvider();
      const calls = stubSessionRecovery(provider, null, "log-session-id");

      try {
        await buildArgs(provider);
        const sidecar = provider.startExecutionSidecar({
          workspaceRoot,
          model: "gemini-3.6-flash-low",
          onStreamingEvents: () => {},
          onContextWindowUpdate: () => {},
        });
        assert.ok(sidecar);

        const result = await provider.extractSessionIdFromLogs(
          "prompt",
          new Date(1_000),
          workspaceRoot
        );

        assert.strictEqual(result, "log-session-id");
        assert.deepStrictEqual(calls, { cache: 1, discover: 1, extract: 1 });
        sidecar.stop();
      } finally {
        await provider.cleanupWorkspaceArtifacts(
          workspaceRoot,
          path.join(workspaceRoot, "workflow.md")
        );
      }
    });

    test("rejects a snapshot written before execution and uses recovery", async () => {
      const provider = new AntigravityCliProvider();
      const calls = stubSessionRecovery(
        provider,
        "cached-session-id",
        "log-id"
      );

      try {
        await buildArgs(provider);
        const sidecar = provider.startExecutionSidecar({
          workspaceRoot,
          model: "gemini-3.6-flash-low",
          onStreamingEvents: () => {},
          onContextWindowUpdate: () => {},
        });
        assert.ok(sidecar);
        await publishSnapshot(provider, "stale-session-id", 2_000);
        await waitForSnapshot(provider);

        const result = await provider.extractSessionIdFromLogs(
          "prompt",
          new Date(3_000),
          workspaceRoot
        );

        assert.strictEqual(result, "cached-session-id");
        assert.deepStrictEqual(calls, { cache: 1, discover: 0, extract: 0 });
        sidecar.stop();
      } finally {
        await provider.cleanupWorkspaceArtifacts(
          workspaceRoot,
          path.join(workspaceRoot, "workflow.md")
        );
      }
    });

    test("does not consult the snapshot when tracking is disabled", async () => {
      configService.setUserBackend(
        makeBackend({ permissions: { antigravityStatusLineTracking: false } })
      );
      const provider = new AntigravityCliProvider();
      const calls = stubSessionRecovery(
        provider,
        "cached-session-id",
        "log-id"
      );
      let snapshotConsulted = false;
      provider.getLatestStatuslineSnapshot = () => {
        snapshotConsulted = true;
        return undefined;
      };

      try {
        await buildArgs(provider);
        const result = await provider.extractSessionIdFromLogs(
          "prompt",
          new Date(1_000),
          workspaceRoot
        );

        assert.strictEqual(result, "cached-session-id");
        assert.strictEqual(snapshotConsulted, false);
        assert.deepStrictEqual(calls, { cache: 1, discover: 0, extract: 0 });
      } finally {
        await provider.cleanupWorkspaceArtifacts(
          workspaceRoot,
          path.join(workspaceRoot, "workflow.md")
        );
      }
    });
  });

  suite("pruneOrphanedStatusLine", () => {
    test("restores the baseline left by a dead ctrlyoke process", async () => {
      const settingsDir = path.dirname(settingsPath());
      await fs.mkdir(settingsDir, { recursive: true });
      await fs.writeFile(
        settingsPath(),
        JSON.stringify({
          statusLine: {
            type: "command",
            command: "node ctrlyoke-installed.js",
          },
        })
      );
      const leasePath = path.join(
        settingsDir,
        ".ctrlyoke-lease-statusLine.json"
      );
      await fs.writeFile(
        leasePath,
        JSON.stringify({
          baseline: { type: "command", command: "node user-statusline.js" },
          baselineHadKey: true,
          // A PID that cannot be alive, standing in for a crashed host.
          owners: [{ pid: 99999999, workflowKey: "crashed", ts: Date.now() }],
        })
      );

      await AntigravityCliProvider.pruneOrphanedStatusLine(workspaceRoot);

      const restored = JSON.parse(await fs.readFile(settingsPath(), "utf-8"));
      assert.deepStrictEqual(restored.statusLine, {
        type: "command",
        command: "node user-statusline.js",
      });
      await assert.rejects(fs.access(leasePath), /ENOENT/);
    });

    test("is a no-op when no lease state exists", async () => {
      await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
      await fs.writeFile(settingsPath(), JSON.stringify({ other: "value" }));

      await AntigravityCliProvider.pruneOrphanedStatusLine(workspaceRoot);

      assert.deepStrictEqual(
        JSON.parse(await fs.readFile(settingsPath(), "utf-8")),
        { other: "value" }
      );
    });
  });

  test("unregisters the statusline lease during cleanup", async () => {
    const provider = new AntigravityCliProvider();
    await buildArgs(provider);
    assert.ok(
      (await fs.readFile(settingsPath(), "utf8")).includes("statusLine")
    );

    await provider.cleanupWorkspaceArtifacts(
      workspaceRoot,
      path.join(workspaceRoot, "workflow.md")
    );

    await assert.rejects(fs.access(settingsPath()), /ENOENT/);
    assert.strictEqual(
      provider.getAdditionalCleanupFilePaths(workspaceRoot).length,
      1
    );
  });
});
