import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { SettingsJsonHooksTracker } from "../../flightpath/harness/shared/SettingsJsonHooksTracker";

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.keys(value as Record<string, unknown>)
    .sort((left, right) => left.localeCompare(right))
    .reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = canonicalizeJson((value as Record<string, unknown>)[key]);
      return sorted;
    }, {});
}

function codexTrustedHash(
  eventName: string,
  matcher: string | undefined,
  command: string,
  timeout: number,
  statusMessage?: string
): string {
  const identity: Record<string, unknown> = {
    event_name: eventName,
    hooks: [
      {
        async: false,
        command,
        timeout,
        type: "command",
        ...(statusMessage !== undefined ? { statusMessage } : {}),
      },
    ],
    ...(matcher !== undefined ? { matcher } : {}),
  };

  const serialized = JSON.stringify(canonicalizeJson(identity));
  const digest = crypto
    .createHash("sha256")
    .update(serialized, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

function codexInlineTrustOverride(
  state: Record<string, { enabled?: boolean; trusted_hash?: string }>
): string[] {
  const entries = Object.entries(state)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      const fields: string[] = [];
      if (value.enabled !== undefined) {
        fields.push(`"enabled" = ${value.enabled ? "true" : "false"}`);
      }
      if (value.trusted_hash !== undefined) {
        fields.push(`"trusted_hash" = ${JSON.stringify(value.trusted_hash)}`);
      }
      return `${JSON.stringify(key)} = { ${fields.join(", ")} }`;
    });

  return entries.length > 0
    ? ["-c", `hooks.state={ ${entries.join(", ")} }`]
    : [];
}

