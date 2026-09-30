import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { parse } from "smol-toml";
import { CliMcpConfigGenerator } from "../../core/harness/shared/CliMcpConfigGenerator";
import type { McpServerConfig } from "../../types/CtrlYokeTypes";

suite("CliMcpConfigGenerator", () => {
  // ──────────────────────────────────────────────────────────────────────────
  suite("generateJsonConfig", () => {
    test("writes provider references instead of secret values in env and headers", () => {
      const server: McpServerConfig = {
        id: "remote",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer ${secret:API_TOKEN}" },
      };
      const json = CliMcpConfigGenerator.generateUserServersOnlyConfig(
        [server],
        undefined,
        {
          mode: "reference",
          referenceToken: (name) => `\${${name}}`,
        }
      );
      const config = JSON.parse(json);
      assert.strictEqual(
        config.mcpServers.remote.headers.Authorization,
        "Bearer ${API_TOKEN}"
      );
      assert.ok(!json.includes("secret-value"));
    });

    test("substitutes non-expanding values without leaving the reference", () => {
      const server: McpServerConfig = {
        id: "local",
        command: "node",
        env: { API_TOKEN: "${secret:API_TOKEN}" },
      };
      const json = CliMcpConfigGenerator.generateUserServersOnlyConfig(
        [server],
        undefined,
        { mode: "substitute", resolvedValues: { API_TOKEN: "secret-value" } }
      );
      const config = JSON.parse(json);
      assert.strictEqual(config.mcpServers.local.env.API_TOKEN, "secret-value");
      assert.ok(!json.includes("${secret:API_TOKEN}"));
    });

    test("produces valid JSON string", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace/root"
      );
      assert.doesNotThrow(() => JSON.parse(json));
    });

    test("includes mcpServers.ctrlyoke with node command", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace/root"
      );
      const config = JSON.parse(json);
      assert.ok(config.mcpServers);
      assert.ok(config.mcpServers.ctrlyoke);
      assert.strictEqual(config.mcpServers.ctrlyoke.command, "node");
    });

    test("server path is included in args array", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace/root"
      );
      const config = JSON.parse(json);
      assert.deepStrictEqual(config.mcpServers.ctrlyoke.args, [
        "out/mcp-server.js",
      ]);
    });

    test("CTRLYOKE_WORKSPACE env var is set to workspaceRoot", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace/root"
      );
      const config = JSON.parse(json);
      assert.strictEqual(
        config.mcpServers.ctrlyoke.env.CTRLYOKE_WORKSPACE,
        "/workspace/root"
      );
    });

    test("sets execution root separately from the state workspace root", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "C:\\checkout\\root",
        undefined,
        undefined,
        undefined,
        "C:\\state\\root"
      );
      const config = JSON.parse(json);
      assert.strictEqual(
        config.mcpServers.ctrlyoke.env.CTRLYOKE_WORKSPACE,
        "C:/state/root"
      );
      assert.strictEqual(
        config.mcpServers.ctrlyoke.env.CTRLYOKE_EXECUTION_ROOT,
        "C:/checkout/root"
      );
    });

    test("normalizes Windows backslashes to forward slashes in serverPath", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out\\mcp-server.js",
        "C:\\workspace\\root"
      );
      const config = JSON.parse(json);
      assert.strictEqual(
        config.mcpServers.ctrlyoke.args[0],
        "out/mcp-server.js"
      );
      assert.strictEqual(
        config.mcpServers.ctrlyoke.env.CTRLYOKE_WORKSPACE,
        "C:/workspace/root"
      );
    });

    test("includes CTRLYOKE_WORKING_FILE when workingFilePath provided", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace",
        undefined,
        "/workspace/.ctrlyoke/.runs/active/run-2026-01-01T00-00-00-000Z/workflow.ctrlyoke.json"
      );
      const config = JSON.parse(json);
      assert.strictEqual(
        config.mcpServers.ctrlyoke.env.CTRLYOKE_WORKING_FILE,
        "/workspace/.ctrlyoke/.runs/active/run-2026-01-01T00-00-00-000Z/workflow.ctrlyoke.json"
      );
    });

    test("does not include CTRLYOKE_WORKING_FILE when not provided", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace"
      );
      const config = JSON.parse(json);
      assert.strictEqual(
        config.mcpServers.ctrlyoke.env.CTRLYOKE_WORKING_FILE,
        undefined
      );
    });

    test("normalizes Windows backslashes in workingFilePath", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace",
        undefined,
        "C:\\workspace\\.ctrlyoke\\active.yaml"
      );
      const config = JSON.parse(json);
      assert.strictEqual(
        config.mcpServers.ctrlyoke.env.CTRLYOKE_WORKING_FILE,
        "C:/workspace/.ctrlyoke/active.yaml"
      );
    });

    test("includes serverConfig.type when provided", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace",
        { type: "stdio" }
      );
      const config = JSON.parse(json);
      assert.strictEqual(config.mcpServers.ctrlyoke.type, "stdio");
    });

    test("includes serverConfig.tools when provided", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace",
        { tools: ["*"] }
      );
      const config = JSON.parse(json);
      assert.deepStrictEqual(config.mcpServers.ctrlyoke.tools, ["*"]);
    });

    test("does not include type/tools when serverConfig not provided", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace"
      );
      const config = JSON.parse(json);
      assert.strictEqual(config.mcpServers.ctrlyoke.type, undefined);
      assert.strictEqual(config.mcpServers.ctrlyoke.tools, undefined);
    });

    test("includes additionalEnv variables", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace",
        undefined,
        undefined,
        { MY_VAR: "my_value", OTHER_VAR: "other_value" }
      );
      const config = JSON.parse(json);
      assert.strictEqual(config.mcpServers.ctrlyoke.env.MY_VAR, "my_value");
      assert.strictEqual(
        config.mcpServers.ctrlyoke.env.OTHER_VAR,
        "other_value"
      );
    });

    test("separates execution config placement from state-root MCP variables", () => {
      const executionRoot = path.join(os.tmpdir(), "execution-root");
      const stateRoot = path.join(os.tmpdir(), "state-root");
      const workingFile = path.join(stateRoot, "workflow.ctrlyoke.json");
      const config = JSON.parse(
        CliMcpConfigGenerator.generateJsonConfig(
          "server.js",
          executionRoot,
          undefined,
          workingFile,
          undefined,
          stateRoot
        )
      );

      assert.strictEqual(
        CliMcpConfigGenerator.getConfigFilePath(
          workingFile,
          executionRoot,
          "mcp-config"
        ),
        path.join(
          executionRoot,
          ".ctrlyoke",
          "temp",
          "mcp-config-workflow.json"
        )
      );
      assert.strictEqual(
        config.mcpServers.ctrlyoke.env.CTRLYOKE_WORKSPACE,
        stateRoot.replace(/\\/g, "/")
      );
      assert.strictEqual(
        config.mcpServers.ctrlyoke.env.CTRLYOKE_WORKING_FILE,
        workingFile.replace(/\\/g, "/")
      );
    });

    test("restrictive MCP artifacts are deleted by their cleanup mutation", async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-mcp-secret-artifact-")
      );
      const filePath = path.join(root, "mcp-config.json");
      const mutation = CliMcpConfigGenerator.createFileMutation(
        filePath,
        '{"secret":"secret-value"}',
        "Write secret MCP configuration",
        { restrictivePermissions: true }
      );

      try {
        await mutation.apply();
        assert.strictEqual(
          await fs.readFile(filePath, "utf8"),
          '{"secret":"secret-value"}'
        );
        if (process.platform !== "win32") {
          assert.strictEqual((await fs.stat(filePath)).mode & 0o777, 0o600);
        }
        await mutation.restore?.();
        await assert.rejects(fs.access(filePath));
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("generateInlineTomlConfig", () => {
    test("starts with correct mcp_servers prefix", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "ctrlyoke",
        "out/mcp-server.js",
        "/workspace"
      );
      assert.ok(toml.startsWith("mcp_servers.ctrlyoke="));
    });

    test("includes command=node", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "ctrlyoke",
        "out/mcp-server.js",
        "/workspace"
      );
      assert.ok(toml.includes('command="node"'));
    });

    test("includes server path in args", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "ctrlyoke",
        "out/mcp-server.js",
        "/workspace"
      );
      assert.ok(toml.includes('args=["out/mcp-server.js"]'));
    });

    test("includes CTRLYOKE_WORKSPACE in env", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "ctrlyoke",
        "out/mcp-server.js",
        "/workspace/root"
      );
      assert.ok(toml.includes('CTRLYOKE_WORKSPACE="/workspace/root"'));
    });

    test("normalizes Windows backslashes to forward slashes in serverPath", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "ctrlyoke",
        "out\\mcp-server.js",
        "C:\\workspace\\root"
      );
      assert.ok(toml.includes('args=["out/mcp-server.js"]'));
      assert.ok(toml.includes('CTRLYOKE_WORKSPACE="C:/workspace/root"'));
    });

    test("includes CTRLYOKE_WORKING_FILE in env when provided", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "ctrlyoke",
        "out/mcp-server.js",
        "/workspace",
        "/workspace/.ctrlyoke/.runs/active/run-2026-01-01T00-00-00-000Z/workflow.ctrlyoke.json"
      );
      assert.ok(
        toml.includes(
          'CTRLYOKE_WORKING_FILE="/workspace/.ctrlyoke/.runs/active/run-2026-01-01T00-00-00-000Z/workflow.ctrlyoke.json"'
        )
      );
    });

    test("does not include CTRLYOKE_WORKING_FILE when not provided", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "ctrlyoke",
        "out/mcp-server.js",
        "/workspace"
      );
      assert.ok(!toml.includes("CTRLYOKE_WORKING_FILE"));
    });

    test("normalizes Windows backslashes in workingFilePath", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "ctrlyoke",
        "out/mcp-server.js",
        "/workspace",
        "C:\\workspace\\.ctrlyoke\\active.yaml"
      );
      assert.ok(
        toml.includes(
          'CTRLYOKE_WORKING_FILE="C:/workspace/.ctrlyoke/active.yaml"'
        )
      );
    });

    test("uses custom server name", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "myserver",
        "out/mcp-server.js",
        "/workspace"
      );
      assert.ok(toml.startsWith("mcp_servers.myserver="));
    });

    test("includes additional env variables", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "ctrlyoke",
        "out/mcp-server.js",
        "/workspace",
        undefined,
        { MY_VAR: "my_value" }
      );
      assert.ok(toml.includes('MY_VAR="my_value"'));
    });

    test("uses the state root for exported MCP variables", () => {
      const executionRoot = path.join(os.tmpdir(), "execution-root");
      const stateRoot = path.join(os.tmpdir(), "state-root");
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "ctrlyoke",
        path.join(executionRoot, "server.js"),
        executionRoot,
        path.join(stateRoot, "workflow.json"),
        undefined,
        stateRoot
      );

      const normalizedStateRoot = stateRoot.replace(/\\/g, "/");
      const normalizedWorkingFile = path
        .join(stateRoot, "workflow.json")
        .replace(/\\/g, "/");
      assert.ok(toml.includes(`CTRLYOKE_WORKSPACE="${normalizedStateRoot}"`));
      assert.ok(
        toml.includes(`CTRLYOKE_WORKING_FILE="${normalizedWorkingFile}"`)
      );
    });

    test("round-trips special strings in inline TOML basic strings", () => {
      const workspaceRoot = String.raw`C:\Users\O'Brien\proj`;
      const command = `worker's "cli"\\path\n雪`;
      const args = [
        `O'Brien`,
        `say "hello"`,
        String.raw`\\d+`,
        "line\none",
        "雪☃",
      ];
      const env = {
        QUOTED: `it's a "value"`,
        BACKSLASHES: String.raw`CORP\alice\d+`,
        MULTILINE: "first\nsecond",
        UNICODE: "café 雪",
      };
      const toml = CliMcpConfigGenerator.generateInlineTomlStdioServerConfig(
        "worker",
        command,
        args,
        env
      );
      const parsed = parse(toml) as {
        mcp_servers: {
          worker: {
            command: string;
            args: string[];
            env: Record<string, string>;
          };
        };
      };

      assert.strictEqual(parsed.mcp_servers.worker.command, command);
      assert.deepStrictEqual(parsed.mcp_servers.worker.args, args);
      assert.deepStrictEqual({ ...parsed.mcp_servers.worker.env }, env);

      const ctrlyokeToml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "ctrlyoke",
        "out/mcp-server.js",
        workspaceRoot
      );
      const ctrlyokeParsed = parse(ctrlyokeToml) as {
        mcp_servers: { ctrlyoke: { env: Record<string, string> } };
      };
      assert.strictEqual(
        ctrlyokeParsed.mcp_servers.ctrlyoke.env.CTRLYOKE_WORKSPACE,
        "C:/Users/O'Brien/proj"
      );
    });
  });
});
