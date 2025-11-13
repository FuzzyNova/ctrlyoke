import * as assert from "assert";
import * as vscode from "vscode";

/**
 * Integration Tests for CopilotChatIntegration
 *
 * Real integration tests that run in a full VS Code instance with the extension loaded.
 * Tests use actual VS Code APIs including Language Model Tools.
 */
suite("Chat Integration Tests", () => {
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

  test("Extension should register Language Model Tool", function () {
    this.timeout(5000);

    // Check if the tool is registered in package.json manifest
    const allExtensions = vscode.extensions.all;
    const extension = allExtensions.find(
      (ext) =>
        ext.id === "nhickster.flightpath" ||
        ext.packageJSON.name === "flightpath"
    );
    assert.ok(extension, "Extension should be loaded");

    const packageJSON = extension.packageJSON;
    assert.ok(packageJSON.contributes);
    assert.ok(packageJSON.contributes.languageModelTools);

    const tools = packageJSON.contributes.languageModelTools;
    const responseCompleteTool = tools.find(
      (t: any) => t.name === "flightpath_response_complete"
    );

    assert.ok(
      responseCompleteTool,
      "Response complete tool should be declared"
    );
    assert.strictEqual(
      responseCompleteTool.toolReferenceName,
      "flightpath_response_complete"
    );
  });

  test("Chat commands should be available", async () => {
    const commands = await vscode.commands.getCommands();

    // Check for chat-related commands
    const chatCommands = [
      "workbench.panel.chat.view.copilot.focus",
      "workbench.action.chat.openInEditor",
      "workbench.action.chat.submit",
      "editor.action.selectAll",
      "type",
    ];

    const availableCommands = chatCommands.filter((cmd) =>
      commands.includes(cmd)
    );

    console.log(
      `Chat automation commands available: ${availableCommands.length}/${chatCommands.length}`
    );

    // At minimum, 'type' and 'selectAll' should be available
    assert.ok(commands.includes("type"), "Type command should be available");
    assert.ok(
      commands.includes("editor.action.selectAll"),
      "SelectAll command should be available"
    );
  });

  test("Should support file attachment commands", async () => {
    const commands = await vscode.commands.getCommands();

    const attachmentCommands = [
      "github.copilot.chat.attachFile",
      "github.copilot.chat.attachSelection",
    ];

    for (const cmd of attachmentCommands) {
      const available = commands.includes(cmd);
      console.log(`${cmd}: ${available ? "✓" : "✗"}`);
    }

    // These commands require Copilot Chat extension
    // Don't fail test if not available
  });

  test("Chat window location setting should work", () => {
    const config = vscode.workspace.getConfiguration("flightpath");
    const chatLocation = config.get<string>("chatWindowLocation");

    assert.ok(chatLocation);
    assert.ok(
      ["chatPanel", "newTab", "newWindow"].includes(chatLocation),
      "Chat location should be valid option"
    );
  });

  test("Native attachments setting should be configurable", () => {
    const config = vscode.workspace.getConfiguration("flightpath");
    const useNativeAttachments = config.get<boolean>(
      "chatUseNativeAttachments"
    );

    assert.strictEqual(typeof useNativeAttachments, "boolean");
  });
});
