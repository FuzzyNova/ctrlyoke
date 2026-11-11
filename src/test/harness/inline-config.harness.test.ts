/**
 * Inline harness configuration regression tests.
 *
 * These are real-harness tests and are intentionally not part of `npm test`.
 * Run with `npm run test:harness` only when authenticated CLIs are installed.
 * Exit code 3 means that the target CLI is absent and skips the case.
 *
 * OpenCode's merge behavior and Codex's config-layer behavior are emergent
 * rather than documented contracts; re-verify these fixtures on CLI upgrade.
 * The CLI versions each run exercised are recorded by the suite's version
 * report (see helpers/harnessVersionReport.ts).
 */

import * as assert from "assert";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type {
  McpServerConfig,
  PromptFile,
  ToolPermissionsOverride,
  UserHookConfig,
} from "../../types/CtrlYokeTypes";
import {
  CLI_EVENT_TYPES,
  EXECUTION_MODES,
} from "../../types/DashboardConstants";
import { normalizeAntigravityMcpServerId } from "../../utils/ToolPermissionUtils";
import {
  OPENCODE_EXPORT_COMMANDS,
  OPENCODE_MESSAGE_ROLES,
  OPENCODE_PART_TYPES,
  OPENCODE_V2_MESSAGE_TYPES,
} from "../../core/harness/opencode/OpenCodeProtocolConstants";
import { detectOpenCodeV2 } from "../../core/harness/opencode/OpenCodeVersion";
import { getAntigravitySettingsPath } from "../../core/harness/shared/StatuslineManager";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import {
  HARNESS_MODELS,
  HARNESS_TIMEOUT_MS,
  MCP_STARTUP_RETRY_INSTRUCTION,
  buildHookRecorderScript,
  buildMcpProbeServerScript,
  findRunFiles,
  isolateRunState,
  logAndMaybeSkip,
  readRecordedCliEvents,
  readRecordedHookEvents,
  runInteractiveWorkflowFile,
  runWorkflowFile,
  runWorkflowFileAsync,
  qwenHomeCopy,
  runsRootFor,
  withIsolatedCodexHome,
  withMovedHarnessHome,
} from "./helpers/harnessRunner";

const OPENCODE = "opencode-cli" as const;
const CODEX = "codex-cli" as const;
const QWEN = "qwen-cli" as const;
const ANTIGRAVITY = "antigravity-cli" as const;

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

/**
 * ctrlyoke must not change a user's opencode.json. OpenCode itself (confirmed
 * on 1.18.32 with no ctrlyoke involved) inserts a `$schema` key into any
 * project config it loads, so compare the parsed content without that key
 * rather than the raw bytes.
 */
function assertOpenCodeUserConfigPreserved(
  configPath: string,
  original: string
): void {
  const { $schema: _schema, ...current } = JSON.parse(
    fs.readFileSync(configPath, "utf8")
  ) as Record<string, unknown>;
  assert.deepStrictEqual(current, JSON.parse(original));
}

function makeUserMcpServer(
  id: string,
  toolName: string,
  scriptPath: string,
  markerPath: string,
  recordEnv?: string
): McpServerConfig {
  return {
    id,
    command: "node",
    args: [scriptPath, toolName, markerPath, ...(recordEnv ? [recordEnv] : [])],
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

/** The harness session ID of the single one-step run under `runsRoot`. */
function readSingleRunSessionId(runsRoot: string): string {
  const runFiles = findRunFiles(runsRoot, "workflow.ctrlyoke.json").filter(
    (file) => path.basename(path.dirname(file)).startsWith("run-")
  );
  assert.strictEqual(runFiles.length, 1, `expected one run, got ${runFiles}`);
  const sessionId = (
    JSON.parse(fs.readFileSync(runFiles[0], "utf8")) as {
      steps: Array<{ _runtime?: { sessionId?: string } }>;
    }
  ).steps[0]?._runtime?.sessionId;
  assert.ok(sessionId, "the run recorded no OpenCode session ID");
  return sessionId;
}

/**
 * The first user text OpenCode stored for `sessionId`, via export. OpenCode 1
 * runs `export` and stores `{ info: { role }, parts }`; OpenCode 2 runs
 * `session export` and stores flat `{ type: "user", text }` messages.
 */
async function readOpenCodeFirstUserText(
  sessionId: string,
  cwd: string
): Promise<string> {
  const subcommand = (await detectOpenCodeV2())
    ? OPENCODE_EXPORT_COMMANDS.V2
    : OPENCODE_EXPORT_COMMANDS.V1;
  const exported = spawnSync("opencode", [...subcommand, sessionId], {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.strictEqual(exported.status, 0, `opencode export: ${exported.stderr}`);
  const stdout = exported.stdout;
  const transcript = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
    messages: Array<{
      info?: { role: string };
      parts?: Array<{ type: string; text?: string }>;
      type?: string;
      text?: string;
    }>;
  };
  const text = transcript.messages
    .map((message) =>
      message.info
        ? message.info.role === OPENCODE_MESSAGE_ROLES.USER
          ? message.parts?.find(
              (part) => part.type === OPENCODE_PART_TYPES.TEXT
            )?.text
          : undefined
        : message.type === OPENCODE_V2_MESSAGE_TYPES.USER
          ? message.text
          : undefined
    )
    .find((candidate) => candidate !== undefined);
  assert.ok(text !== undefined, "the exported session has no user text");
  return text;
}

function hasRecordedEvent(outputPath: string, event: string): boolean {
  return readRecordedHookEvents(outputPath).has(event);
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

/** Run a `ctrlyoke trust-*` command non-interactively in `tmpDir`. */
function runTrustCommand(tmpDir: string, args: string[]): void {
  const cliPath = path.resolve(__dirname, "../../cli.js");
  const result = spawnSync(
    "node",
    [cliPath, ...args, "--cwd", tmpDir, "--yes"],
    { cwd: tmpDir, encoding: "utf8" }
  );
  assert.strictEqual(
    result.status,
    0,
    `Could not run ${args[0]}: ${result.stderr}`
  );
}

function trustWorkflowSecretGrants(
  workflow: PromptFile,
  tmpDir: string,
  label: string
): void {
  const workflowPath = path.join(tmpDir, `${label}-test.ctrlyoke.json`);
  fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, 2));
  runTrustCommand(tmpDir, ["trust-secret-grants", workflowPath]);
}

/** Where an external root's approval is recorded. */
const EXTERNAL_ROOT_TRUST_SCOPES = {
  WORKSPACE: "workspace",
  WORKFLOW: "workflow",
} as const;

/** Request `roots` in the workspace's `permissions.trustedExternalRoots` and approve them. */
function trustWorkspaceExternalRoots(tmpDir: string, roots: string[]): void {
  const settingsDir = path.join(tmpDir, ".ctrlyoke");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, "settings.json"),
    JSON.stringify({ permissions: { trustedExternalRoots: roots } }, null, 2)
  );
  runTrustCommand(tmpDir, ["trust-external-roots"]);
}