suite("SettingsJsonHooksTracker", () => {
  let tmpDir: string;
  let settingsDir: string;
  let settingsPath: string;

  setup(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hooks-tracker-test-"));
    settingsDir = path.join(tmpDir, ".qwen");
    settingsPath = path.join(settingsDir, "settings.json");
    await fs.mkdir(settingsDir, { recursive: true });
    SettingsJsonHooksTracker.resetAll();
  });

  teardown(async () => {
    SettingsJsonHooksTracker.resetAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("should capture baseline on first registration", async () => {
    // Write initial settings with user hooks
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo user" }] }],
        },
      })
    );

    const tracker = SettingsJsonHooksTracker.getInstance("qwen");
    await tracker.registerWorkflow(
      "wf-1",
      tmpDir,
      {
        Stop: [{ hooks: [{ type: "command", command: "node fp.js" }] }],
      },
      {}
    );

    // Settings should have both FlightPath and user hooks
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.strictEqual(settings.hooks.Stop.length, 2);
    assert.strictEqual(tracker.getActiveWorkflowCount(), 1);
  });

  test("should restore baseline on last unregister", async () => {
    const originalHooks = {
      Stop: [{ hooks: [{ type: "command", command: "echo user" }] }],
    };
    await fs.writeFile(settingsPath, JSON.stringify({ hooks: originalHooks }));

    const tracker = SettingsJsonHooksTracker.getInstance("qwen");
    await tracker.registerWorkflow(
      "wf-1",
      tmpDir,
      {
        Stop: [{ hooks: [{ type: "command", command: "node fp.js" }] }],
      },
      {}
    );

    await tracker.unregisterWorkflow("wf-1", tmpDir);

    // Settings should be restored to original
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.deepStrictEqual(settings.hooks, originalHooks);
    assert.strictEqual(tracker.getActiveWorkflowCount(), 0);
  });

  test("should handle parallel workflows correctly", async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ hooks: null }));

    const tracker = SettingsJsonHooksTracker.getInstance("qwen");

    // Workflow A registers
    await tracker.registerWorkflow(
      "wf-A",
      tmpDir,
      {
        Stop: [{ hooks: [{ type: "command", command: "node a.js" }] }],
      },
      {}
    );
    assert.strictEqual(tracker.getActiveWorkflowCount(), 1);

    // Workflow B registers
    await tracker.registerWorkflow(
      "wf-B",
      tmpDir,
      {
        Stop: [{ hooks: [{ type: "command", command: "node b.js" }] }],
      },
      {}
    );
    assert.strictEqual(tracker.getActiveWorkflowCount(), 2);

    // Settings should have both
    let settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.strictEqual(settings.hooks.Stop.length, 2);

    // Workflow A unregisters — B's hooks should remain
    await tracker.unregisterWorkflow("wf-A", tmpDir);
    assert.strictEqual(tracker.getActiveWorkflowCount(), 1);

    settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.ok(settings.hooks.Stop.length >= 1);

    // Workflow B unregisters — baseline restored
    await tracker.unregisterWorkflow("wf-B", tmpDir);
    assert.strictEqual(tracker.getActiveWorkflowCount(), 0);
  });

  test("should handle no existing settings file", async () => {
    // Don't write any settings file
    await fs.rm(settingsPath, { force: true });

    const tracker = SettingsJsonHooksTracker.getInstance("qwen");
    await tracker.registerWorkflow(
      "wf-1",
      tmpDir,
      {
        Stop: [{ hooks: [{ type: "command", command: "node fp.js" }] }],
      },
      {}
    );

    const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.strictEqual(settings.hooks.Stop.length, 1);

    await tracker.unregisterWorkflow("wf-1", tmpDir);

    await assert.rejects(fs.access(settingsPath), /ENOENT/);
  });

  test("should remove codex hooks.json when FlightPath created it", async () => {
    const codexHooksPath = path.join(tmpDir, ".codex", "hooks.json");
    await fs.rm(codexHooksPath, { force: true });

    const tracker = SettingsJsonHooksTracker.getInstance("codex");
    await tracker.registerWorkflow(
      "wf-1",
      tmpDir,
      {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: "node fp.js" }] },
        ],
      },
      {}
    );

    JSON.parse(await fs.readFile(codexHooksPath, "utf-8"));

    await tracker.unregisterWorkflow("wf-1", tmpDir);

    await assert.rejects(fs.access(codexHooksPath), /ENOENT/);
  });

  test("should auto-trust Codex hooks injected by FlightPath", async () => {
    const codexHooksPath = path.join(tmpDir, ".codex", "hooks.json");
    const tracker = SettingsJsonHooksTracker.getInstance("codex");

    await tracker.registerWorkflow(
      "wf-1",
      tmpDir,
      {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: "node fp.js" }] },
        ],
      },
      {
        SessionStart: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "node notify.js" }],
          },
        ],
      }
    );

    const settings = JSON.parse(await fs.readFile(codexHooksPath, "utf-8"));
    assert.strictEqual(settings.hooks.state, undefined);
    assert.deepStrictEqual(
      SettingsJsonHooksTracker.serializeCodexInlineTrustOverride(
        tracker.getCodexTrustState(tmpDir)
      ),
      codexInlineTrustOverride({
        [`${codexHooksPath}:session_start:0:0`]: {
          trusted_hash: codexTrustedHash(
            "session_start",
            "",
            "node notify.js",
            600
          ),
        },
        [`${codexHooksPath}:stop:0:0`]: {
          trusted_hash: codexTrustedHash("stop", undefined, "node fp.js", 600),
        },
      })
    );
  });

  test("should omit matcher from Codex trust hash for matcherless events", async () => {
    const codexHooksPath = path.join(tmpDir, ".codex", "hooks.json");
    const tracker = SettingsJsonHooksTracker.getInstance("codex");

    await tracker.registerWorkflow(
      "wf-1",
      tmpDir,
      {
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "node prompt-check.js" }],
          },
        ],
      },
      {}
    );

    assert.deepStrictEqual(
      SettingsJsonHooksTracker.serializeCodexInlineTrustOverride(
        tracker.getCodexTrustState(tmpDir)
      ),
      codexInlineTrustOverride({
        [`${codexHooksPath}:user_prompt_submit:0:0`]: {
          trusted_hash: codexTrustedHash(
            "user_prompt_submit",
            undefined,
            "node prompt-check.js",
            600
          ),
        },
      })
    );
  });

  test("should remap existing Codex hook state when FlightPath prepends hooks", async () => {
    const codexDir = path.join(tmpDir, ".codex");
    const codexHooksPath = path.join(codexDir, "hooks.json");
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(
      codexHooksPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: "",
              hooks: [{ type: "command", command: "echo baseline" }],
            },
          ],
          state: {
            [`${codexHooksPath}:stop:0:0`]: {
              enabled: false,
              trusted_hash: "sha256:baseline",
            },
          },
        },
      })
    );

    const tracker = SettingsJsonHooksTracker.getInstance("codex");
    await tracker.registerWorkflow(
      "wf-1",
      tmpDir,
      {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: "node fp.js" }] },
        ],
      },
      {}
    );

    const settings = JSON.parse(await fs.readFile(codexHooksPath, "utf-8"));
    assert.strictEqual(settings.hooks.state, undefined);
    assert.deepStrictEqual(
      SettingsJsonHooksTracker.serializeCodexInlineTrustOverride(
        tracker.getCodexTrustState(tmpDir)
      ),
      codexInlineTrustOverride({
        [`${codexHooksPath}:stop:0:0`]: {
          trusted_hash: codexTrustedHash("stop", undefined, "node fp.js", 600),
        },
        [`${codexHooksPath}:stop:1:0`]: {
          enabled: false,
          trusted_hash: "sha256:baseline",
        },
      })
    );
  });

  test("should keep existing settings file when only hooks were temporary", async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ theme: "dark" }));

    const tracker = SettingsJsonHooksTracker.getInstance("qwen");
    await tracker.registerWorkflow(
      "wf-1",
      tmpDir,
      {
        Stop: [{ hooks: [{ type: "command", command: "node fp.js" }] }],
      },
      {}
    );

    await tracker.unregisterWorkflow("wf-1", tmpDir);

    const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.deepStrictEqual(settings, { theme: "dark" });
  });

  test("should include workflow user hooks in middle layer", async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo baseline" }] }],
        },
      })
    );

    const tracker = SettingsJsonHooksTracker.getInstance("qwen");
    await tracker.registerWorkflow(
      "wf-1",
      tmpDir,
      {
        Stop: [{ hooks: [{ type: "command", command: "node fp.js" }] }],
      },
      {
        Stop: [{ hooks: [{ type: "command", command: "npm test" }] }],
      }
    );

    // Order should be: FlightPath first, user hooks middle, baseline last
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.strictEqual(settings.hooks.Stop.length, 3);
    assert.strictEqual(settings.hooks.Stop[0].hooks[0].command, "node fp.js");
    assert.strictEqual(settings.hooks.Stop[1].hooks[0].command, "npm test");
    assert.strictEqual(
      settings.hooks.Stop[2].hooks[0].command,
      "echo baseline"
    );
  });

  test("should use separate instances per tool name", () => {
    const qwen = SettingsJsonHooksTracker.getInstance("qwen");
    const gemini = SettingsJsonHooksTracker.getInstance("gemini");
    assert.notStrictEqual(qwen, gemini);

    // Same name returns same instance
    const qwen2 = SettingsJsonHooksTracker.getInstance("qwen");
    assert.strictEqual(qwen, qwen2);
  });

  test("unregister for unknown workflow is no-op", async () => {
    const tracker = SettingsJsonHooksTracker.getInstance("qwen");
    // Should not throw
    await tracker.unregisterWorkflow("nonexistent", tmpDir);
    assert.strictEqual(tracker.getActiveWorkflowCount(), 0);
  });
});
