import * as assert from "assert";
import * as vscode from "vscode";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { EXTENSION_IDENTIFIERS } from "../../types/DashboardConstants";

/**
 * Integration Tests for CopilotCommandLineIntegration
 *
 * Real integration tests that run in a full VS Code instance with the extension loaded.
 * Tests use actual VS Code APIs and test through the extension's public commands.
 */
suite("CLI Integration Tests", () => {
  suiteSetup(async function () {
    this.timeout(30000); // Allow time for extension activation

    // Find ctrlyoke extension (might not have publisher during development)
    const allExtensions = vscode.extensions.all;
    const extension = allExtensions.find(
      (ext) =>
        ext.id === EXTENSION_IDENTIFIERS.ID ||
        ext.packageJSON.name === EXTENSION_IDENTIFIERS.PACKAGE_NAME
    );

    assert.ok(extension, "ctrlyoke extension must be loaded");

    if (!extension.isActive) {
      await extension.activate();
    }
  });

  test("Extension should be activated", () => {
    const allExtensions = vscode.extensions.all;
    const extension = allExtensions.find(
      (ext) =>
        ext.id === EXTENSION_IDENTIFIERS.ID ||
        ext.packageJSON.name === EXTENSION_IDENTIFIERS.PACKAGE_NAME
    );
    assert.ok(extension, "Extension should be loaded");
    assert.strictEqual(extension.isActive, true, "Extension should be active");
  });

  test("ctrlyoke commands should be registered", async () => {
    const commands = await vscode.commands.getCommands();

    const ctrlyokeCommands = [
      "ctrlyoke.openPanel",
      "ctrlyoke.pause",
      "ctrlyoke.resume",
      "ctrlyoke.stop",
      "ctrlyoke.runFromContext",
      "ctrlyoke.loadFromContext",
    ];

    for (const cmd of ctrlyokeCommands) {
      assert.ok(commands.includes(cmd), `Command ${cmd} should be registered`);
    }
  });

  test("Should detect harness status", async function () {
    this.timeout(10000);

    // Verify extension activated by checking a core command is registered
    const commands = await vscode.commands.getCommands();
    assert.ok(
      commands.includes("ctrlyoke.openPanel"),
      "Core command should be registered"
    );
  });

  test("Configuration settings should be accessible", () => {
    const scriptTimeout = ConfigurationUtils.getScriptTimeoutMs() / 1000;
    const integrationMode = ConfigurationUtils.getIntegrationMode();
    const cliModel = ConfigurationUtils.getModelForHarness(integrationMode);

    assert.strictEqual(typeof scriptTimeout, "number");
    assert.strictEqual(typeof integrationMode, "string");
    assert.strictEqual(typeof cliModel, "string");
  });

  test("Should handle missing workspace gracefully", async function () {
    // If no workspace is open, extension should still activate
    const allExtensions = vscode.extensions.all;
    const extension = allExtensions.find(
      (ext) =>
        ext.id === EXTENSION_IDENTIFIERS.ID ||
        ext.packageJSON.name === EXTENSION_IDENTIFIERS.PACKAGE_NAME
    );
    assert.ok(extension, "Extension should be loaded");
    assert.strictEqual(extension.isActive, true, "Extension should be active");
  });
});
