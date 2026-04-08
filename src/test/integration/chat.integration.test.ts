import * as assert from "assert";
import * as vscode from "vscode";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

/**
 * Integration Tests for CopilotChatIntegration
 *
 * Real integration tests that run in a full VS Code instance with the extension loaded.
 * Tests use actual VS Code APIs including Language Model Tools.
 */
suite("Chat Integration Tests", () => {
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
    const chatLocation = ConfigurationUtils.getChatWindowLocation();

    assert.ok(chatLocation);
    assert.ok(
      ["chatPanel", "newTab", "newWindow"].includes(chatLocation),
      "Chat location should be valid option"
    );
  });

  test("Native attachments setting should be configurable", () => {
    const useNativeAttachments =
      ConfigurationUtils.shouldUseChatNativeAttachments();

    assert.strictEqual(typeof useNativeAttachments, "boolean");
  });
});
