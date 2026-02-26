import * as assert from "assert";

// ---------------------------------------------------------------------------
// Pure replication of AgentExpander.stripFrontmatter so it can be tested
// without importing the extension class (which pulls in vscode).
// The algorithm must be kept in sync with the original.
// ---------------------------------------------------------------------------
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const closingIdx = content.indexOf("---", 3);
  if (closingIdx === -1) {
    return content;
  }
  return content.substring(closingIdx + 3).trimStart();
}

function frontmatterHasField(content: string, field: string): boolean {
  if (!content.startsWith("---")) {
    return false;
  }
  const closingIdx = content.indexOf("---", 3);
  if (closingIdx === -1) {
    return false;
  }
  const frontmatter = content.substring(3, closingIdx);
  return new RegExp(`^\\s*${field}\\s*:`, "m").test(frontmatter);
}

// ---------------------------------------------------------------------------
// Pure replication of the private HarnessIntegration.insertAgentInstructions
// method so it can be tested without importing the extension class (which
// pulls in vscode).  The algorithm must be kept in sync with the original.
// ---------------------------------------------------------------------------
const ATTACHMENT_CLOSE_TAG = "</attachment>";

function insertAgentInstructions(
  expandedPrompt: string,
  agentContent: string
): string {
  const lastAttachmentEnd = expandedPrompt.lastIndexOf(ATTACHMENT_CLOSE_TAG);

  if (lastAttachmentEnd === -1) {
    // No attachments - prepend agent before entire prompt
    return `<agentInstructions>\n${agentContent}\n</agentInstructions>\n\n${expandedPrompt}`;
  }

  // Split at end of last attachment and insert agent between attachments and user prompt
  const afterAttachmentTag = lastAttachmentEnd + ATTACHMENT_CLOSE_TAG.length;
  const attachmentSection = expandedPrompt.substring(0, afterAttachmentTag);
  const userPromptSection = expandedPrompt.substring(afterAttachmentTag);

  return `${attachmentSection}\n\n<agentInstructions>\n${agentContent}\n</agentInstructions>\n\n${userPromptSection.trim()}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite("insertAgentInstructions", () => {
  const AGENT_CONTENT = "You are a helpful coding assistant.";

  // -------------------------------------------------------------------------
  // No-attachment cases
  // -------------------------------------------------------------------------
  suite("no attachments present", () => {
    test("prepends agent instructions before entire prompt", () => {
      const prompt = "Fix the bug in main.ts";
      const result = insertAgentInstructions(prompt, AGENT_CONTENT);

      assert.ok(
        result.startsWith(
          `<agentInstructions>\n${AGENT_CONTENT}\n</agentInstructions>\n\n`
        ),
        "Result should start with wrapped agent instructions"
      );
      assert.ok(
        result.endsWith(prompt),
        "Original prompt should appear at end"
      );
    });

    test("preserves exact prompt text after agent instructions", () => {
      const prompt = "Refactor this code:\n\n```ts\nconst x = 1;\n```";
      const result = insertAgentInstructions(prompt, AGENT_CONTENT);

      assert.strictEqual(
        result,
        `<agentInstructions>\n${AGENT_CONTENT}\n</agentInstructions>\n\n${prompt}`
      );
    });

    test("wraps agent content in <agentInstructions> XML tags", () => {
      const result = insertAgentInstructions("do something", AGENT_CONTENT);

      assert.ok(result.includes("<agentInstructions>"), "Missing opening tag");
      assert.ok(result.includes("</agentInstructions>"), "Missing closing tag");
    });

    test("agent instructions appear BEFORE user prompt (no attachments)", () => {
      const prompt = "user prompt here";
      const result = insertAgentInstructions(prompt, AGENT_CONTENT);

      const agentIndex = result.indexOf("<agentInstructions>");
      const promptIndex = result.indexOf(prompt);
      assert.ok(
        agentIndex < promptIndex,
        "Agent instructions should precede user prompt"
      );
    });

    test("handles multi-line agent content", () => {
      const multiLineAgent = "Line one\nLine two\nLine three";
      const prompt = "Do a task";
      const result = insertAgentInstructions(prompt, multiLineAgent);

      assert.strictEqual(
        result,
        `<agentInstructions>\n${multiLineAgent}\n</agentInstructions>\n\n${prompt}`
      );
    });

    test("handles empty prompt", () => {
      const result = insertAgentInstructions("", AGENT_CONTENT);

      assert.ok(result.includes("<agentInstructions>"));
      assert.ok(result.includes("</agentInstructions>"));
    });

    test("handles empty agent content", () => {
      const prompt = "Do something important";
      const result = insertAgentInstructions(prompt, "");

      assert.strictEqual(
        result,
        `<agentInstructions>\n\n</agentInstructions>\n\n${prompt}`
      );
    });
  });

  // -------------------------------------------------------------------------
  // Single attachment
  // -------------------------------------------------------------------------
  suite("single attachment present", () => {
    test("inserts agent after attachment, before user prompt", () => {
      const attachment = "<attachment>\ncontent\n</attachment>";
      const userPrompt = "Now fix the code";
      const expandedPrompt = `${attachment}\n${userPrompt}`;

      const result = insertAgentInstructions(expandedPrompt, AGENT_CONTENT);

      // Attachment section should be preserved at start
      assert.ok(
        result.startsWith(attachment),
        "Attachment section must be preserved at start"
      );

      // Agent instructions should be in the middle
      assert.ok(
        result.includes("<agentInstructions>"),
        "Missing agentInstructions"
      );

      // User prompt should be at the end
      assert.ok(result.endsWith(userPrompt), "User prompt should be at end");
    });

    test("attachment content is completely preserved", () => {
      const attachmentContent = "important context here";
      const attachment = `<attachment>\n${attachmentContent}\n</attachment>`;
      const expandedPrompt = `${attachment}\nFix something`;

      const result = insertAgentInstructions(expandedPrompt, AGENT_CONTENT);

      assert.ok(
        result.includes(attachmentContent),
        "Attachment content must be preserved"
      );
    });

    test("agent instructions appear BETWEEN attachment and user prompt", () => {
      const attachment = "<attachment>\nsome context\n</attachment>";
      const userPrompt = "Tell me what to do";
      const expandedPrompt = `${attachment}\n${userPrompt}`;

      const result = insertAgentInstructions(expandedPrompt, AGENT_CONTENT);

      const attachmentEndIdx =
        result.indexOf("</attachment>") + "</attachment>".length;
      const agentStartIdx = result.indexOf("<agentInstructions>");
      const userPromptIdx = result.indexOf(userPrompt);

      assert.ok(
        agentStartIdx > attachmentEndIdx,
        "Agent must come AFTER last </attachment>"
      );
      assert.ok(
        userPromptIdx > agentStartIdx,
        "User prompt must come AFTER agent instructions"
      );
    });

    test("correctly formats with double newline separator between attachment and agent", () => {
      const attachment = "<attachment>\ndata\n</attachment>";
      const userPrompt = "User query";
      const expandedPrompt = `${attachment}\n${userPrompt}`;

      const result = insertAgentInstructions(expandedPrompt, AGENT_CONTENT);

      // There should be \n\n between the attachment close tag and the agent instructions
      assert.ok(
        result.includes(`</attachment>\n\n<agentInstructions>`),
        "Should have double newline between </attachment> and <agentInstructions>"
      );
    });
  });

  // -------------------------------------------------------------------------
  // Multiple attachments
  // -------------------------------------------------------------------------
  suite("multiple attachments present", () => {
    test("inserts agent after the LAST attachment, not the first", () => {
      const attachment1 = "<attachment>\nfirst file content\n</attachment>";
      const attachment2 = "<attachment>\nsecond file content\n</attachment>";
      const userPrompt = "Do the task";
      const expandedPrompt = `${attachment1}\n${attachment2}\n${userPrompt}`;

      const result = insertAgentInstructions(expandedPrompt, AGENT_CONTENT);

      // Both attachments should be in the attachment section
      const agentStartIdx = result.indexOf("<agentInstructions>");
      const firstAttachmentEnds =
        result.indexOf("</attachment>") + "</attachment>".length;
      const secondAttachmentEnds =
        result.lastIndexOf("</attachment>") + "</attachment>".length;

      assert.ok(
        agentStartIdx > secondAttachmentEnds,
        "Agent should be placed after the LAST </attachment> tag"
      );
      // First attachment end should be before agent (it's before the second attachment)
      assert.ok(firstAttachmentEnds < agentStartIdx);
    });

    test("preserves all attachments in correct order", () => {
      const attachment1 = "<attachment>\nalpha\n</attachment>";
      const attachment2 = "<attachment>\nbeta\n</attachment>";
      const attachment3 = "<attachment>\ngamma\n</attachment>";
      const userPrompt = "Process them all";
      const expandedPrompt = `${attachment1}\n${attachment2}\n${attachment3}\n${userPrompt}`;

      const result = insertAgentInstructions(expandedPrompt, AGENT_CONTENT);

      const alphaIdx = result.indexOf("alpha");
      const betaIdx = result.indexOf("beta");
      const gammaIdx = result.indexOf("gamma");
      const agentIdx = result.indexOf("<agentInstructions>");
      const userIdx = result.indexOf(userPrompt);

      assert.ok(alphaIdx < betaIdx, "First attachment before second");
      assert.ok(betaIdx < gammaIdx, "Second attachment before third");
      assert.ok(gammaIdx < agentIdx, "Last attachment before agent");
      assert.ok(agentIdx < userIdx, "Agent before user prompt");
    });

    test("user prompt is trimmed when placed after attachments", () => {
      const attachment = "<attachment>\ncontent\n</attachment>";
      const expandedPrompt = `${attachment}\n\n  \n  Fix the code  `;

      const result = insertAgentInstructions(expandedPrompt, AGENT_CONTENT);

      // The user prompt section is trimmed before appending
      assert.ok(
        result.endsWith("Fix the code"),
        "User prompt should be trimmed"
      );
    });
  });

  // -------------------------------------------------------------------------
  // Output format validation
  // -------------------------------------------------------------------------
  suite("output format", () => {
    test("double newline separates agent instructions from user prompt (no attachments)", () => {
      const prompt = "Hello";
      const result = insertAgentInstructions(prompt, AGENT_CONTENT);

      assert.ok(
        result.includes(`</agentInstructions>\n\n${prompt}`),
        "Double newline should separate agent instructions from user prompt"
      );
    });

    test("double newline separates agent instructions from user prompt (with attachments)", () => {
      const attachment = "<attachment>\ndata\n</attachment>";
      const userPrompt = "What should I do?";
      const expandedPrompt = `${attachment}\n${userPrompt}`;

      const result = insertAgentInstructions(expandedPrompt, AGENT_CONTENT);

      assert.ok(
        result.includes(`</agentInstructions>\n\n${userPrompt}`),
        "Double newline should separate agent instructions from user prompt"
      );
    });

    test("agent content is placed on its own line inside tags", () => {
      const agent = "Be precise.";
      const result = insertAgentInstructions("do work", agent);

      assert.ok(
        result.includes(`<agentInstructions>\n${agent}\n</agentInstructions>`),
        "Agent content should be on its own line, surrounded by newlines inside the tags"
      );
    });

    test("result is a string (not undefined or null)", () => {
      const result = insertAgentInstructions("prompt", AGENT_CONTENT);
      assert.strictEqual(typeof result, "string");
      assert.notStrictEqual(result, null);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  suite("edge cases", () => {
    test("handles </attachment> in agent content without splitting", () => {
      // The algorithm only looks at lastIndexOf on the expandedPrompt, not the agent content
      // Agent content is inserted after the split - it should not affect splitting logic
      const agentContentWithTag = "Use </attachment> style tags for wrapping.";
      const attachment = "<attachment>\nreal file\n</attachment>";
      const userPrompt = "Do a task";
      const expandedPrompt = `${attachment}\n${userPrompt}`;

      const result = insertAgentInstructions(
        expandedPrompt,
        agentContentWithTag
      );

      // User prompt should still be at end
      assert.ok(
        result.endsWith(userPrompt),
        "User prompt should still be at end"
      );
      // Attachment should be at start
      assert.ok(
        result.startsWith(attachment),
        "Attachment should still be at start"
      );
    });

    test("handles prompt that consists only of an attachment tag", () => {
      const expandedPrompt = "<attachment>\nonly content\n</attachment>";

      const result = insertAgentInstructions(expandedPrompt, AGENT_CONTENT);

      // attachmentSection = entire prompt, userPromptSection = "" (trimmed to "")
      assert.ok(
        result.startsWith(expandedPrompt),
        "Attachment-only prompt preserved at start"
      );
      assert.ok(
        result.includes("<agentInstructions>"),
        "Agent instructions present"
      );
    });

    test("preserves newlines within user prompt", () => {
      const userPrompt = "Step 1: analyze\nStep 2: implement\nStep 3: test";
      const result = insertAgentInstructions(userPrompt, AGENT_CONTENT);

      assert.ok(
        result.includes(userPrompt),
        "Multi-line user prompt should be preserved"
      );
    });

    test("handles prompt with XML-like content that is NOT an attachment tag", () => {
      const prompt = "<criticalInstruction>do something</criticalInstruction>";
      const result = insertAgentInstructions(prompt, AGENT_CONTENT);

      // No </attachment> → agent goes before entire prompt
      assert.ok(
        result.startsWith("<agentInstructions>"),
        "Agent should be prepended when no </attachment> tag found"
      );
      assert.ok(result.includes(prompt), "Original prompt content preserved");
    });
  });
});

// ---------------------------------------------------------------------------
// stripFrontmatter tests
// ---------------------------------------------------------------------------

suite("stripFrontmatter", () => {
  const AGENT_BODY = "# Test Agent\n\nYou are a helpful assistant.";

  const FULL_AGENT = `---
name: test-agent
description: A simple test agent
model: claude-haiku-4.5
tools:
  - read
  - search
---

${AGENT_BODY}`;

  suite("content without frontmatter", () => {
    test("returns content unchanged when no frontmatter", () => {
      const content = "# My Agent\n\nDo stuff.";
      assert.strictEqual(stripFrontmatter(content), content);
    });

    test("returns content unchanged when starts with text (not ---)", () => {
      const content = "Just a plain agent description.";
      assert.strictEqual(stripFrontmatter(content), content);
    });
  });

  suite("content with frontmatter", () => {
    test("strips the frontmatter block and returns only the body", () => {
      const result = stripFrontmatter(FULL_AGENT);
      assert.strictEqual(result, AGENT_BODY);
    });

    test("trims leading whitespace from body after frontmatter", () => {
      const content = "---\nname: agent\n---\n\n\n  \nActual content";
      const result = stripFrontmatter(content);
      assert.strictEqual(result, "Actual content");
    });

    test("does not include any --- delimiters in the result", () => {
      const result = stripFrontmatter(FULL_AGENT);
      assert.ok(!result.startsWith("---"), "Result should not start with ---");
    });

    test("does not include frontmatter fields in the result", () => {
      const result = stripFrontmatter(FULL_AGENT);
      assert.ok(!result.includes("name: test-agent"));
      assert.ok(!result.includes("description:"));
      assert.ok(!result.includes("model: claude-haiku-4.5"));
      assert.ok(!result.includes("tools:"));
    });

    test("preserves full markdown body content", () => {
      const result = stripFrontmatter(FULL_AGENT);
      assert.ok(result.includes("# Test Agent"));
      assert.ok(result.includes("You are a helpful assistant."));
    });
  });

  suite("frontmatter field detection", () => {
    test("detects model field in frontmatter", () => {
      assert.ok(frontmatterHasField(FULL_AGENT, "model"));
    });

    test("detects tools field in frontmatter", () => {
      assert.ok(frontmatterHasField(FULL_AGENT, "tools"));
    });

    test("detects name field in frontmatter", () => {
      assert.ok(frontmatterHasField(FULL_AGENT, "name"));
    });

    test("returns false for field not in frontmatter", () => {
      assert.ok(!frontmatterHasField(FULL_AGENT, "temperature"));
    });

    test("returns false when content has no frontmatter", () => {
      const noFrontmatter = "# Agent\n\nDo things.";
      assert.ok(!frontmatterHasField(noFrontmatter, "model"));
    });
  });

  suite("malformed frontmatter", () => {
    test("returns content as-is when opening --- has no closing ---", () => {
      const content = "---\nname: agent\nno closing delimiter";
      assert.strictEqual(stripFrontmatter(content), content);
    });

    test("handles empty frontmatter block", () => {
      const content = "---\n---\nAgent body here.";
      const result = stripFrontmatter(content);
      assert.strictEqual(result, "Agent body here.");
    });

    test("handles agent with only a body (no frontmatter at all)", () => {
      const body = "You are an AI assistant.\n\nHelp the user.";
      assert.strictEqual(stripFrontmatter(body), body);
    });
  });
});
