import { describe, it, expect } from "vitest";
import {
  createPromptItem,
  promptItemToRaw,
  isPromptExecuted,
  isPromptRunning,
  isPromptPending,
  getPromptLabel,
  type PromptItem,
  type RawPrompt,
} from "@utils/prompt";
import { STEP_STATUS } from "@/types/messages";

function makeItem(overrides: Partial<PromptItem> = {}): PromptItem {
  return {
    index: 0,
    text: "Do something useful",
    status: STEP_STATUS.PENDING,
    details: {},
    ...overrides,
  };
}

describe("createPromptItem", () => {
  it("creates a pending item from a string prompt", () => {
    const item = createPromptItem("Analyze the code", 0);
    expect(item.index).toBe(0);
    expect(item.text).toBe("Analyze the code");
    expect(item.status).toBe(STEP_STATUS.PENDING);
    expect(item.details).toEqual({});
  });

  it("accepts a custom status when creating from string", () => {
    const item = createPromptItem("Fix bugs", 2, STEP_STATUS.COMPLETED);
    expect(item.status).toBe(STEP_STATUS.COMPLETED);
    expect(item.index).toBe(2);
  });

  it("creates an item from a RawPrompt object preserving all fields", () => {
    const raw: RawPrompt = {
      prompt: "Fix bugs",
      harness: "claude-cli",
      model: "claude-sonnet-4.5",
      agent: "myagent.md",
      resumeSession: true,
      sessionId: "abc-123",
      mcpServers: ["flightpath"],
      hooks: [{ event: "stop", command: "npm test" }],
    };
    const item = createPromptItem(raw, 1);
    expect(item.text).toBe("Fix bugs");
    expect(item.harness).toBe("claude-cli");
    expect(item.model).toBe("claude-sonnet-4.5");
    expect(item.agent).toBe("myagent.md");
    expect(item.resumeSession).toBe(true);
    expect(item.sessionId).toBe("abc-123");
    expect(item.mcpServers).toEqual(["flightpath"]);
    expect(item.hooks).toEqual([{ event: "stop", command: "npm test" }]);
  });

  it("passes through endCondition from raw prompt", () => {
    const raw: RawPrompt = {
      prompt: "Run tests",
      endCondition: { script: "npm test", returns: "true", maxRetries: 3 },
    };
    const item = createPromptItem(raw, 0);
    expect(item.endCondition?.script).toBe("npm test");
    expect(item.endCondition?.maxRetries).toBe(3);
  });
});

describe("promptItemToRaw", () => {
  it("converts a minimal item to raw format", () => {
    const item = makeItem({ text: "Hello" });
    const raw = promptItemToRaw(item);
    expect(raw.prompt).toBe("Hello");
  });

  it("omits undefined optional properties", () => {
    const item = makeItem({ text: "Hello", harness: undefined, model: undefined });
    const raw = promptItemToRaw(item);
    expect("harness" in raw).toBe(false);
    expect("model" in raw).toBe(false);
  });

  it("includes defined optional properties", () => {
    const item = makeItem({
      text: "Hello",
      harness: "claude-cli",
      model: "claude-opus-4",
      resumeSession: true,
    });
    const raw = promptItemToRaw(item);
    expect(raw.harness).toBe("claude-cli");
    expect(raw.model).toBe("claude-opus-4");
    expect(raw.resumeSession).toBe(true);
  });

  it("round-trips through createPromptItem → promptItemToRaw", () => {
    const raw: RawPrompt = {
      prompt: "Do a thing",
      harness: "copilot-cli",
      skills: ["skill-a"],
      hooks: [{ event: "stop", command: "npm test" }],
    };
    const item = createPromptItem(raw, 0);
    const back = promptItemToRaw(item);
    expect(back.prompt).toBe(raw.prompt);
    expect(back.harness).toBe(raw.harness);
    expect(back.skills).toEqual(raw.skills);
    expect(back.hooks).toEqual([{ event: "stop", command: "npm test" }]);
  });
});

describe("isPromptExecuted", () => {
  it("is true when completed", () => {
    expect(isPromptExecuted(makeItem({ status: STEP_STATUS.COMPLETED }))).toBe(true);
  });

  it("is true when failed", () => {
    expect(isPromptExecuted(makeItem({ status: STEP_STATUS.FAILED }))).toBe(true);
  });

  it("is false when pending or running", () => {
    expect(isPromptExecuted(makeItem({ status: STEP_STATUS.PENDING }))).toBe(false);
    expect(isPromptExecuted(makeItem({ status: STEP_STATUS.RUNNING }))).toBe(false);
  });
});

describe("isPromptRunning", () => {
  it("is true when running", () => {
    expect(isPromptRunning(makeItem({ status: STEP_STATUS.RUNNING }))).toBe(true);
  });

  it("is true when sent", () => {
    expect(isPromptRunning(makeItem({ status: STEP_STATUS.SENT }))).toBe(true);
  });

  it("is false for completed, pending, failed", () => {
    expect(isPromptRunning(makeItem({ status: STEP_STATUS.COMPLETED }))).toBe(false);
    expect(isPromptRunning(makeItem({ status: STEP_STATUS.PENDING }))).toBe(false);
    expect(isPromptRunning(makeItem({ status: STEP_STATUS.FAILED }))).toBe(false);
  });
});

describe("isPromptPending", () => {
  it("is true only when pending", () => {
    expect(isPromptPending(makeItem({ status: STEP_STATUS.PENDING }))).toBe(true);
    expect(isPromptPending(makeItem({ status: STEP_STATUS.RUNNING }))).toBe(false);
  });
});

describe("getPromptLabel", () => {
  it("returns first line of text", () => {
    const item = makeItem({ text: "Analyze the code\nWith more details" });
    expect(getPromptLabel(item)).toBe("Analyze the code");
  });

  it('returns "Prompt N" for empty text', () => {
    const item = makeItem({ index: 2, text: "" });
    expect(getPromptLabel(item)).toBe("Prompt 3");
  });

  it('returns "Prompt N" for whitespace-only first line', () => {
    const item = makeItem({ index: 0, text: "   \nsome text" });
    expect(getPromptLabel(item)).toBe("Prompt 1");
  });

  it("truncates long first lines with ellipsis", () => {
    const longText = "A".repeat(60);
    const item = makeItem({ text: longText });
    const label = getPromptLabel(item, 50);
    expect(label.length).toBeLessThanOrEqual(50);
    expect(label.endsWith("...")).toBe(true);
  });

  it("does not truncate when within maxLength", () => {
    const item = makeItem({ text: "Short prompt" });
    expect(getPromptLabel(item, 50)).toBe("Short prompt");
  });
});
