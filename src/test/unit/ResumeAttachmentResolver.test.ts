import * as assert from "assert";
import { suite, test } from "mocha";
import { ResumeAttachmentResolver } from "../../utils/ResumeAttachmentResolver";
import type { PromptStep } from "../../types/CtrlYokeTypes";

suite("ResumeAttachmentResolver", () => {
  test("should resolve full attachments when not resuming", () => {
    const result = ResumeAttachmentResolver.resolve({
      promptIndex: 0,
      allPrompts: [],
      resumeSession: false,
      agent: "reviewer",
      skills: ["git", "testing"],
    });

    assert.strictEqual(result.agent, "reviewer");
    assert.deepStrictEqual(result.skills, ["git", "testing"]);
  });

  test("should diff against the matching resumed session when a session ID is available", () => {
    const result = ResumeAttachmentResolver.resolve({
      promptIndex: 2,
      allPrompts: [
        {
          prompt: "other session",
          _runtime: {
            startedAt: 1,
            completedAt: 2,
            sessionId: "different-session",
            harness: "codex-cli",
            agent: "other-agent",
            skills: ["lint"],
          },
        } as PromptStep,
        {
          prompt: "same session",
          _runtime: {
            startedAt: 3,
            completedAt: 4,
            sessionId: "session-123",
            harness: "codex-cli",
            agent: "reviewer",
            skills: ["git"],
          },
        } as PromptStep,
      ],
      harness: "codex-cli",
      resumeSession: true,
      resolvedSessionId: "session-123",
      agent: "reviewer",
      skills: ["git", "testing"],
    });

    assert.strictEqual(result.agent, undefined);
    assert.deepStrictEqual(result.skills, ["testing"]);
  });

  test("should fall back to the most recent completed prompt when no session ID is available", () => {
    const result = ResumeAttachmentResolver.resolve({
      promptIndex: 2,
      allPrompts: [
        {
          prompt: "prior",
          _runtime: {
            startedAt: 1,
            completedAt: 2,
            harness: "claude-cli",
            skills: ["skill-a"],
          },
        } as PromptStep,
        {
          prompt: "different harness",
          _runtime: {
            startedAt: 3,
            completedAt: 4,
            harness: "codex-cli",
            skills: ["skill-z"],
          },
        } as PromptStep,
      ],
      harness: "claude-cli",
      resumeSession: true,
      skills: ["skill-a", "skill-b"],
    });

    assert.strictEqual(result.agent, undefined);
    assert.deepStrictEqual(result.skills, ["skill-b"]);
  });
});
