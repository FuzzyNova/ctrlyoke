import { describe, expect, it } from "vitest";
import { STEP_TYPES } from "@root/types/DashboardConstants";
import {
  buildWorkflowStepEnabledState,
  buildWorkflowStepEnabledUpdate,
  parseWorkflowStepClipboardText,
} from "@utils/stepClipboard";

describe("stepClipboard", () => {
  it("strips runtime and status fields when parsing clipboard step JSON", () => {
    const parsed = parseWorkflowStepClipboardText(
      JSON.stringify({
        prompt: "Clipboard prompt",
        enabled: false,
        status: "completed",
        _runtime: {
          startedAt: 1,
          completedAt: 2,
        },
      })
    );

    expect(parsed).toEqual({
      prompt: "Clipboard prompt",
      enabled: false,
    });
  });

  it("clears the enabled flag instead of persisting enabled=true for prompt steps", () => {
    expect(
      buildWorkflowStepEnabledUpdate(
        {
          prompt: "Prompt step",
          enabled: false,
        },
        true
      )
    ).toEqual({
      text: "Prompt step",
      promptName: "",
      properties: {},
      clearProperties: ["enabled"],
    });
  });

  it("sends a minimal script-step disable update", () => {
    expect(
      buildWorkflowStepEnabledUpdate(
        {
          type: STEP_TYPES.SCRIPT,
          script: "npm test",
          timeout: 30,
          returns: "true",
        },
        false
      )
    ).toEqual({
      text: "npm test",
      promptName: "",
      properties: {
        type: STEP_TYPES.SCRIPT,
        enabled: false,
      },
    });
  });

  it("clears the enabled flag when re-enabling a script step", () => {
    expect(
      buildWorkflowStepEnabledUpdate(
        {
          type: STEP_TYPES.SCRIPT,
          script: "npm test",
          enabled: false,
          timeout: 30,
        },
        true
      )
    ).toEqual({
      text: "npm test",
      promptName: "",
      properties: {
        type: STEP_TYPES.SCRIPT,
      },
      clearProperties: ["enabled"],
    });
  });

  it(
    "disabling a script step sends only its type and enabled state",
    () => {
      expect(
        buildWorkflowStepEnabledUpdate(
          {
            type: STEP_TYPES.SCRIPT,
            script: "npm run deploy",
            env: { DEPLOY_TOKEN: "${secret:DEPLOY_TOKEN}" },
            secrets: ["DEPLOY_TOKEN"],
            errorBehavior: { onError: "retry", maxRetries: 2 },
            executionMode: "headless",
            timeout: 30,
          } as never,
          false
        ).properties
      ).toEqual({
        type: STEP_TYPES.SCRIPT,
        enabled: false,
      });
    }
  );

  it(
    "the canonical enabled-state payload preserves a script step's secrets",
    () => {
      expect(
        buildWorkflowStepEnabledState(
          {
            type: STEP_TYPES.SCRIPT,
            script: "npm run deploy",
            secrets: ["DEPLOY_TOKEN"],
          } as never,
          false
        )
      ).toEqual({
        type: STEP_TYPES.SCRIPT,
        script: "npm run deploy",
        secrets: ["DEPLOY_TOKEN"],
        enabled: false,
      });
    }
  );

  it("builds a canonical enabled-state payload without runtime fields", () => {
    expect(
      buildWorkflowStepEnabledState(
        {
          prompt: "Final step",
          enabled: true,
          status: "completed",
          _runtime: {
            startedAt: 1,
            completedAt: 2,
          },
        } as never,
        false
      )
    ).toEqual({
      prompt: "Final step",
      enabled: false,
    });
  });
});
