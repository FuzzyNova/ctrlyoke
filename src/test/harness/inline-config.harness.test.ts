/**
 * Inline harness configuration regression tests.
 *
 * These are real-harness tests and are intentionally not part of `npm test`.
 * Run with `npm run test:harness` only when authenticated installations of the
 * pinned CLIs are available.  Exit code 3 means that the target CLI is absent
 * and skips the case.
 *
 * Verified fixture pins:
 *   - OpenCode 1.18.10
 *   - codex-cli 0.146.0
 *   - Qwen Code 0.20.1
 *
 * OpenCode's merge behavior and Codex's config-layer behavior are emergent
 * rather than documented contracts; re-verify these fixtures on CLI upgrade.
 */

import * as assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type {
  McpServerConfig,
  PromptFile,
  ToolPermissionsOverride,
  UserHookConfig,
} from "../../types/CtrlYokeTypes";
import { EXECUTION_MODES } from "../../types/DashboardConstants";
import {
  HARNESS_MODELS,
  HARNESS_TIMEOUT_MS,
  PINNED_HARNESS_VERSIONS,
  buildHookRecorderScript,
  buildMcpProbeServerScript,
  logAndMaybeSkip,
  runInteractiveWorkflowFile,
  runWorkflowFile,
  runWorkflowFileAsync,
} from "./helpers/harnessRunner";

const OPENCODE = "opencode-cli" as const;
const CODEX = "codex-cli" as const;
const QWEN = "qwen-cli" as const;

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function hookCommand(
  scriptPath: string,
  event: string,
  outputPath: string
): string {
  return `node "${scriptPath}" ${event} "${outputPath}"`;
}

function assertSuccessfulRun(
  label: string,
  result: ReturnType<typeof runWorkflowFile>
): void {
  assert.strictEqual(
    result.exitCode,
    0,
    `${label}: CLI exited with code ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
}

function assertNoWorkspaceConfig(tmpDir: string, names: string[]): void {
  for (const name of names) {
    assert.ok(
      !fs.existsSync(path.join(tmpDir, name)),
      `unexpected workspace configuration artifact: ${name}`
    );
  }
}

function makeUserMcpServer(
  id: string,
  toolName: string,
  scriptPath: string,
  markerPath: string
): McpServerConfig {
  return {
    id,
    command: "node",
    args: [scriptPath, toolName, markerPath],
    autoApprove: true,
  };
}

function makeHook(
  event: UserHookConfig["event"],
  scriptPath: string,
  outputPath: string
): UserHookConfig {
  return {
    event,
    command: hookCommand(scriptPath, event, outputPath),
  };
}

function hasRecordedEvent(outputPath: string, event: string): boolean {
  if (!fs.existsSync(outputPath)) return false;
  return fs
    .readFileSync(outputPath, "utf8")
    .split(/\r?\n/)
    .some((line) => line.includes(`"event":"${event}"`));
}

function openCodePermissionWorkflow(
  markerPath: string,
  permissions: ToolPermissionsOverride
): PromptFile {
  return {
    harness: OPENCODE,
    model: HARNESS_MODELS[OPENCODE],
    toolPermissions: permissions,
    steps: [
      {
        name: "opencode-permission-probe",
        prompt: [
          "Use the shell tool exactly once.",
          `Run: node -e \"require('fs').writeFileSync('${normalizedPath(markerPath)}','permission-allowed')\"`,
          "If the shell tool is denied, do not retry and do not create the file another way.",
        ].join(" "),
      },
    ],
  };
}

function codexHookWorkflow(
  hooks: UserHookConfig[],
  prompt: string,
  executionMode: "headless" | "interactive" = "headless"
): PromptFile {
  return {
    harness: CODEX,
    model: HARNESS_MODELS[CODEX],
    executionMode,
    toolPermissions: { mode: "dangerouslyAllowAll" },
    hooks,
    steps: [{ name: "codex-inline-hook-probe", prompt }],
  };
}

function qwenMcpWorkflow(
  server: McpServerConfig,
  prompt: string,
  executionMode: "headless" | "interactive" = "headless"
): PromptFile {
  return {
    harness: QWEN,
    model: HARNESS_MODELS[QWEN],
    executionMode,
    toolPermissions: { mode: "dangerouslyAllowAll" },
    mcpServers: [server],
    steps: [{ name: "qwen-inline-mcp-probe", prompt }],
  };
}