/**
 * Approve a workflow's own `trustedExternalRoots`, writing it where
 * `runWorkflowFile` will run it from: the approval is keyed by that path.
 */
function trustWorkflowExternalRoots(
  workflow: PromptFile,
  tmpDir: string,
  label: string
): void {
  const workflowPath = path.join(tmpDir, `${label}-test.ctrlyoke.json`);
  fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, 2));
  runTrustCommand(tmpDir, ["trust-workflow-external-roots", workflowPath]);
}

function buildStreamableHttpMcpServerScript(): string {
  return `"use strict";
const http = require("http");
const fs = require("fs");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const marker = process.argv[2];
const mcp = new McpServer({ name: "qwen-http-probe", version: "1.0.0" });
mcp.tool("record_remote_call", "Record the remote MCP tool call.", {}, async () => {
  fs.appendFileSync(marker, "called\\n");
  return { content: [{ type: "text", text: "remote-probe-called" }] };
});
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => require("crypto").randomUUID()
});
const server = http.createServer((req, res) => transport.handleRequest(req, res));
mcp.connect(transport).then(() => {
  server.listen(0, "127.0.0.1", () => console.log(server.address().port));
});
`;
}

async function startStreamableHttpMcpServer(
  scriptPath: string,
  markerPath: string
): Promise<{ url: string; stop: () => void }> {
  fs.writeFileSync(scriptPath, buildStreamableHttpMcpServerScript());
  const server = spawn("node", [scriptPath, markerPath], {
    cwd: path.dirname(scriptPath),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_PATH: [
        path.resolve(process.cwd(), "node_modules"),
        process.env.NODE_PATH,
      ]
        .filter(Boolean)
        .join(path.delimiter),
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.stdout?.on("data", (chunk: Buffer) => {
      const parsed = Number(chunk.toString().trim());
      if (parsed > 0) resolve(parsed);
    });
  });
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stop: () => {
      server.kill();
    },
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

/** Printed by `MARKER_SCRIPT`; never appears in a prompt or command line. */
const AGY_PROBE_RAN = "AGY_PROBE_EXECUTED";

/**
 * Source for a script that prints `AGY_PROBE_RAN`, then tries to write the
 * file named by argv[2]. Antigravity's translated shell allow rule refuses
 * parentheses, quotes and `$` in a command line, so the probe command must be
 * a plain `node <script> <file>` rather than an inline `node -e "…"`.
 *
 * The printed token proves the command was permitted to start; the marker file
 * proves it ran unsandboxed. ctrlyoke used to add `--sandbox` in `custom`, and
 * on Windows (agy 1.4.12) agy ran even a rule-allowed command inside it, where
 * the write failed with `EPERM`.
 */
const MARKER_SCRIPT = `"use strict";
process.stdout.write(${JSON.stringify(AGY_PROBE_RAN)} + "\\n");
try {
  require("fs").writeFileSync(process.argv[2], "permission-allowed");
} catch (error) {
  process.stdout.write("marker write failed: " + error.code + "\\n");
}
`;

/**
 * Every Antigravity shell case also denies `write`, so a model that falls
 * back to agy's `write_file` after a refused command cannot create the marker
 * and turn a correct denial into a false failure.
 */
const ANTIGRAVITY_NO_WRITE_FALLBACK = ["write"];

interface AntigravityProbeResult {
  result: ReturnType<typeof runWorkflowFile>;
  /** Recorded non-text CLI events, serialized, as proof of an attempt. */
  toolEvents: string;
}

/**
 * Runs an Antigravity workflow with isolated run state, so the case can read
 * back the tool events agy reported. A deny case asserts on these: a missing
 * marker only proves a denial if the model actually tried the call.
 */
function runAntigravityProbe(
  workflow: PromptFile,
  tmpDir: string,
  label: string
): AntigravityProbeResult {
  const restore = isolateRunState(tmpDir);
  try {
    const result = runWorkflowFile(workflow, tmpDir, label);
    const toolEvents = findRunFiles(runsRootFor(tmpDir), "events.jsonl")
      .flatMap(readRecordedCliEvents)
      .filter((event) => event.type !== CLI_EVENT_TYPES.TEXT)
      .map((event) => JSON.stringify(event))
      .join("\n");
    return { result, toolEvents };
  } finally {
    restore();
  }
}

function antigravityShellWorkflow(
  name: string,
  permissions: ToolPermissionsOverride,
  commandLines: readonly string[]
): PromptFile {
  return {
    harness: ANTIGRAVITY,
    model: HARNESS_MODELS[ANTIGRAVITY],
    toolPermissions: permissions,
    steps: [
      {
        name,
        prompt: [
          "Call the run_command tool exactly once, with exactly this command line" +
            (commandLines.length > 1
              ? ` (${commandLines.length} lines; keep the line breaks):`
              : ":"),
          "",
          ...commandLines,
          "",
          "Do not change, split, or reformat the command.",
          "If the tool call is denied, do not retry and do not try any other tool or another way to cause the same effect.",
        ].join("\n"),
      },
    ],
  };
}

function antigravityMcpWorkflow(
  name: string,
  permissions: ToolPermissionsOverride,
  server: McpServerConfig,
  toolName: string
): PromptFile {
  return {
    harness: ANTIGRAVITY,
    model: HARNESS_MODELS[ANTIGRAVITY],
    toolPermissions: permissions,
    mcpServers: [server],
    steps: [
      {
        name,
        prompt: [
          `Use the call_mcp_tool tool exactly once to call the tool ${toolName} on the MCP server ${normalizeAntigravityMcpServerId(server.id)}.`,
          "Do not call any other tool or try another way to cause the same effect.",
          MCP_STARTUP_RETRY_INSTRUCTION,
        ].join(" "),
      },
    ],
  };
}

/**
 * Runs `fn` with `USERPROFILE`/`HOME` pointing at a throwaway home whose
 * `~/.gemini/antigravity-cli/settings.json` holds `settings`. agy keeps its
 * sign-in outside `~/.gemini`, so an empty home still authenticates, and the
 * developer's real `~/.gemini` is never read or written.
 */
async function withIsolatedAntigravityHome<T>(
  settings: Record<string, unknown>,
  fn: (settingsPath: string) => T | Promise<T>
): Promise<T> {
  const home = makeTempDir("ctrlyoke-agy-home-");
  const settingsPath = getAntigravitySettingsPath(home);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  // macOS finds the login Keychain, where agy keeps its sign-in, through
  // $HOME/Library; without it agy fails with "authentication failed or timed
  // out". Windows keeps credentials outside the profile folder.
  if (process.platform === "darwin") {
    fs.symlinkSync(
      path.join(os.homedir(), "Library"),
      path.join(home, "Library")
    );
  }
  const previous = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    return await fn(settingsPath);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeTempDir(home);
  }
}

