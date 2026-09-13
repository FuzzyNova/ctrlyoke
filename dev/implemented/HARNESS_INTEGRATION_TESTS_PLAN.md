# Harness Integration Tests — Expansion Plan

## Context

`npm run test:harness` currently contains one test file: `hooks.harness.test.ts`.

That test is excellent because it:

- Runs all harnesses against a single trivial task (run `ls`)
- Uses a Node.js recorder script as a side-channel to verify hook delivery
- Prefers free models (gpt-5-mini, big-pickle) or cheapest paid options (haiku)
- Is isolated from the main `npm test` suite (runs sparingly — harness tests cost usage)

This plan extends the harness suite with tests that cover features not exercised end-to-end
by either the existing hooks test or the main unit test suite.

---

## What Is Already Covered (Don't Duplicate)

### Covered by hooks.harness.test.ts (real harnesses)

- Single-step workflow runs to exit code 0 on all harnesses
- `stop`, `sessionStart`, `preToolUse`, `postToolUse`, `userPromptSubmit` hooks fire
- `--var` substitution works (used for outputFile path)
- `--headless` and `--verbose` flags work

### Covered by main unit suite (mocked, no real harnesses)

- `EndConditionHandler`: retry orchestration, retryPrompt templating, maxRetries ceiling
- `SessionResolver`: sessionId inheritance, `resumeSession`, numeric `sessionId: N` references
- `WorkflowExecutor`: multi-step execution loop, MCP finalStep wiring
- `CliIntegration`: prompt building, session flags, tool permission mapping
- `CliMcpConfigGenerator`: MCP config file generation
- `SettingsJsonHooksTracker`: hook registration lifecycle

**Gap**: all of the above are verified with mocks. The harness suite should prove these
features actually work when a real AI CLI is in the loop.

---

## Proposed New Tests

### Design Principles

1. **Prefer free models.** `copilot-cli` (gpt-5-mini) and `opencode-cli` (big-pickle) are
   free. Use them for anything that doesn't require cross-harness validation.
2. **Use side-channel verification.** Like the hook recorder, use filesystem side effects
   (files the AI writes, counter scripts, etc.) rather than parsing AI prose.
3. **Keep prompts deterministic.** Give the AI an explicit, short shell command to run
   rather than asking it to reason. This prevents flakiness from model variation.
4. **One file per feature area.** Mirrors the hooks test structure.
5. **Exit code 3 = skip** (harness not installed). Same pattern as hooks test.

---

### Test File 1: `src/test/harness/workflow.harness.test.ts`

Tests multi-step sequential execution and end conditions using `copilot-cli` and
`opencode-cli` (both free). These are the highest-value gaps.

#### Test 1.1 — Multi-step workflow runs both steps in sequence

**Why needed:** Unit tests mock WorkflowExecutor's loop. This proves that two real prompts
actually execute back-to-back, producing independent side effects from each.

**Approach:**

- Step 1 prompt: `"Run the bash command: echo step1 > cy-seq-test.txt"`
- Step 2 prompt: `"Run the bash command: echo step2 >> cy-seq-test.txt"`
- End condition script (step 2): reads `cy-seq-test.txt`, asserts both `step1` and `step2`
  appear in that order.
- Assert: exit code 0, both lines present in the output file.

**Harnesses:** `copilot-cli`, `opencode-cli`

#### Test 1.2 — End condition passes on first attempt

**Why needed:** `EndConditionHandler` is fully unit-tested, but the round-trip through the
real CLI (script isolation, exit code interpretation, cwd resolution) has never been
exercised with a live harness.

**Approach:**

- Step prompt: `"Run the bash command: echo SUCCESS > cy-end-cond.txt"`
- End condition script: reads `cy-end-cond.txt`, returns `true` if content is `SUCCESS`,
  else `false`.
- Assert: exit code 0, the file exists with the right content.

**Harnesses:** `copilot-cli`, `opencode-cli`

#### Test 1.3 — End condition fails once, retryPrompt fires, passes on retry

**Why needed:** Proves the full retry loop works with a real harness — the harness receives
`retryPrompt`, acts on it, and the end condition script eventually returns `true`.