function qwenPermissionWorkflow(
  markerPath: string,
  permissions: ToolPermissionsOverride
): PromptFile {
  return {
    harness: QWEN,
    model: HARNESS_MODELS[QWEN],
    toolPermissions: permissions,
    steps: [
      {
        name: "qwen-permission-probe",
        prompt: [
          "Use the shell tool exactly once.",
          `Run: node -e \"require('fs').writeFileSync('${normalizedPath(markerPath)}','permission-allowed')\"`,
          "If the shell tool is denied, do not retry and do not create the file another way.",
        ].join(" "),
      },
    ],
  };
}

suite("Inline harness configuration regression tests", function () {
  this.timeout(HARNESS_TIMEOUT_MS);

  let tmpDir: string;
  let recorderScript: string;
  let mcpServerScript: string;

  setup(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-inline-harness-"));
    recorderScript = path.join(tmpDir, "record-hook.js");
    mcpServerScript = path.join(tmpDir, "mcp-probe.js");
    fs.writeFileSync(recorderScript, buildHookRecorderScript());
    fs.writeFileSync(mcpServerScript, buildMcpProbeServerScript());
  });

  teardown(function () {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      console.log(`  ⚠  Could not clean up ${tmpDir} (may still be in use)`);
    }
  });

  suite(`OpenCode ${PINNED_HARNESS_VERSIONS[OPENCODE]}`, function () {
    for (const permissionCase of [
      {
        name: "allow proceeds",
        permissions: {
          mode: "custom",
          allowedTools: ["shell(command:*)"],
          deniedTools: [],
        } satisfies ToolPermissionsOverride,
        shouldCreate: true,
      },
      {
        name: "deny blocks",
        permissions: {
          mode: "custom",
          allowedTools: [],
          deniedTools: ["shell(command:*)"],
        } satisfies ToolPermissionsOverride,
        shouldCreate: false,
      },
      {
        name: "deny wins over allow",
        permissions: {
          mode: "custom",
          allowedTools: ["shell(command:*)"],
          deniedTools: ["shell(command:*)"],
        } satisfies ToolPermissionsOverride,
        shouldCreate: false,
      },
    ]) {
      test(`${permissionCase.name} through inline config with no opencode.json`, function () {
        const markerPath = path.join(tmpDir, "opencode-permission-marker.txt");
        const result = runWorkflowFile(
          openCodePermissionWorkflow(markerPath, permissionCase.permissions),
          tmpDir,
          `opencode-${permissionCase.name.replace(/ /g, "-")}`
        );
        if (logAndMaybeSkip(`opencode-cli (${permissionCase.name})`, result))
          return;
        assertSuccessfulRun(`opencode-cli (${permissionCase.name})`, result);
        assert.strictEqual(
          fs.existsSync(markerPath),
          permissionCase.shouldCreate
        );
        assertNoWorkspaceConfig(tmpDir, ["opencode.json", ".opencode"]);
      });

      test(`${permissionCase.name} survives conflicting user opencode.json`, function () {
        const markerPath = path.join(tmpDir, "opencode-conflict-marker.txt");
        const userConfigPath = path.join(tmpDir, "opencode.json");
        const userConfig = JSON.stringify(
          {
            permission: {
              "*": permissionCase.shouldCreate ? "deny" : "allow",
              bash: { "*": permissionCase.shouldCreate ? "deny" : "allow" },
            },
          },
          null,
          2
        );
        fs.writeFileSync(userConfigPath, userConfig);

        const result = runWorkflowFile(
          openCodePermissionWorkflow(markerPath, permissionCase.permissions),
          tmpDir,
          `opencode-conflict-${permissionCase.name.replace(/ /g, "-")}`
        );
        if (
          logAndMaybeSkip(
            `opencode-cli conflict (${permissionCase.name})`,
            result
          )
        )
          return;
        assertSuccessfulRun(
          `opencode-cli conflict (${permissionCase.name})`,
          result
        );
        assert.strictEqual(
          fs.existsSync(markerPath),
          permissionCase.shouldCreate
        );
        assert.strictEqual(fs.readFileSync(userConfigPath, "utf8"), userConfig);
      });
    }

    test("connects to the ctrlyoke MCP server from inline config", function () {
      const markerPath = path.join(tmpDir, "opencode-mcp-marker.txt");
      const marker = normalizedPath(markerPath);
      const result = runWorkflowFile(
        {
          harness: OPENCODE,
          model: HARNESS_MODELS[OPENCODE],
          toolPermissions: { mode: "dangerouslyAllowAll" },
          mcpServers: ["ctrlyoke"],
          steps: [
            {
              name: "opencode-ctrlyoke-mcp",
              prompt: [
                "Call ctrlyoke_queue_status before doing anything else.",
                `After it returns, use the shell tool to run: node -e \"require('fs').writeFileSync('${marker}','mcp-connected')\"`,
              ].join(" "),
            },
          ],
        },
        tmpDir,
        "opencode-ctrlyoke-mcp"
      );
      if (logAndMaybeSkip("opencode-cli (ctrlyoke MCP)", result)) return;
      assertSuccessfulRun("opencode-cli (ctrlyoke MCP)", result);
      assert.ok(
        fs.existsSync(markerPath),
        "ctrlyoke MCP call did not complete before the marker step"
      );
      assertNoWorkspaceConfig(tmpDir, ["opencode.json", ".opencode"]);
    });

    for (const mode of ["headless", "interactive"] as const) {
      test(`completion plugin loads from an external file URL in ${mode} mode`, function () {
        const outputPath = path.join(tmpDir, `opencode-${mode}-hooks.jsonl`);
        const workflow = {
          harness: OPENCODE,
          model: HARNESS_MODELS[OPENCODE],
          executionMode: mode,
          toolPermissions: { mode: "dangerouslyAllowAll" },
          hooks: [makeHook("stop", recorderScript, outputPath)],
          steps: [
            {
              name: "opencode-plugin",
              prompt: "Reply with exactly: plugin-loaded",
            },
          ],
        } satisfies PromptFile;
        const result =
          mode === EXECUTION_MODES.HEADLESS
            ? runWorkflowFile(workflow, tmpDir, `opencode-plugin-${mode}`)
            : runInteractiveWorkflowFile(
                workflow,
                tmpDir,
                `opencode-plugin-${mode}`
              );
        if (logAndMaybeSkip(`opencode-cli plugin (${mode})`, result)) return;
        assertSuccessfulRun(`opencode-cli plugin (${mode})`, result);
        assert.ok(
          hasRecordedEvent(outputPath, "stop"),
          `OpenCode completion plugin did not dispatch the stop hook in ${mode} mode`
        );
        assertNoWorkspaceConfig(tmpDir, ["opencode.json", ".opencode"]);
      });
    }
  });

  suite(`Codex ${PINNED_HARNESS_VERSIONS[CODEX]}`, function () {
    test("interactive completion uses inline hooks without .codex/hooks.json", function () {
      const outputPath = path.join(tmpDir, "codex-inline-stop.jsonl");
      const result = runInteractiveWorkflowFile(
        codexHookWorkflow(
          [makeHook("stop", recorderScript, outputPath)],
          "Reply with exactly: codex-inline-complete",
          "interactive"
        ),
        tmpDir,
        "codex-inline-completion"
      );
      if (logAndMaybeSkip("codex-cli (inline interactive)", result)) return;
      assertSuccessfulRun("codex-cli (inline interactive)", result);
      assert.ok(hasRecordedEvent(outputPath, "stop"));
      assertNoWorkspaceConfig(tmpDir, [".codex"]);
    });

    test("inline completion works in an untrusted Codex project where the old file path fails", function () {
      const outputPath = path.join(tmpDir, "codex-untrusted-stop.jsonl");
      const legacyOutputPath = path.join(tmpDir, "codex-legacy-stop.jsonl");
      const legacyHookPath = path.join(tmpDir, ".codex", "hooks.json");
      const legacyConfig = JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                matcher: "",
                hooks: [
                  {
                    type: "command",
                    command: hookCommand(
                      recorderScript,
                      "legacy-stop",
                      legacyOutputPath
                    ),
                  },
                ],
              },
            ],
          },
        },
        null,
        2
      );
      fs.mkdirSync(path.dirname(legacyHookPath), { recursive: true });
      fs.writeFileSync(legacyHookPath, legacyConfig);
      const result = runInteractiveWorkflowFile(
        codexHookWorkflow(
          [makeHook("stop", recorderScript, outputPath)],
          "Reply with exactly: codex-untrusted-complete",
          "interactive"
        ),
        tmpDir,
        "codex-untrusted-inline-completion"
      );
      if (logAndMaybeSkip("codex-cli (untrusted inline)", result)) return;
      assertSuccessfulRun("codex-cli (untrusted inline)", result);
      assert.ok(hasRecordedEvent(outputPath, "stop"));
      assert.ok(
        !hasRecordedEvent(legacyOutputPath, "legacy-stop"),
        "the untrusted legacy project hook unexpectedly fired"
      );
      assert.strictEqual(fs.readFileSync(legacyHookPath, "utf8"), legacyConfig);
    });

    test("preserves a user's .codex/hooks.json and still runs the user's hook", function () {
      const codexDir = path.join(tmpDir, ".codex");
      const userOutputPath = path.join(tmpDir, "codex-user-hook.jsonl");
      const userConfigPath = path.join(codexDir, "hooks.json");
      const gitInit = spawnSync("git", ["init", "--quiet"], {
        cwd: tmpDir,
        stdio: "ignore",
      });
      assert.strictEqual(
        gitInit.status,
        0,
        "Codex user-hook fixture must be a git project"
      );
      fs.mkdirSync(codexDir, { recursive: true });
      const userConfig = JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                matcher: "",
                hooks: [
                  {
                    type: "command",
                    command: hookCommand(
                      recorderScript,
                      "user-stop",
                      userOutputPath
                    ),
                  },
                ],
              },
            ],
          },
        },
        null,
        2
      );
      fs.writeFileSync(userConfigPath, userConfig);

      const result = runInteractiveWorkflowFile(
        codexHookWorkflow(
          [],
          "Reply with exactly: codex-user-hook-complete",
          "interactive"
        ),
        tmpDir,
        "codex-user-hook-preservation"
      );
      if (logAndMaybeSkip("codex-cli (user hook preservation)", result)) return;
      assertSuccessfulRun("codex-cli (user hook preservation)", result);
      assert.strictEqual(fs.readFileSync(userConfigPath, "utf8"), userConfig);
      assert.ok(hasRecordedEvent(userOutputPath, "user-stop"));
    });

    test("fires a PreToolUse matcher for a shell tool call", function () {
      const outputPath = path.join(tmpDir, "codex-pre-tool.jsonl");
      const markerPath = normalizedPath(
        path.join(tmpDir, "codex-shell-marker.txt")
      );
      const result = runWorkflowFile(
        codexHookWorkflow(
          [makeHook("preToolUse", recorderScript, outputPath)],
          `Run exactly this shell command: node -e \"require('fs').writeFileSync('${markerPath}','shell-called')\"`,
          "headless"
        ),
        tmpDir,
        "codex-pre-tool-matcher"
      );
      if (logAndMaybeSkip("codex-cli (PreToolUse matcher)", result)) return;
      assertSuccessfulRun("codex-cli (PreToolUse matcher)", result);
      assert.ok(fs.existsSync(markerPath));
      assert.ok(hasRecordedEvent(outputPath, "preToolUse"));
    });
  });

  suite(`Qwen ${PINNED_HARNESS_VERSIONS[QWEN]}`, function () {
    for (const permissionCase of [
      {
        name: "allow proceeds",
        permissions: {
          mode: "custom",
          allowedTools: ["shell(node:*)"],
          deniedTools: [],
        } satisfies ToolPermissionsOverride,
        shouldCreate: true,
      },
      {
        name: "deny blocks",
        permissions: {
          mode: "custom",
          allowedTools: [],
          deniedTools: ["shell(node:*)"],
        } satisfies ToolPermissionsOverride,
        shouldCreate: false,
      },
    ]) {
      test(`${permissionCase.name} through inline CLI arguments`, function () {
        const markerPath = path.join(tmpDir, "qwen-permission-marker.txt");
        const result = runWorkflowFile(
          qwenPermissionWorkflow(markerPath, permissionCase.permissions),
          tmpDir,
          `qwen-permission-${permissionCase.name.replace(/ /g, "-")}`
        );
        if (logAndMaybeSkip(`qwen-cli (${permissionCase.name})`, result))
          return;
        assertSuccessfulRun(`qwen-cli (${permissionCase.name})`, result);
        assert.strictEqual(
          fs.existsSync(markerPath),
          permissionCase.shouldCreate
        );
        assertNoWorkspaceConfig(tmpDir, [".qwen", ".gitignore"]);
      });
    }

    for (const mode of ["headless", "interactive"] as const) {
      test(`calls an inline MCP tool in ${mode} mode`, function () {
        const toolName = `qwen_${mode}_probe`;
        const markerPath = path.join(tmpDir, `${toolName}.calls`);
        const server = makeUserMcpServer(
          `qwen_${mode}_server`,
          toolName,
          mcpServerScript,
          markerPath
        );
        const prompt = [
          `Call the MCP tool mcp__qwen_${mode}_server__${toolName} exactly once.`,
          "Do not use shell or any other tool.",
        ].join(" ");
        const result =
          mode === EXECUTION_MODES.HEADLESS
            ? runWorkflowFile(
                qwenMcpWorkflow(server, prompt, mode),
                tmpDir,
                `qwen-mcp-${mode}`
              )
            : runInteractiveWorkflowFile(
                qwenMcpWorkflow(server, prompt, mode),
                tmpDir,
                `qwen-mcp-${mode}`
              );
        if (logAndMaybeSkip(`qwen-cli MCP (${mode})`, result)) return;
        assertSuccessfulRun(`qwen-cli MCP (${mode})`, result);
        assert.strictEqual(
          fs.readFileSync(markerPath, "utf8").trim(),
          toolName
        );
      });
    }

    test("inline MCP without hooks leaves no workspace .qwen or .gitignore", function () {
      const markerPath = path.join(tmpDir, "qwen-no-settings.calls");
      const server = makeUserMcpServer(
        "qwen_no_settings_server",
        "qwen_no_settings_probe",
        mcpServerScript,
        markerPath
      );
      const result = runWorkflowFile(
        qwenMcpWorkflow(
          server,
          "Call mcp__qwen_no_settings_server__qwen_no_settings_probe exactly once and do not use any other tool."
        ),
        tmpDir,
        "qwen-no-settings"
      );
      if (logAndMaybeSkip("qwen-cli (no workspace settings)", result)) return;
      assertSuccessfulRun("qwen-cli (no workspace settings)", result);
      assert.ok(fs.existsSync(markerPath));
      assertNoWorkspaceConfig(tmpDir, [".qwen", ".gitignore"]);
    });

    test("concurrent workflows expose only their own inline MCP tool", async function () {
      const leftMarker = path.join(tmpDir, "qwen-concurrent-left.calls");
      const rightMarker = path.join(tmpDir, "qwen-concurrent-right.calls");
      const leftServer = makeUserMcpServer(
        "qwen_left_server",
        "qwen_left_tool",
        mcpServerScript,
        leftMarker
      );
      const rightServer = makeUserMcpServer(
        "qwen_right_server",
        "qwen_right_tool",
        mcpServerScript,
        rightMarker
      );
      const [left, right] = await Promise.all([
        runWorkflowFileAsync(
          qwenMcpWorkflow(
            leftServer,
            "Call mcp__qwen_left_server__qwen_left_tool exactly once and do not call any other tool."
          ),
          tmpDir,
          "qwen-concurrent-left"
        ),
        runWorkflowFileAsync(
          qwenMcpWorkflow(
            rightServer,
            "Call mcp__qwen_right_server__qwen_right_tool exactly once and do not call any other tool."
          ),
          tmpDir,
          "qwen-concurrent-right"
        ),
      ]);
      if (logAndMaybeSkip("qwen-cli (concurrent left)", left)) return;
      if (logAndMaybeSkip("qwen-cli (concurrent right)", right)) return;
      assertSuccessfulRun("qwen-cli (concurrent left)", left);
      assertSuccessfulRun("qwen-cli (concurrent right)", right);
      assert.strictEqual(
        fs.readFileSync(leftMarker, "utf8").trim(),
        "qwen_left_tool"
      );
      assert.strictEqual(
        fs.readFileSync(rightMarker, "utf8").trim(),
        "qwen_right_tool"
      );
    });

    test("existing hooks still deliver start, completion, and permission events", function () {
      const outputPath = path.join(tmpDir, "qwen-existing-hooks.jsonl");
      const hooks = [
        makeHook("sessionStart", recorderScript, outputPath),
        makeHook("stop", recorderScript, outputPath),
        makeHook("permissionRequest", recorderScript, outputPath),
      ];
      const workflow: PromptFile = {
        harness: QWEN,
        model: HARNESS_MODELS[QWEN],
        toolPermissions: {
          mode: "custom",
          allowedTools: [],
          deniedTools: [],
        },
        hooks,
        steps: [
          {
            name: "qwen-hook-events",
            prompt:
              "Run exactly one shell command: echo qwen-hook-event-probe. Do not use any other tool.",
          },
        ],
      };
      const result = runWorkflowFile(workflow, tmpDir, "qwen-existing-hooks");
      if (logAndMaybeSkip("qwen-cli (existing hooks)", result)) return;
      assertSuccessfulRun("qwen-cli (existing hooks)", result);
      assert.ok(hasRecordedEvent(outputPath, "sessionStart"));
      assert.ok(hasRecordedEvent(outputPath, "stop"));
      assert.ok(hasRecordedEvent(outputPath, "permissionRequest"));
    });
  });
});
