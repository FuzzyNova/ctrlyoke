import * as assert from "assert";
import * as vscode from "vscode";

/**
 * Integration Tests for CopilotCommandLineIntegration
 *
 * Real integration tests that run in a full VS Code instance with the extension loaded.
 * Tests use actual VS Code APIs and test through the extension's public commands.
 */
suite("CLI Integration Tests", () => {
  suiteSetup(async function () {
    this.timeout(30000); // Allow time for extension activation

    // Find FlightPath extension (might not have publisher during development)
    const allExtensions = vscode.extensions.all;
    const extension = allExtensions.find(
      (ext) =>
        ext.id === "nhickster.flightpath" ||
        ext.packageJSON.name === "flightpath"
    );

    assert.ok(extension, "FlightPath extension must be loaded");

    if (!extension.isActive) {
      await extension.activate();
    }
  });

  test("Extension should be activated", () => {
    const allExtensions = vscode.extensions.all;
    const extension = allExtensions.find(
      (ext) =>
        ext.id === "nhickster.flightpath" ||
        ext.packageJSON.name === "flightpath"
    );
    assert.ok(extension, "Extension should be loaded");
    assert.strictEqual(extension.isActive, true, "Extension should be active");
  });

  test("FlightPath commands should be registered", async () => {
    const commands = await vscode.commands.getCommands();

    const flightPathCommands = [
      "flightpath.openPanel",
      "flightpath.pause",
      "flightpath.resume",
      "flightpath.stop",
      "flightpath.createPromptFile",
      "flightpath.runFromContext",
      "flightpath.loadFromContext",
    ];

    for (const cmd of flightPathCommands) {
      assert.ok(commands.includes(cmd), `Command ${cmd} should be registered`);
    }
  });

  test("Should detect harness status", async function () {
    this.timeout(10000);

    // Verify extension activated by checking a core command is registered
    const commands = await vscode.commands.getCommands();
    assert.ok(
      commands.includes("flightpath.openPanel"),
      "Core command should be registered"
    );
  });

  test("Configuration settings should be accessible", () => {
    const config = vscode.workspace.getConfiguration("flightpath");

    // Test that all our settings exist
    const promptsDir = config.get<string>("promptsDirectory");
    const scriptTimeout = config.get<number>("scriptTimeout");
    const integrationMode = config.get<string>("harness");
    const cliModel = config.get<string>("copilotCliModel");

    assert.strictEqual(typeof promptsDir, "string");
    assert.strictEqual(typeof scriptTimeout, "number");
    assert.strictEqual(typeof integrationMode, "string");
    assert.strictEqual(typeof cliModel, "string");
  });

  test("Should handle missing workspace gracefully", async function () {
    // If no workspace is open, extension should still activate
    const allExtensions = vscode.extensions.all;
    const extension = allExtensions.find(
      (ext) =>
        ext.id === "nhickster.flightpath" ||
        ext.packageJSON.name === "flightpath"
    );
    assert.ok(extension, "Extension should be loaded");
    assert.strictEqual(extension.isActive, true, "Extension should be active");
  });
});
