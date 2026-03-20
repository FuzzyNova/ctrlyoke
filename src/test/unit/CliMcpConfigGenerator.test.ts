import * as assert from "assert";
import { suite, test } from "mocha";
import { CliMcpConfigGenerator } from "../../flightpath/harness/shared/CliMcpConfigGenerator";

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

    test("includes mcpServers.flightpath with node command", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace/root"
      );
      const config = JSON.parse(json);
      assert.ok(config.mcpServers);
      assert.ok(config.mcpServers.flightpath);
      assert.strictEqual(config.mcpServers.flightpath.command, "node");
    });

    test("server path is included in args array", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace/root"
      );
      const config = JSON.parse(json);
      assert.deepStrictEqual(config.mcpServers.flightpath.args, [
        "out/mcp-server.js",
      ]);
    });

    test("FLIGHTPATH_WORKSPACE env var is set to workspaceRoot", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace/root"
      );
      const config = JSON.parse(json);
      assert.strictEqual(
        config.mcpServers.flightpath.env.FLIGHTPATH_WORKSPACE,
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
        config.mcpServers.flightpath.args[0],
        "out/mcp-server.js"
      );
      assert.strictEqual(
        config.mcpServers.flightpath.env.FLIGHTPATH_WORKSPACE,
        "C:/workspace/root"
      );
    });

    test("includes FLIGHTPATH_WORKING_FILE when workingFilePath provided", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace",
        undefined,
        "/workspace/.flightpath/.queue/active.yaml"
      );
      const config = JSON.parse(json);
      assert.strictEqual(
        config.mcpServers.flightpath.env.FLIGHTPATH_WORKING_FILE,
        "/workspace/.flightpath/.queue/active.yaml"
      );
    });

    test("does not include FLIGHTPATH_WORKING_FILE when not provided", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace"
      );
      const config = JSON.parse(json);
      assert.strictEqual(
        config.mcpServers.flightpath.env.FLIGHTPATH_WORKING_FILE,
        undefined
      );
    });

    test("normalizes Windows backslashes in workingFilePath", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace",
        undefined,
        "C:\\workspace\\.flightpath\\active.yaml"
      );
      const config = JSON.parse(json);
      assert.strictEqual(
        config.mcpServers.flightpath.env.FLIGHTPATH_WORKING_FILE,
        "C:/workspace/.flightpath/active.yaml"
      );
    });

    test("includes serverConfig.type when provided", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace",
        { type: "stdio" }
      );
      const config = JSON.parse(json);
      assert.strictEqual(config.mcpServers.flightpath.type, "stdio");
    });

    test("includes serverConfig.tools when provided", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace",
        { tools: ["*"] }
      );
      const config = JSON.parse(json);
      assert.deepStrictEqual(config.mcpServers.flightpath.tools, ["*"]);
    });

    test("does not include type/tools when serverConfig not provided", () => {
      const json = CliMcpConfigGenerator.generateJsonConfig(
        "out/mcp-server.js",
        "/workspace"
      );
      const config = JSON.parse(json);
      assert.strictEqual(config.mcpServers.flightpath.type, undefined);
      assert.strictEqual(config.mcpServers.flightpath.tools, undefined);
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
      assert.strictEqual(config.mcpServers.flightpath.env.MY_VAR, "my_value");
      assert.strictEqual(
        config.mcpServers.flightpath.env.OTHER_VAR,
        "other_value"
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("generateInlineTomlConfig", () => {
    test("starts with correct mcp_servers prefix", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "flightpath",
        "out/mcp-server.js",
        "/workspace"
      );
      assert.ok(toml.startsWith("mcp_servers.flightpath="));
    });

    test("includes command=node", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "flightpath",
        "out/mcp-server.js",
        "/workspace"
      );
      assert.ok(toml.includes("command='node'"));
    });

    test("includes server path in args", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "flightpath",
        "out/mcp-server.js",
        "/workspace"
      );
      assert.ok(toml.includes("args=['out/mcp-server.js']"));
    });

    test("includes FLIGHTPATH_WORKSPACE in env", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "flightpath",
        "out/mcp-server.js",
        "/workspace/root"
      );
      assert.ok(toml.includes("FLIGHTPATH_WORKSPACE='/workspace/root'"));
    });

    test("normalizes Windows backslashes to forward slashes in serverPath", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "flightpath",
        "out\\mcp-server.js",
        "C:\\workspace\\root"
      );
      assert.ok(toml.includes("args=['out/mcp-server.js']"));
      assert.ok(toml.includes("FLIGHTPATH_WORKSPACE='C:/workspace/root'"));
    });

    test("includes FLIGHTPATH_WORKING_FILE in env when provided", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "flightpath",
        "out/mcp-server.js",
        "/workspace",
        "/workspace/.flightpath/.queue/active.yaml"
      );
      assert.ok(
        toml.includes(
          "FLIGHTPATH_WORKING_FILE='/workspace/.flightpath/.queue/active.yaml'"
        )
      );
    });

    test("does not include FLIGHTPATH_WORKING_FILE when not provided", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "flightpath",
        "out/mcp-server.js",
        "/workspace"
      );
      assert.ok(!toml.includes("FLIGHTPATH_WORKING_FILE"));
    });

    test("normalizes Windows backslashes in workingFilePath", () => {
      const toml = CliMcpConfigGenerator.generateInlineTomlConfig(
        "flightpath",
        "out/mcp-server.js",
        "/workspace",
        "C:\\workspace\\.flightpath\\active.yaml"
      );
      assert.ok(
        toml.includes(
          "FLIGHTPATH_WORKING_FILE='C:/workspace/.flightpath/active.yaml'"
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
        "flightpath",
        "out/mcp-server.js",
        "/workspace",
        undefined,
        { MY_VAR: "my_value" }
      );
      assert.ok(toml.includes("MY_VAR='my_value'"));
    });
  });
});
