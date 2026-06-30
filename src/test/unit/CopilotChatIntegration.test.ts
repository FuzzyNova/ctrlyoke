import * as assert from "assert";
import { suite, test } from "mocha";
import type * as vscode from "vscode";
import { CopilotChatIntegration } from "../../core/harness/chat/CopilotChatIntegration";
import type { PromptStep } from "../../types/CtrlYokeTypes";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

suite("CopilotChatIntegration", () => {
  test("should read finalStep prior context from the workflow callback", async () => {
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

      const prompt: PromptStep = { prompt: "follow up" };
      const builtPrompt = await (integration as any).buildCopilotChatPrompt(
        prompt,
        {
          promptIndex: 0,
          allPrompts: [prompt],
          resolvedProperties: { priorContext: "finalStepAll" },
          getFinalStepResponseTexts: () => ["final loop response"],
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

  test("should include inline prior-context refs in categorized prompt context", async () => {
    const integration = new CopilotChatIntegration(
      {} as vscode.ExtensionContext,
      false
    );
    const originalShouldUseChatNativeAttachments =
      ConfigurationUtils.shouldUseChatNativeAttachments;
    let capturedWorkflowContextText: string | undefined;

    try {
      (ConfigurationUtils as any).shouldUseChatNativeAttachments = () => false;

      const priorPrompt: PromptStep = {
        prompt: "analyze",
        _runtime: { startedAt: 0, responseText: "analysis output" },
      };
      const currentPrompt: PromptStep = { prompt: "use $previous" };

      (integration as any).buildPromptSections = async () => ({
        skillContent: null,
        agentContent: null,
        directFileRefs: [],
        excerptContent: null,
        userPromptText: "use $previous",
      });
      (integration as any).isSimplePrompt = () => true;
      (integration as any).buildAndAttachCategorizedFiles = async (
        sections: { userPromptText: string },
        workflowContextText?: string
      ) => {
        capturedWorkflowContextText = workflowContextText;
        return sections.userPromptText;
      };

      await (integration as any).buildCopilotChatPrompt(currentPrompt, {
        promptIndex: 1,
        allPrompts: [priorPrompt, currentPrompt],
        resolvedProperties: {},
      });

      assert.ok(capturedWorkflowContextText?.includes("<priorContext>"));
      assert.ok(capturedWorkflowContextText?.includes("analysis output"));
    } finally {
      (ConfigurationUtils as any).shouldUseChatNativeAttachments =
        originalShouldUseChatNativeAttachments;
      integration.dispose();
    }
  });
});