/**
 * Runs `fn` with `QWEN_HOME` pointing at a throwaway Qwen home that holds
 * copies of the real sign-in files, and whose user `settings.json` has
 * `hooks` added. Qwen and ctrlyoke's Qwen log reader both follow `QWEN_HOME`,
 * so the run stays consistent, and the developer's real `~/.qwen` is only
 * read.
 */
async function withIsolatedQwenHome<T>(
  hooks: Record<string, unknown[]>,
  fn: () => T | Promise<T>
): Promise<T> {
  return withMovedHarnessHome(qwenHomeCopy(), (qwenDir) => {
    const settingsPath = path.join(qwenDir, "settings.json");
    const settings = fs.existsSync(settingsPath)
      ? (JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<
          string,
          unknown
        >)
      : {};
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ ...settings, hooks }, null, 2)
    );
    return fn();
  });
}

suite("Inline harness configuration regression tests", function () {
  this.timeout(HARNESS_TIMEOUT_MS);

  let tmpDir: string;
  let recorderScript: string;
  let mcpServerScript: string;

  setup(function () {
    tmpDir = makeTempDir("ctrlyoke-inline-harness-");
    recorderScript = path.join(tmpDir, "record-hook.js");
    mcpServerScript = path.join(tmpDir, "mcp-probe.js");
    fs.writeFileSync(recorderScript, buildHookRecorderScript());
    fs.writeFileSync(mcpServerScript, buildMcpProbeServerScript());
  });

  teardown(function () {
    removeTempDir(tmpDir, (dir) =>
      console.log(`  ⚠  Could not clean up ${dir} (may still be in use)`)
    );
  });

  suite(OPENCODE, function () {
    for (const trustScope of [
      EXTERNAL_ROOT_TRUST_SCOPES.WORKSPACE,
      EXTERNAL_ROOT_TRUST_SCOPES.WORKFLOW,
      undefined,
    ]) {
      const trusted = trustScope !== undefined;
      test(`custom mode ${trusted ? `reads under a ${trustScope}-trusted` : "cannot read outside an untrusted"} external root`, function () {
        // OpenCode gates paths outside its launch directory with
        // `external_directory`, which ctrlyoke grants for trusted roots the
        // way it passes `--add-dir` to other harnesses. A workflow's own roots
        // are approved against the authored file, but a real run executes
        // its working copy, so the workflow case checks that lookup.
        const outsideDir = makeTempDir("ctrlyoke-opencode-external-");
        try {
          const token = `external-${Date.now().toString(36)}`;
          const secretPath = path.join(outsideDir, "secret.txt");
          fs.writeFileSync(secretPath, `${token}\n`);
          const label = `opencode-external-${trustScope ?? "untrusted"}`;
          const workflow: PromptFile = {
            harness: OPENCODE,
            model: HARNESS_MODELS[OPENCODE],
            ...(trustScope === EXTERNAL_ROOT_TRUST_SCOPES.WORKFLOW
              ? { trustedExternalRoots: [outsideDir] }
              : {}),
            toolPermissions: {
              mode: "custom",
              allowedTools: [],
              deniedTools: [],
            },
            steps: [
              {
                name: "opencode-external-read",
                prompt: [
                  `Use the read tool once to read ${normalizedPath(secretPath)} and reply with its exact content.`,
                  "If the read is rejected, say so, do not retry, and do not try another tool.",
                ].join(" "),
              },
            ],
          };
          if (trustScope === EXTERNAL_ROOT_TRUST_SCOPES.WORKSPACE) {
            trustWorkspaceExternalRoots(tmpDir, [outsideDir]);
          } else if (trustScope === EXTERNAL_ROOT_TRUST_SCOPES.WORKFLOW) {
            trustWorkflowExternalRoots(workflow, tmpDir, label);
          }
          const result = runWorkflowFile(workflow, tmpDir, label);
          if (logAndMaybeSkip(`opencode-cli (${label})`, result)) return;
          assertSuccessfulRun(`opencode-cli (${label})`, result);
          assert.strictEqual(
            result.stdout.includes(token),
            trusted,
            `opencode-cli (${label}) stdout: ${result.stdout}`
          );
        } finally {
          removeTempDir(outsideDir, () => {});
        }
      });
    }

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
      {
        name: "deny wins over allow",
        permissions: {
          mode: "custom",
          allowedTools: ["shell(node:*)"],
          deniedTools: ["shell(node:*)"],
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
        assertOpenCodeUserConfigPreserved(userConfigPath, userConfig);
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
                "Call workflow_status before doing anything else.",
                `After it returns, use the shell tool to run: node -e \"require('fs').writeFileSync('${marker}','mcp-connected')\"`,
                MCP_STARTUP_RETRY_INSTRUCTION,
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

    test("refuses a denied MCP tool with a sanitized server name", function () {
      const markerPath = path.join(tmpDir, "opencode-denied-mcp.calls");
      const server = makeUserMcpServer(
        "opencode.probe-server",
        "blocked.probe",
        mcpServerScript,
        markerPath
      );
      server.deniedTools = ["blocked.probe"];
      const result = runWorkflowFile(
        {
          harness: OPENCODE,
          model: HARNESS_MODELS[OPENCODE],
          toolPermissions: { mode: "allowAll" },
          mcpServers: [server],
          steps: [
            {
              name: "opencode-denied-mcp-tool",
              prompt: [
                "Call the MCP tool opencode_probe-server_blocked_probe exactly once.",
                "Do not call any other tool or try another way to cause the same effect.",
                MCP_STARTUP_RETRY_INSTRUCTION,
              ].join(" "),
            },
          ],
        },
        tmpDir,
        "opencode-denied-mcp"
      );
      if (logAndMaybeSkip("opencode-cli (denied MCP tool)", result)) return;
      assertSuccessfulRun("opencode-cli (denied MCP tool)", result);
      assert.ok(
        !fs.existsSync(markerPath),
        "OpenCode called the denied MCP tool"
      );
      assertNoWorkspaceConfig(tmpDir, ["opencode.json", ".opencode"]);
    });

    // Claude-format `mcp__<server>__<tool>` allow patterns must become OpenCode's
    // sanitized `<server>_<tool>` names (and `<server>_*` for a whole server);
    // headless OpenCode auto-rejects anything that falls through to `"*": "ask"`.
    // commit-permissions.harness.test.ts covers the commit-generation shape.
    for (const allowCase of [
      {
        name: "exact tool",
        allowedTool: "mcp__opencode.probe-server__allowed.probe",
      },
      { name: "whole server", allowedTool: "mcp__opencode.probe-server" },
    ]) {
      test(`calls an MCP tool allowed by a Claude-format ${allowCase.name} pattern in custom mode`, function () {
        const markerPath = path.join(tmpDir, "opencode-allowed-mcp.calls");
        const label = `opencode-allowed-mcp-${allowCase.name.replace(/ /g, "-")}`;
        const result = runWorkflowFile(
          {
            harness: OPENCODE,
            model: HARNESS_MODELS[OPENCODE],
            executionMode: EXECUTION_MODES.HEADLESS,
            toolPermissions: {
              mode: "custom",
              allowedTools: [allowCase.allowedTool],
              deniedTools: ["shell"],
            },
            mcpServers: [
              makeUserMcpServer(
                "opencode.probe-server",
                "allowed.probe",
                mcpServerScript,
                markerPath
              ),
            ],
            steps: [
              {
                name: label,
                prompt: [
                  "Call the MCP tool opencode_probe-server_allowed_probe exactly once.",
                  "Do not call any other tool or try another way to cause the same effect.",
                  MCP_STARTUP_RETRY_INSTRUCTION,
                ].join(" "),
              },
            ],
          },
          tmpDir,
          label
        );
        if (logAndMaybeSkip(`opencode-cli (${label})`, result)) return;
        assertSuccessfulRun(`opencode-cli (${label})`, result);
        assert.ok(
          fs.existsSync(markerPath),
          `OpenCode did not call the allowed MCP tool\nstdout: ${result.stdout}`
        );
        assertNoWorkspaceConfig(tmpDir, ["opencode.json", ".opencode"]);
      });
    }

    for (const mode of ["headless", "interactive"] as const) {
      test(`completion plugin loads from an external file URL in ${mode} mode`, async function () {
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
            : await runInteractiveWorkflowFile(
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

    // `opencode run` quote-wraps a positional message containing a space and
    // escapes its inner quotes, so a headless prompt passed as an argument
    // reached the model as `"…\"C:\…\work space\notes.md\"…"`. ctrlyoke pipes
    // it on stdin instead, which OpenCode stores verbatim.
    test("delivers a headless prompt with quoted spaced paths verbatim", async function () {
      const workspace = path.join(tmpDir, "work space");
      fs.mkdirSync(workspace);
      const notesPath = path.join(workspace, "notes.md");
      fs.writeFileSync(notesPath, "The secret word is BANANA.\n");
      const restore = isolateRunState(tmpDir);
      let userText: string;
      try {
        const result = runWorkflowFile(
          {
            harness: OPENCODE,
            model: HARNESS_MODELS[OPENCODE],
            steps: [
              {
                name: "opencode-stdin-prompt",
                prompt:
                  'Read @notes.md and reply with only the secret word, or "none".',
              },
            ],
          },
          workspace,
          "opencode-stdin-prompt"
        );
        if (logAndMaybeSkip("opencode-cli (stdin prompt)", result)) return;
        assertSuccessfulRun("opencode-cli (stdin prompt)", result);
        const sessionId = readSingleRunSessionId(runsRootFor(workspace));
        userText = await readOpenCodeFirstUserText(sessionId, workspace);
      } finally {
        restore();
      }

      assert.ok(
        !userText.startsWith('"') && !userText.includes('\\"'),
        `OpenCode rewrote the prompt: ${userText}`
      );
      assert.match(
        userText,
        /"[^"]*work space[\\/]notes\.md"/,
        "the quoted file reference did not arrive intact"
      );
    });

    // The standalone CLI relaunches the TUI with `-s` for every step. OpenCode
    // ignores `--prompt` alongside `--session` (anomalyco/opencode#21829), so
    // without the plugin submitting the prompt, step 2 waits for input forever.
    test("runs the prompt of a resumed interactive step", async function () {
      const markerPath = normalizedPath(
        path.join(tmpDir, "opencode-resumed-marker.txt")
      );
      const result = await runInteractiveWorkflowFile(
        {
          harness: OPENCODE,
          model: HARNESS_MODELS[OPENCODE],
          executionMode: EXECUTION_MODES.INTERACTIVE,
          toolPermissions: { mode: "dangerouslyAllowAll" },
          resumeSession: true,
          steps: [
            {
              name: "opencode-first",
              prompt: "Reply with exactly: first-step",
            },
            {
              name: "opencode-resumed",
              prompt: `Use the shell tool to run: node -e \"require('fs').writeFileSync('${markerPath}','resumed')\"`,
            },
          ],
        },
        tmpDir,
        "opencode-resumed-interactive"
      );
      if (logAndMaybeSkip("opencode-cli resumed interactive", result)) return;
      assertSuccessfulRun("opencode-cli resumed interactive", result);
      assert.ok(
        fs.existsSync(markerPath),
        "the resumed step's prompt never ran"
      );
    });
  });

  suite(CODEX, function () {
    test("interactive completion uses inline hooks without .codex/hooks.json", async function () {
      const outputPath = path.join(tmpDir, "codex-inline-stop.jsonl");
      const result = await withIsolatedCodexHome([tmpDir], () =>
        runInteractiveWorkflowFile(
          codexHookWorkflow(
            [makeHook("stop", recorderScript, outputPath)],
            "Reply with exactly: codex-inline-complete",
            "interactive"
          ),
          tmpDir,
          "codex-inline-completion"
        )
      );
      if (logAndMaybeSkip("codex-cli (inline interactive)", result)) return;
      assertSuccessfulRun("codex-cli (inline interactive)", result);
      assert.ok(hasRecordedEvent(outputPath, "stop"));
      assertNoWorkspaceConfig(tmpDir, [".codex"]);
    });

    // Headless on purpose: since 0.156 interactive Codex will not start in an
    // untrusted folder at all (its trust dialog offers only "Trust" or
    // "Quit"), while `codex exec` still runs there with project config off.
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
      const result = runWorkflowFile(
        codexHookWorkflow(
          [makeHook("stop", recorderScript, outputPath)],
          "Reply with exactly: codex-untrusted-complete",
          "headless"
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

    test("preserves a user's .codex/hooks.json and still runs the user's hook", async function () {
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

      // A project's own .codex/hooks.json only runs in a trusted project, and
      // since 0.156 each of its hooks also needs a persisted trust decision
      // ("Hooks need review" dialog). The bypass flag stands in for that
      // one-time user approval so the test does not stall on the dialog.
      const result = await withIsolatedCodexHome([tmpDir], () =>
        runInteractiveWorkflowFile(
          {
            ...codexHookWorkflow(
              [],
              "Reply with exactly: codex-user-hook-complete",
              "interactive"
            ),
            additionalArgs: "--dangerously-bypass-hook-trust",
          },
          tmpDir,
          "codex-user-hook-preservation"
        )
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

  suite(QWEN, function () {
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
      test(`calls an inline MCP tool in ${mode} mode`, async function () {
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
          MCP_STARTUP_RETRY_INSTRUCTION,
        ].join(" ");
        const result =
          mode === EXECUTION_MODES.HEADLESS
            ? runWorkflowFile(
                qwenMcpWorkflow(server, prompt, mode),
                tmpDir,
                `qwen-mcp-${mode}`
              )
            : await runInteractiveWorkflowFile(
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

    test("connects to a streamable HTTP MCP server through httpUrl", async function () {
      const toolName = "record_remote_call";
      const markerPath = path.join(tmpDir, "qwen-http-mcp.calls");
      const server = await startStreamableHttpMcpServer(
        path.join(tmpDir, "qwen-http-mcp.js"),
        markerPath
      );
      try {
        const result = runWorkflowFile(
          qwenMcpWorkflow(
            {
              id: "qwen_http_server",
              url: server.url,
              transport: "streamable-http",
            },
            `Call mcp__qwen_http_server__${toolName} exactly once and do not call any other tool. ${MCP_STARTUP_RETRY_INSTRUCTION}`
          ),
          tmpDir,
          "qwen-http-mcp"
        );
        if (logAndMaybeSkip("qwen-cli (streamable HTTP MCP)", result)) return;
        assertSuccessfulRun("qwen-cli (streamable HTTP MCP)", result);
        assert.strictEqual(
          fs.existsSync(markerPath)
            ? fs.readFileSync(markerPath, "utf8").trim()
            : "missing",
          "called",
          `Qwen did not call the streamable HTTP tool. stdout: ${result.stdout}\nstderr: ${result.stderr}`
        );
      } finally {
        server.stop();
      }
    });

    test("passes a granted secret into a Qwen stdio MCP server", function () {
      const secret = "qwen-inline-secret-probe";
      const previousSecret = process.env.API_TOKEN;
      process.env.API_TOKEN = secret;
      const markerPath = path.join(tmpDir, "qwen-secret-mcp.calls");
      const server: McpServerConfig = {
        ...makeUserMcpServer(
          "qwen_secret_server",
          "qwen_secret_env_probe",
          mcpServerScript,
          markerPath,
          "API_TOKEN"
        ),
        env: { API_TOKEN: "${secret:API_TOKEN}" },
      };
      const workflow = qwenMcpWorkflow(
        server,
        `!API_TOKEN Call mcp__qwen_secret_server__qwen_secret_env_probe exactly once. Do not reveal the secret or use another tool. ${MCP_STARTUP_RETRY_INSTRUCTION}`
      );
      let result: ReturnType<typeof runWorkflowFile>;
      try {
        trustWorkflowSecretGrants(workflow, tmpDir, "qwen-secret-mcp");
        result = runWorkflowFile(workflow, tmpDir, "qwen-secret-mcp");
      } finally {
        if (previousSecret === undefined) delete process.env.API_TOKEN;
        else process.env.API_TOKEN = previousSecret;
      }
      if (logAndMaybeSkip("qwen-cli (secret-backed stdio MCP)", result)) return;
      assertSuccessfulRun("qwen-cli (secret-backed stdio MCP)", result);
      assert.strictEqual(fs.readFileSync(markerPath, "utf8").trim(), secret);
      assert.ok(!result.stdout.includes(secret));
      assert.ok(!result.stderr.includes(secret));
    });

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
          `Call mcp__qwen_no_settings_server__qwen_no_settings_probe exactly once and do not use any other tool. ${MCP_STARTUP_RETRY_INSTRUCTION}`
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
            `Call mcp__qwen_left_server__qwen_left_tool exactly once and do not call any other tool. ${MCP_STARTUP_RETRY_INSTRUCTION}`
          ),
          tmpDir,
          "qwen-concurrent-left"
        ),
        runWorkflowFileAsync(
          qwenMcpWorkflow(
            rightServer,
            `Call mcp__qwen_right_server__qwen_right_tool exactly once and do not call any other tool. ${MCP_STARTUP_RETRY_INSTRUCTION}`
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
      const markerPath = path.join(tmpDir, "qwen-permission-hook-marker.txt");
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
            // Qwen 0.24 auto-approves read-only shell commands such as `echo`
            // without asking, so the probe must write a file to need approval.
            prompt: `Run exactly one shell command: node -e "require('fs').writeFileSync('${normalizedPath(markerPath)}','hook-allowed')". Do not use any other tool.`,
          },
        ],
      };
      // The hook commands quote their paths. On Windows Qwen runs hooks through
      // `cmd.exe /d /s /c` unless it detects Git Bash (MSYSTEM, or an msys or
      // cygwin TERM), and that launch breaks quoted commands; ctrlyoke must
      // route them through its hook launcher. Hide Git Bash so the case proves
      // that path wherever the suite is started from.
      const gitBashEnv = {
        MSYSTEM: process.env.MSYSTEM,
        TERM: process.env.TERM,
      };
      delete process.env.MSYSTEM;
      if (/msys|cygwin/.test(process.env.TERM ?? "")) delete process.env.TERM;
      let result: ReturnType<typeof runWorkflowFile>;
      try {
        result = runWorkflowFile(workflow, tmpDir, "qwen-existing-hooks");
      } finally {
        for (const [name, value] of Object.entries(gitBashEnv)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      if (logAndMaybeSkip("qwen-cli (existing hooks)", result)) return;
      assertSuccessfulRun("qwen-cli (existing hooks)", result);
      assert.ok(hasRecordedEvent(outputPath, "sessionStart"));
      assert.ok(hasRecordedEvent(outputPath, "stop"));
      assert.ok(hasRecordedEvent(outputPath, "permissionRequest"));
      assert.ok(
        fs.existsSync(markerPath),
        "the permissionRequest hook's allow decision did not let the command run"
      );
    });

    // ctrlyoke's hooks reach Qwen through a per-launch system settings file
    // (QWEN_CODE_SYSTEM_SETTINGS_PATH). Qwen loads system, user and project
    // hooks as separate lists, so a user's own ~/.qwen/settings.json hooks must
    // still run beside ctrlyoke's, and ctrlyoke's Stop hook must still finish
    // the interactive step.
    test("hooks in the user's ~/.qwen/settings.json run beside ctrlyoke's in interactive mode", async function () {
      const outputPath = path.join(tmpDir, "qwen-user-scope-hooks.jsonl");
      // Qwen launches this one itself, so it stays unquoted (see the case above).
      const userHook = (event: string) => ({
        hooks: [
          {
            type: "command",
            command: `node ${normalizedPath(recorderScript)} ${event} ${normalizedPath(outputPath)}`,
          },
        ],
      });
      const workflow: PromptFile = {
        harness: QWEN,
        model: HARNESS_MODELS[QWEN],
        executionMode: EXECUTION_MODES.INTERACTIVE,
        steps: [{ name: "qwen-user-scope-hooks", prompt: "Reply with OK." }],
      };
      const result = await withIsolatedQwenHome(
        {
          UserPromptSubmit: [userHook("userPromptSubmit")],
          Stop: [userHook("stop")],
        },
        () =>
          runInteractiveWorkflowFile(workflow, tmpDir, "qwen-user-scope-hooks")
      );
      if (logAndMaybeSkip("qwen-cli (user-scope hooks)", result)) return;
      // Exit 0 means ctrlyoke's own Stop hook completed the interactive step.
      assertSuccessfulRun("qwen-cli (user-scope hooks)", result);
      assert.ok(
        hasRecordedEvent(outputPath, "userPromptSubmit"),
        "the user's UserPromptSubmit hook did not run"
      );
      assert.ok(
        hasRecordedEvent(outputPath, "stop"),
        "the user's Stop hook did not run"
      );
    });
  });

  // ctrlyoke's tool lists reach agy as a per-run `--settings` file of
  // `command(regex:…)`, `mcp(server/tool)` and file rules
  // (dev/implemented/ANTIGRAVITY_PERMISSION_RULES_PLAN.md). agy matches a command
  // rule against the raw, unsplit command line, so the chain and multi-line
  // cases prove the generated allow/deny regexes, not just agy's matching.
  suite(ANTIGRAVITY, function () {
    let markerScript: string;

    setup(function () {
      markerScript = path.join(tmpDir, "agy-marker.js");
      fs.writeFileSync(markerScript, MARKER_SCRIPT);
    });

    const plain = (script: string, marker: string) => [
      `node ${script} ${marker}`,
    ];
    const chained = (script: string, marker: string) => [
      `echo agy-chain && node ${script} ${marker}`,
    ];
    const twoLines = (script: string, marker: string) => [
      "echo agy-first-line",
      `node ${script} ${marker}`,
    ];

    for (const shellCase of [
      {
        name: "allow proceeds",
        permissions: {
          mode: "custom",
          allowedTools: ["shell(node:*)"],
          deniedTools: ANTIGRAVITY_NO_WRITE_FALLBACK,
        } satisfies ToolPermissionsOverride,
        command: plain,
        shouldCreate: true,
      },
      {
        name: "deny blocks a command a broad allow would run",
        permissions: {
          mode: "custom",
          allowedTools: ["shell"],
          deniedTools: ["shell(node:*)", ...ANTIGRAVITY_NO_WRITE_FALLBACK],
        } satisfies ToolPermissionsOverride,
        command: plain,
        shouldCreate: false,
      },
      {
        name: "deny wins over allow",
        permissions: {
          mode: "custom",
          allowedTools: ["shell(node:*)"],
          deniedTools: ["shell(node:*)", ...ANTIGRAVITY_NO_WRITE_FALLBACK],
        } satisfies ToolPermissionsOverride,
        command: plain,
        shouldCreate: false,
      },
      {
        name: "deny blocks a denied command chained after echo",
        permissions: {
          mode: "custom",
          allowedTools: ["shell"],
          deniedTools: ["shell(node:*)", ...ANTIGRAVITY_NO_WRITE_FALLBACK],
        } satisfies ToolPermissionsOverride,
        command: chained,
        shouldCreate: false,
      },
      {
        name: "deny blocks a denied command on the second line",
        permissions: {
          mode: "custom",
          allowedTools: ["shell"],
          deniedTools: ["shell(node:*)", ...ANTIGRAVITY_NO_WRITE_FALLBACK],
        } satisfies ToolPermissionsOverride,
        command: twoLines,
        shouldCreate: false,
      },
      {
        name: "an allowed command does not allow an unlisted one chained to it",
        permissions: {
          mode: "custom",
          allowedTools: ["shell(echo:*)"],
          deniedTools: ANTIGRAVITY_NO_WRITE_FALLBACK,
        } satisfies ToolPermissionsOverride,
        command: chained,
        shouldCreate: false,
      },
      {
        name: "allowAll runs a shell command without asking",
        permissions: {
          mode: "allowAll",
          deniedTools: ANTIGRAVITY_NO_WRITE_FALLBACK,
        } satisfies ToolPermissionsOverride,
        command: plain,
        shouldCreate: true,
      },
      {
        name: "allowAll still refuses a denied command",
        permissions: {
          mode: "allowAll",
          deniedTools: ["shell(node:*)", ...ANTIGRAVITY_NO_WRITE_FALLBACK],
        } satisfies ToolPermissionsOverride,
        command: plain,
        shouldCreate: false,
      },
    ]) {
      test(`${ANTIGRAVITY}: ${shellCase.name}`, function () {
        const slug = shellCase.name.replace(/[^a-z]+/gi, "-").toLowerCase();
        const markerName = `agy-${slug}.txt`;
        const markerPath = path.join(tmpDir, markerName);
        const { result, toolEvents } = runAntigravityProbe(
          antigravityShellWorkflow(
            `agy-${slug}`,
            shellCase.permissions,
            shellCase.command(
              normalizedPath(markerScript),
              normalizedPath(markerPath)
            )
          ),
          tmpDir,
          `agy-${slug}`
        );
        if (logAndMaybeSkip(`${ANTIGRAVITY} (${shellCase.name})`, result))
          return;
        assertSuccessfulRun(`${ANTIGRAVITY} (${shellCase.name})`, result);
        assert.ok(
          toolEvents.includes(markerName),
          `agy never attempted the command, so the case proves nothing\nstdout: ${result.stdout}`
        );
        assert.strictEqual(
          toolEvents.includes(AGY_PROBE_RAN),
          shellCase.shouldCreate,
          `command ${shellCase.shouldCreate ? "was refused" : "ran"}\ntool events: ${toolEvents}`
        );
        // No mode sandboxes the command, so an allowed one can write the
        // workspace; this also guards against `custom` regaining --sandbox.
        assert.strictEqual(
          fs.existsSync(markerPath),
          shellCase.shouldCreate,
          `marker ${shellCase.shouldCreate ? "missing" : "created"}\ntool events: ${toolEvents}`
        );
      });
    }

    test(`${ANTIGRAVITY}: deny survives a conflicting user settings.json allow`, async function () {
      const markerName = "agy-user-conflict.txt";
      const markerPath = path.join(tmpDir, markerName);
      const userSettings = { permissions: { allow: ["command(*)"] } };
      await withIsolatedAntigravityHome(userSettings, (settingsPath) => {
        const { result, toolEvents } = runAntigravityProbe(
          antigravityShellWorkflow(
            "agy-user-conflict",
            {
              mode: "custom",
              allowedTools: [],
              deniedTools: ["shell(node:*)", ...ANTIGRAVITY_NO_WRITE_FALLBACK],
            },
            plain(normalizedPath(markerScript), normalizedPath(markerPath))
          ),
          tmpDir,
          "agy-user-conflict"
        );
        if (logAndMaybeSkip(`${ANTIGRAVITY} (user conflict)`, result)) return;
        assertSuccessfulRun(`${ANTIGRAVITY} (user conflict)`, result);
        assert.ok(
          toolEvents.includes(markerName),
          `agy never attempted the command\nstdout: ${result.stdout}`
        );
        assert.ok(
          !toolEvents.includes(AGY_PROBE_RAN) && !fs.existsSync(markerPath),
          `the user's allow overrode the workflow deny\ntool events: ${toolEvents}`
        );
        const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
          permissions?: unknown;
        };
        assert.deepStrictEqual(
          after.permissions,
          userSettings.permissions,
          "the injected rules leaked into the user's settings.json"
        );
      });
    });

    for (const allowCase of [
      { name: "exact tool", allowedTool: "mcp__agy-probe__probe_tool" },
      { name: "whole server", allowedTool: "mcp__agy-probe" },
      { name: "server wildcard", allowedTool: "mcp__agy-probe__*" },
    ]) {
      test(`${ANTIGRAVITY}: calls an MCP tool allowed by a ${allowCase.name} pattern`, function () {
        const markerPath = path.join(tmpDir, "agy-allowed-mcp.calls");
        const slug = `agy-mcp-${allowCase.name.replace(/ /g, "-")}`;
        const { result, toolEvents } = runAntigravityProbe(
          antigravityMcpWorkflow(
            slug,
            {
              mode: "custom",
              allowedTools: [allowCase.allowedTool],
              deniedTools: ["shell", ...ANTIGRAVITY_NO_WRITE_FALLBACK],
            },
            makeUserMcpServer(
              "agy-probe",
              "probe_tool",
              normalizedPath(mcpServerScript),
              normalizedPath(markerPath)
            ),
            "probe_tool"
          ),
          tmpDir,
          slug
        );
        if (logAndMaybeSkip(`${ANTIGRAVITY} (${slug})`, result)) return;
        assertSuccessfulRun(`${ANTIGRAVITY} (${slug})`, result);
        assert.ok(
          fs.existsSync(markerPath),
          `agy did not call the allowed MCP tool\ntool events: ${toolEvents}`
        );
      });
    }

    test(`${ANTIGRAVITY}: calls an allowed tool on a dotted MCP server id`, function () {
      const markerPath = path.join(tmpDir, "agy-dotted-allowed.calls");
      const { result, toolEvents } = runAntigravityProbe(
        antigravityMcpWorkflow(
          "agy-dotted-allowed",
          {
            mode: "custom",
            allowedTools: ["mcp__agy.probe-server__allowed_probe"],
            deniedTools: ["shell", ...ANTIGRAVITY_NO_WRITE_FALLBACK],
          },
          makeUserMcpServer(
            "agy.probe-server",
            "allowed_probe",
            normalizedPath(mcpServerScript),
            normalizedPath(markerPath)
          ),
          "allowed_probe"
        ),
        tmpDir,
        "agy-dotted-allowed"
      );
      if (logAndMaybeSkip(`${ANTIGRAVITY} (dotted allowed)`, result)) return;
      assertSuccessfulRun(`${ANTIGRAVITY} (dotted allowed)`, result);
      assert.strictEqual(
        fs.existsSync(markerPath)
          ? fs.readFileSync(markerPath, "utf8").trim()
          : "missing",
        "allowed_probe",
        `tool events: ${toolEvents}`
      );
    });

    test(`${ANTIGRAVITY}: refuses a server-denied tool on a dotted MCP server id`, function () {
      const markerPath = path.join(tmpDir, "agy-dotted-denied.calls");
      const server = makeUserMcpServer(
        "agy.probe-server",
        "allowed_probe,blocked_probe",
        normalizedPath(mcpServerScript),
        normalizedPath(markerPath)
      );
      server.deniedTools = ["blocked_probe"];
      const { result, toolEvents } = runAntigravityProbe(
        antigravityMcpWorkflow(
          "agy-dotted-denied",
          {
            mode: "allowAll",
            deniedTools: ["shell", ...ANTIGRAVITY_NO_WRITE_FALLBACK],
          },
          server,
          "blocked_probe"
        ),
        tmpDir,
        "agy-dotted-denied"
      );
      if (logAndMaybeSkip(`${ANTIGRAVITY} (dotted denied)`, result)) return;
      assertSuccessfulRun(`${ANTIGRAVITY} (dotted denied)`, result);
      assert.ok(
        !fs.existsSync(markerPath),
        `agy called the server-denied MCP tool\ntool events: ${toolEvents}`
      );
      assert.ok(
        toolEvents.includes("blocked_probe"),
        `agy never attempted the denied MCP tool\nstdout: ${result.stdout}`
      );
    });
  });
});