**Approach (counter-based, avoids relying on AI cooperation for the failure):**

- End condition script: reads a counter file, increments it, returns `true` only when
  counter >= 2. First call always returns `false` even if the AI did the right thing.
- `retryPrompt`: `"The validation is not satisfied yet. Run: echo RETRY_DONE > cy-retry.txt"`
- Step prompt: `"Run: echo FIRST > cy-retry.txt"`
- Assert: exit code 0, counter file shows value 2, `cy-retry.txt` exists.

**Harnesses:** `copilot-cli` only (retry tests are slow; no need to run all harnesses)

---

### Test File 2: `src/test/harness/mcp.harness.test.ts`

Tests the MCP dynamic queue extension path, which is the most architecturally significant
feature with zero end-to-end harness coverage.

#### Test 2.1 — AI extends the queue via MCP tool call

**Why needed:** `enableDynamicQueue` / `mcpServers: ["flightpath"]` wires up an MCP server
that the AI can call to append new prompts. The wiring, MCP server startup, and round-trip
from AI tool call → new step executing have no harness-level test.

**Approach:**

- Single-step workflow with `mcpServers: ["flightpath"]`
- Step prompt: `"Use the flightpath_append_queue MCP tool to add one more step with the
prompt: 'Run the bash command: echo MCP_STEP_DONE > cy-mcp-test.txt'. Then stop."`
- Assert: exit code 0, `cy-mcp-test.txt` exists with content `MCP_STEP_DONE`, proving the
  MCP-appended step actually ran.

**Harnesses:** `copilot-cli` only (gpt-5-mini; free, capable of MCP tool calls)

**Notes:**

- The MCP server must be running; the CLI starts it automatically when `mcpServers:
["flightpath"]` is present. Verify exit code 3-style skip if MCP init fails.
- This test may be slow (two LLM calls). Set timeout to 120s.

---

## What We're Explicitly NOT Adding

| Feature                           | Reason to skip                                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resumeSession: true` end-to-end  | The unit test fully covers session ID threading; an AI resuming session in practice is indistinguishable from any two-step workflow at the test boundary |
| Tool permission enforcement       | Would require knowing which tools the AI will try and blocking one — too AI-dependent to be deterministic                                                |
| Cross-harness end condition tests | Hooks test already validates all harnesses run; end condition wiring is harness-agnostic, so testing on two free harnesses is sufficient                 |
| `copilot-chat` harness tests      | Requires VS Code window automation; fundamentally different from CLI harnesses; out of scope                                                             |

---

## File Structure

```
src/test/harness/
├── hooks.harness.test.ts          # existing — all harnesses, hook event delivery
├── workflow.harness.test.ts       # new — multi-step, end conditions, retry
└── mcp.harness.test.ts            # new — MCP dynamic queue extension
```

All three files are picked up by the existing `mocha` glob:
`"out/test/harness/**/*.test.js"`

---

## Shared Utilities

Extract common helpers from `hooks.harness.test.ts` into a shared module:

```
src/test/harness/helpers/
├── harnessRunner.ts    # runHarness(), buildWorkflow(), HARNESS_MODELS constants
└── assertHelpers.ts    # assertFileContains(), readCounter(), etc.
```

The hooks test currently embeds these inline. Extracting avoids duplication across the new
files and keeps each test file focused on its scenario.

---

## Run Strategy

```bash
# All harness tests (hooks + workflow + mcp)
npm run test:harness

# One suite only
npm run test:harness -- --grep "workflow"
npm run test:harness -- --grep "mcp"

# One harness only
npm run test:harness -- --grep "copilot-cli"
```

No new npm scripts needed — the existing `test:harness` glob covers the new files
automatically once they compile.

---

## Implementation Order

1. Extract shared helpers (`harnessRunner.ts`, `assertHelpers.ts`) from `hooks.harness.test.ts`
2. Implement `workflow.harness.test.ts` (Tests 1.1–1.3)
3. Implement `mcp.harness.test.ts` (Test 2.1)
4. Verify all tests pass against `copilot-cli` locally before enabling `opencode-cli` variants
