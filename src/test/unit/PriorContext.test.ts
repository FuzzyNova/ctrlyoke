import * as assert from "assert";
import { suite, test } from "mocha";
import { buildPriorContextXmlFromItems } from "../../core/HarnessIntegration";
import type { ScriptVerdict } from "../../types/CtrlYokeTypes";
import {
  COMPARE_SOURCES,
  CONDITION_ACTIONS,
  PRIOR_CONTEXT_ITEM_TYPES,
  PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS,
  PRIOR_CONTEXT_LIMITS,
  SCRIPT_OPERATORS,
  SCRIPT_VERDICT_OUTCOMES,
  STEP_TYPES,
  USER_STEER_ATTRIBUTIONS,
} from "../../types/DashboardConstants";
import { inlinePriorContextRefToPriorContext } from "../../utils/PriorContextMerge";

suite("prior-context XML", () => {
  test("formats queue, script, and final-loop values supplied by the resolver", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        stepKind: STEP_TYPES.PROMPT,
        name: "plan",
        prompt: "plan it",
        text: "answer",
        detail: "full",
      },
      {
        index: 1,
        stepKind: "script",
        name: "test",
        text: "pass\n0",
        detail: "full",
        scriptOutput: {
          command: "npm test",
          stdout: "pass",
          stderr: "",
          exitCode: 0,
        },
      },
      {
        index: 2,
        stepKind: "prompt" as const,
        text: "final answer",
        detail: "full",
        type: PRIOR_CONTEXT_ITEM_TYPES.FINAL_STEP,
      },
    ]);

    assert.ok(xml.includes("<priorContext>"));
    assert.ok(xml.includes("<prompt>\nplan it\n</prompt>"));
    assert.ok(xml.includes("<command>\nnpm test\n</command>"));
    assert.ok(
      xml.includes(
        `<step index="3" type="${PRIOR_CONTEXT_ITEM_TYPES.FINAL_STEP}">`
      )
    );
  });

  test("renders workflow metadata and recursively nested child output", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 1,
        name: "lane & merge",
        stepKind: STEP_TYPES.WORKFLOW,
        detail: "full",
        workflowPath: "waves/a&b.yaml",
        subWorkflow: {
          output: {
            resolvedWorkflowPath: "/private/absolute/child.yaml",
            childWorkflowKey: "child&key" as never,
            childRunRef: 'run"1' as never,
            outcome: { status: "completed" as never },
            worktree: {
              mode: "managed" as never,
              branchName: "feature&one",
              baseCommit: "abc",
              finalBranchTip: "def",
              changedFileCount: 2,
              mergeOutcome: "conflict" as never,
              conflictFiles: ["src/a.ts"],
            },
          },
          children: [
            {
              index: 0,
              name: "child step",
              prompt: "implement",
              text: "done",
              detail: "full",
              stepKind: STEP_TYPES.WORKFLOW,
              subWorkflow: {
                output: {
                  childWorkflowKey: "grandchild" as never,
                  childRunRef: "run-2" as never,
                  outcome: { status: "completed" as never },
                },
              },
            },
          ],
        },
      },
    ]);

    assert.ok(
      xml.includes('name="lane &amp; merge" workflow="waves/a&amp;b.yaml"'),
      xml
    );
    assert.ok(!xml.includes("/private/absolute"), xml);
    assert.ok(
      xml.includes(
        'workflowKey="child&amp;key" runRef="run&quot;1" outcome="completed"'
      ),
      xml
    );
    assert.ok(xml.includes('<merge result="conflict">src/a.ts</merge>'), xml);
    assert.ok(xml.includes('workflowKey="grandchild"'), xml);
  });

  test("omits unset worktree attributes", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        stepKind: STEP_TYPES.WORKFLOW,
        detail: "full",
        subWorkflow: {
          output: {
            childWorkflowKey: "child" as never,
            childRunRef: "run-child" as never,
            outcome: { status: "completed" as never },
            worktree: { mode: "managed" } as never,
          },
          children: [],
        },
      },
    ]);
    assert.ok(xml.includes('<worktree mode="managed"/>\n'), xml);
    assert.ok(!xml.includes("filesChanged="), xml);
    assert.ok(!xml.includes('branch=""'), xml);
    assert.ok(!xml.includes('base=""'), xml);
    assert.ok(!xml.includes('tip=""'), xml);
  });

  test("marks an unavailable workflow child run", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        detail: "full",
        stepKind: STEP_TYPES.WORKFLOW,
        subWorkflow: {
          output: {
            childWorkflowKey: "gone" as never,
            childRunRef: "run-gone" as never,
            outcome: { status: "completed" as never },
          },
        },
      },
    ]);
    assert.ok(xml.includes("<childRunUnavailable/>"), xml);
  });

  test("budgets child summaries with parent summaries while keeping workflow metadata", () => {
    const childText = "c".repeat(PRIOR_CONTEXT_LIMITS.OUTPUT_TAIL_BYTES);
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        stepKind: STEP_TYPES.PROMPT,
        name: "parent",
        prompt: "parent prompt",
        text: childText,
        detail: "summary",
      },
      {
        index: 1,
        name: "lane",
        stepKind: STEP_TYPES.WORKFLOW,
        detail: "summary",
        subWorkflow: {
          output: {
            childWorkflowKey: "child" as never,
            childRunRef: "run-child" as never,
            outcome: { status: "completed" as never },
          },
          children: Array.from({ length: 30 }, (_, index) => ({
            index,
            stepKind: STEP_TYPES.PROMPT,
            ...(index === 0
              ? {
                  containingRun: {
                    workflowKey: "child&key",
                    runRef: 'run"child',
                  },
                }
              : {}),
            name: `child ${index}`,
            prompt: `prompt ${index}`,
            text: childText,
            detail: "summary" as const,
          })),
        },
      },
    ]);

    assert.match(xml, /<step index="2" type="workflow" name="lane"/);
    assert.ok(xml.includes('workflowKey="child"'), xml);
    assert.match(
      xml,
      /<step index="1" name="parent" detail="summary" omitted="all"/
    );
    assert.match(
      xml,
      /<step index="1" name="child 0" detail="summary"[^>]*omitted="all"/
    );
    assert.ok(xml.includes("prompt 29"), "the last child summary is retained");
    assert.ok(!xml.includes('name="lane" detail="summary" omitted="all"'));
    const summaryXml = xml.slice(
      xml.indexOf('<step index="2" type="workflow"')
    );
    const omittedChildCount = [...summaryXml.matchAll(/omitted="all"/g)].length;
    assert.ok(
      omittedChildCount > 0,
      `omitted child count: ${omittedChildCount}`
    );
    assert.ok(
      xml.includes(
        'readOutput="read_output { run: { workflowKey: child&amp;key, runRef: run&quot;child }, indices: [0] }"'
      ),
      xml
    );
  });

  const verdict = (overrides: Partial<ScriptVerdict>): ScriptVerdict => ({
    compareSource: COMPARE_SOURCES.EXIT_CODE,
    operator: SCRIPT_OPERATORS.EQ,
    expected: "0",
    actual: "0",
    exitCode: 0,
    outcome: SCRIPT_VERDICT_OUTCOMES.PASSED,
    action: CONDITION_ACTIONS.CONTINUE,
    durationMs: 5,
    ...overrides,
  });
  const scriptOutput = {
    command: "npm test",
    stdout: "3 failing",
    stderr: "",
    exitCode: 1,
  };

  test("renders a script step's verdict after its exit code", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        stepKind: STEP_TYPES.SCRIPT,
        text: "3 failing\n1",
        detail: "full",
        scriptOutput,
        scriptVerdict: verdict({
          actual: "1",
          exitCode: 1,
          outcome: SCRIPT_VERDICT_OUTCOMES.FAILED,
          action: CONDITION_ACTIONS.STOP_WORKFLOW,
        }),
      },
    ]);

    assert.ok(
      xml.includes(
        '<exitCode>1</exitCode>\n<verdict outcome="failed" compareSource="exitCode" operator="eq" expected="0" actual="1"/>\n</step>'
      ),
      xml
    );
  });

  test("states the exit-code fallback when no expected value is set", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        stepKind: STEP_TYPES.SCRIPT,
        text: "3 failing\n1",
        detail: "full",
        scriptOutput,
        scriptVerdict: verdict({
          compareSource: COMPARE_SOURCES.STDOUT,
          operator: SCRIPT_OPERATORS.CONTAINS,
          expected: undefined,
          actual: "3 failing",
          exitCode: 1,
          outcome: SCRIPT_VERDICT_OUTCOMES.FAILED,
        }),
      },
    ]);

    assert.ok(
      xml.includes(
        '<verdict outcome="failed" compareSource="exitCode" operator="eq" expected="0" actual="1"/>'
      ),
      xml
    );
  });

  test("does not repeat a stream actual and escapes attribute values", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        stepKind: STEP_TYPES.SCRIPT,
        text: "3 failing\n1",
        scriptOutput,
        detail: "full",
        scriptVerdict: verdict({
          compareSource: COMPARE_SOURCES.STDOUT,
          operator: SCRIPT_OPERATORS.MATCHES,
          expected: '"<0> & ok"',
          actual: "3 failing",
          outcome: SCRIPT_VERDICT_OUTCOMES.ERRORED,
          timedOut: true,
          error: "timed out\n  after 5s",
        }),
      },
    ]);

    assert.ok(
      xml.includes(
        '<verdict outcome="errored" compareSource="stdout" operator="matches" expected="&quot;&lt;0&gt; &amp; ok&quot;" timedOut="true" reason="timed out after 5s"/>'
      ),
      xml
    );
  });

  test("renders a script finalStep's verdict after its response", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        stepKind: "prompt",
        text: "ok",
        detail: "full",
        type: PRIOR_CONTEXT_ITEM_TYPES.FINAL_STEP,
        scriptVerdict: verdict({}),
      },
    ]);

    assert.ok(
      xml.includes(
        '<response>\nok\n</response>\n<verdict outcome="passed" compareSource="exitCode" operator="eq" expected="0" actual="0"/>\n</step>'
      ),
      xml
    );
  });

  test("leaves steps without a verdict unchanged", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        stepKind: "prompt",
        prompt: "plan it",
        text: "answer",
        detail: "full",
      },
      {
        index: 1,
        stepKind: STEP_TYPES.SCRIPT,
        text: "3 failing\n1",
        scriptOutput,
        detail: "full",
      },
    ]);

    assert.strictEqual(
      xml,
      '<priorContext>\n<step index="1">\n<prompt>\nplan it\n</prompt>\n<response>\nanswer\n</response>\n</step>\n<step index="2" type="script">\n<command>\nnpm test\n</command>\n<stdout>\n3 failing\n</stdout>\n<exitCode>1</exitCode>\n</step>\n</priorContext>'
    );
  });

  test("renders every full transcript entry and escapes event attributes", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        stepKind: "prompt",
        detail: "full",
        transcript: [
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.THINKING,
            text: "consider",
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.EDIT,
            path: 'src/a&".ts',
            added: 2,
            removed: 1,
            diff: {
              text: "--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n-old\n+new\n+line",
              omitted: "end",
              omittedBytes: 22,
            },
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.CREATE,
            path: "src/new.ts",
            added: 1,
            diff: { text: "+new" },
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.DELETE,
            path: "src/old.ts",
            failed: true,
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.COMMAND,
            command: "npm test",
            exitCode: 1,
            output: { text: "failed", omitted: "start", omittedBytes: 90 },
            failed: true,
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.READ,
            path: "src/a.ts",
            lineStart: 3,
            lineEnd: 8,
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.TOOL,
            name: "server/tool",
            arguments: { text: '{"x":1}' },
            result: { text: "done" },
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.SEARCH,
            query: "A & B",
            results: [{ title: "Result", url: "https://example.test" }],
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.QUESTION,
            questions: [{ question: "Continue?", options: [] }],
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.USER_STEER,
            text: "Keep going",
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.USER_STEER,
            text: "Image resized",
            attribution: USER_STEER_ATTRIBUTIONS.SYSTEM,
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.TERMINAL_OUTPUT,
            text: "crashed",
            reason: "exit & failed",
          },
        ],
        earlierAttempts: {
          count: 2,
          filesChanged: [
            { path: "src/old.ts", operation: "deleted", added: 0, removed: 0 },
          ],
        },
      },
    ]);

    for (const fragment of [
      "<thinking>\nconsider\n</thinking>",
      '<edit path="src/a&amp;&quot;.ts" added="2" removed="1" omitted="end" omittedBytes="22">',
      '<create path="src/new.ts" added="1">',
      '<delete path="src/old.ts" failed="true"/>',
      '<command exitCode="1" failed="true">\nnpm test\n<output omitted="start" omittedBytes="90">\nfailed\n</output>',
      '<read path="src/a.ts" lines="3-8"/>',
      '<tool name="server/tool">\n<arguments>\n{"x":1}\n</arguments>\n<output>\ndone\n</output>\n</tool>',
      '<search query="A &amp; B">',
      "<question>",
      "<userSteer>\nKeep going\n</userSteer>",
      "<systemMessage>\nImage resized\n</systemMessage>",
      '<terminalOutput reason="exit &amp; failed">\ncrashed\n</terminalOutput>',
      '<earlierAttempts count="2">\n<filesChanged>\nRemoved src/old.ts',
    ])
      assert.ok(xml.includes(fragment), `missing ${fragment}: ${xml}`);
  });

  test("renders summary as a bounded text projection with prompt head and net files", () => {
    const prompt = `head\n${"p".repeat(PRIOR_CONTEXT_LIMITS.PROMPT_HEAD_BYTES + 32)}`;
    const response = `${"r".repeat(PRIOR_CONTEXT_LIMITS.OUTPUT_TAIL_BYTES + 24)}\nconclusion`;
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        stepKind: "prompt",
        detail: "summary",
        prompt,
        transcript: [
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.THINKING,
            text: "omit thinking",
          },
          { kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.TEXT, text: response },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.COMMAND,
            command: "omit command",
            exitCode: 0,
            output: { text: "omit output" },
          },
        ],
        filesChanged: [
          { path: "src/added.ts", operation: "created", added: 2, removed: 0 },
        ],
      },
    ]);

    assert.ok(xml.includes('<step index="1" detail="summary">'));
    assert.ok(
      xml.includes(
        `<prompt omitted="end" omittedBytes="${Buffer.byteLength(prompt) - PRIOR_CONTEXT_LIMITS.PROMPT_HEAD_BYTES}">`
      )
    );
    assert.ok(
      xml.includes(
        `<response omitted="start" omittedBytes="${Buffer.byteLength(response) - PRIOR_CONTEXT_LIMITS.OUTPUT_TAIL_BYTES}">`
      )
    );
    assert.ok(xml.includes("conclusion"));
    assert.ok(xml.includes("Added src/added.ts +2\n"), xml);
    assert.ok(!xml.includes("omit thinking"));
    assert.ok(!xml.includes("omit command"));
  });

  test("caps a summary script step's output by the script tail, not the text tail", () => {
    const stdout = `${"s".repeat(PRIOR_CONTEXT_LIMITS.SCRIPT_OUTPUT_TAIL_BYTES + 40)}\nlast`;
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        stepKind: "script",
        detail: "summary",
        scriptOutput: { command: "npm test", stdout, stderr: "", exitCode: 0 },
      },
    ]);

    assert.ok(
      xml.includes(
        `<stdout omitted="start" omittedBytes="${Buffer.byteLength(stdout) - PRIOR_CONTEXT_LIMITS.SCRIPT_OUTPUT_TAIL_BYTES}">`
      ),
      xml.slice(0, 300)
    );
  });

  test("omits the earliest whole summary steps once the summary budget is spent", () => {
    const stepText = "r".repeat(PRIOR_CONTEXT_LIMITS.OUTPUT_TAIL_BYTES);
    const stepCount =
      Math.ceil(
        PRIOR_CONTEXT_LIMITS.SUMMARY_BUDGET_BYTES /
          PRIOR_CONTEXT_LIMITS.OUTPUT_TAIL_BYTES
      ) + 3;
    const fullText = "f".repeat(PRIOR_CONTEXT_LIMITS.SUMMARY_BUDGET_BYTES);
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        stepKind: "prompt",
        name: "full step",
        text: fullText,
        detail: "full",
      },
      ...Array.from({ length: stepCount }, (_, offset) => ({
        index: offset + 1,
        stepKind: "prompt" as const,
        name: `step ${offset + 1}`,
        prompt: `prompt ${offset + 1}`,
        text: stepText,
        detail: "summary" as const,
      })),
    ]);

    // Full-detail steps are neither counted nor omitted.
    assert.ok(xml.includes(fullText));
    // The earliest summary step is replaced whole, keeping its identity.
    assert.match(
      xml,
      /<step index="2" name="step 1" detail="summary" omitted="all" omittedBytes="\d+"\/>/
    );
    // The latest summary step is always kept.
    assert.ok(xml.includes(`<prompt>\nprompt ${stepCount}\n</prompt>`));
    const keptSummaryBytes = [
      ...xml.matchAll(/<step [^>]*detail="summary"[^/>]*>[\s\S]*?<\/step>/g),
    ].reduce((sum, [step]) => sum + Buffer.byteLength(step), 0);
    assert.ok(keptSummaryBytes <= PRIOR_CONTEXT_LIMITS.SUMMARY_BUDGET_BYTES);
    // Only as many steps as needed are omitted: one more would have fit.
    const omittedCount = [...xml.matchAll(/omitted="all"/g)].length;
    assert.ok(omittedCount > 0 && omittedCount < stepCount);
    assert.ok(
      keptSummaryBytes + Buffer.byteLength(stepText) >
        PRIOR_CONTEXT_LIMITS.SUMMARY_BUDGET_BYTES
    );
  });

  test("budgets final-step passes after queue steps without changing display order", () => {
    const text = "s".repeat(PRIOR_CONTEXT_LIMITS.OUTPUT_TAIL_BYTES);
    const queueItems = Array.from({ length: 30 }, (_, index) => ({
      index,
      stepKind: STEP_TYPES.PROMPT,
      name: `queue ${index}`,
      text,
      detail: "summary" as const,
    }));
    const finalItems = Array.from({ length: 3 }, (_, index) => ({
      index,
      stepKind: STEP_TYPES.PROMPT,
      name: `pass ${index}`,
      text,
      detail: "summary" as const,
      type: PRIOR_CONTEXT_ITEM_TYPES.FINAL_STEP,
    }));
    const xml = buildPriorContextXmlFromItems([...queueItems, ...finalItems]);

    assert.match(xml, /<step index="1" name="queue 0"[^>]*omitted="all"/);
    assert.match(xml, /<step index="3" type="finalStep" name="pass 2"[^>]*>/);
    assert.ok(!xml.includes('name="pass 2" detail="summary" omitted="all"'));
    assert.ok(xml.indexOf('name="pass 0"') < xml.indexOf('name="queue 1"'));
  });

  test("budgets addressed run summaries before current-run summaries", () => {
    const text = "s".repeat(PRIOR_CONTEXT_LIMITS.OUTPUT_TAIL_BYTES);
    const xml = buildPriorContextXmlFromItems([
      ...Array.from({ length: 27 }, (_, index) => ({
        index,
        stepKind: STEP_TYPES.PROMPT,
        name: `addressed ${index}`,
        text,
        detail: "summary" as const,
        importedRun: true,
      })),
      {
        index: 0,
        stepKind: "prompt",
        name: "current",
        text,
        detail: "summary",
      },
    ]);

    assert.match(xml, /name="addressed 0"[^>]*omitted="all"/);
    assert.ok(xml.includes('name="current" detail="summary"'));
  });

  test("maps inline references to the resolver's canonical context selectors", () => {
    assert.strictEqual(
      inlinePriorContextRefToPriorContext({ kind: "previous" }),
      "previous"
    );
    assert.deepStrictEqual(
      inlinePriorContextRefToPriorContext({ kind: "previous", count: 3 }),
      {
        previous: 3,
      }
    );
    assert.strictEqual(
      inlinePriorContextRefToPriorContext({ kind: "finalStep" }),
      "finalStepPrevious"
    );
    assert.deepStrictEqual(
      inlinePriorContextRefToPriorContext({ kind: "step", indices: [1, 3] }),
      [1, 3]
    );
  });
});
