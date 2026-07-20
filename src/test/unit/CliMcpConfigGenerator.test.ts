import * as assert from "assert";
import { suite, test } from "mocha";
import { CliMcpConfigGenerator } from "../../core/harness/shared/CliMcpConfigGenerator";

suite("CliMcpConfigGenerator", () => {
  // ──────────────────────────────────────────────────────────────────────────
  suite("generateJsonConfig", () => {
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
      assert.ok(toml.includes("command='node'"));
    });

    test("includes server path in args", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "ctrlyoke",
        "out/mcp-server.js",
        "/workspace"
      );
      assert.ok(toml.includes("args=['out/mcp-server.js']"));
    });

    test("includes CTRLYOKE_WORKSPACE in env", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "ctrlyoke",
        "out/mcp-server.js",
        "/workspace/root"
      );
      assert.ok(toml.includes("CTRLYOKE_WORKSPACE='/workspace/root'"));
    });

    test("normalizes Windows backslashes to forward slashes in serverPath", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "ctrlyoke",
        "out\\mcp-server.js",
        "C:\\workspace\\root"
      );
      assert.ok(toml.includes("args=['out/mcp-server.js']"));
      assert.ok(toml.includes("CTRLYOKE_WORKSPACE='C:/workspace/root'"));
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
          "CTRLYOKE_WORKING_FILE='/workspace/.ctrlyoke/.runs/active/run-2026-01-01T00-00-00-000Z/workflow.ctrlyoke.json'"
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
          "CTRLYOKE_WORKING_FILE='C:/workspace/.ctrlyoke/active.yaml'"
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
      assert.ok(toml.includes("MY_VAR='my_value'"));
    });
  });
});
