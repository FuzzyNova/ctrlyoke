import * as assert from "assert";
import { suite, test } from "mocha";
import type * as vscode from "vscode";
import { CopilotChatIntegration } from "../../flightpath/harness/chat/CopilotChatIntegration";
import type { PromptItem } from "../../types/FlightPathTypes";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

suite("CopilotChatIntegration", () => {
  test("should read finalPrompt prior context from the workflow callback", async () => {
    const integration = new CopilotChatIntegration(
      {} as vscode.ExtensionContext,
      false
    );
    const originalShouldUseChatNativeAttachments =
      ConfigurationUtils.shouldUseChatNativeAttachments;
    let capturedWorkflowContextText: string | undefined;

    try {
      (ConfigurationUtils as any).shouldUseChatNativeAttachments = () => false;

      (integration as any).buildPromptSections = async () => ({
        skillContent: null,
        agentContent: null,
        directFileRefs: [],
        excerptContent: null,
        userPromptText: "follow up",
      });
      (integration as any).isSimplePrompt = () => false;
      (integration as any).buildAndAttachCategorizedFiles = async (
        sections: { userPromptText: string },
        workflowContextText?: string
      ) => {
        capturedWorkflowContextText = workflowContextText;
        return sections.userPromptText;
      };

      const prompt: PromptItem = { prompt: "follow up" };
      const builtPrompt = await (integration as any).buildCopilotChatPrompt(
        prompt,
        {
          promptIndex: 0,
          allPrompts: [prompt],
          resolvedProperties: { priorContext: "finalPromptAll" },
          getFinalPromptResponseTexts: () => ["final loop response"],
        }
      );

      assert.strictEqual(builtPrompt, "follow up");
      assert.ok(capturedWorkflowContextText?.includes("<priorContext>"));
      assert.ok(capturedWorkflowContextText?.includes("final loop response"));
    } finally {
      (ConfigurationUtils as any).shouldUseChatNativeAttachments =
        originalShouldUseChatNativeAttachments;
      integration.dispose();
    }
  });
});
