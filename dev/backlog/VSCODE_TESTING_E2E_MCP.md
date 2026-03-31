# VS Code Extension E2E Testing & MCP Automation Research

**Date:** 2026-03-13
**Context:** Evaluated while adding Vitest webview unit testing (Phase 1). These are the two next-tier options beyond unit/component tests.

---

## Option A: vscode-extension-tester (ExTester)

### What it is

ExTester (`vscode-extension-tester`, maintained by Red Hat) is the closest thing to an official VS Code extension UI testing framework. It wraps ChromeDriver (Selenium) around a managed VS Code Electron instance and provides a `WebView` abstraction capable of entering the webview iframe context via `driver.switchTo().frame()`.

- GitHub: https://github.com/redhat-developer/vscode-extension-tester
- Companion UI lib: `vscode-extension-ui-automation`
- Current version: ~8.23.x (actively maintained as of March 2026)

### What it can do

- Launch a real VS Code instance (downloads it if not cached, ~500MB)
- Drive the VS Code UI: open files, trigger commands, interact with the sidebar
- Switch frame context into a webview iframe and query DOM elements inside it
- Assert on webview content, click buttons, fill inputs

### Why it's attractive for FlightPath

The FlightPath dashboard (sidebar webview) is the primary UI surface. ExTester could:

- Verify the webview renders after a workflow file is loaded
- Assert button states (Run enabled/disabled, Undo enabled/disabled)
- Simulate adding a prompt and verifying the list updates
- Test the undo/redo round-trip by pressing Ctrl+Z and checking the DOM

### Known limitations

**Iframe timing fragility.** The webview iframe takes time to initialize — React must mount, the extension must send the INIT message, and the store must process it. ExTester's `WebView.open()` has retry logic but it's tuned for simple webviews, not complex async-initialized React apps. In practice, tests need manual `driver.sleep()` calls or custom polling loops to wait for the dashboard to be ready. This is the primary source of flakiness.

**ChromeDriver version pinning.** ChromeDriver must match the Chromium version bundled inside the specific VS Code release being tested. ExTester manages this automatically via its setup step, but it means you can't mix ExTester with a Playwright-based runner in the same process. If VS Code ships a Chromium update mid-week, CI may break until ExTester releases a matching ChromeDriver.

**Selenium API vs Playwright.** The test authoring experience is noticeably worse than Playwright — verbose selectors, less ergonomic waits, weaker TypeScript types.

**Slow CI.** First run downloads VS Code + ChromeDriver (~500MB total, cached after). Each test suite launch starts a full Electron process (5-10 seconds). Parallelisation is not straightforward.

**Webview message timing.** FlightPath's webview is driven by a message protocol (extension → webview via `postMessage`). ExTester has no awareness of this channel — you're asserting on DOM state that only becomes correct after messages have been processed. Combined with the iframe timing issue, this makes assertions on dynamic content (prompt list length, step statuses) genuinely hard to make non-flaky.

### Verdict

**Defer.** The setup cost is ~2-3 days and the ongoing maintenance cost of iframe-timing flakiness is high relative to the coverage gain. Unit tests (Vitest) and store-level integration tests cover the business logic. ExTester is most valuable for smoke tests like "the webview renders at all" and "the Run button exists" — low-confidence assertions that don't justify the investment right now.

Revisit if there are regression bugs that unit tests consistently miss due to the webview↔extension message contract.

---

## Option B: Custom MCP Server for VS Code Automation

### The idea

Build a VS Code extension (or add to the existing FlightPath extension) that exposes an MCP server. An AI agent (Claude Code) connects to it and can issue commands, inspect extension state, and exercise the message protocol — without needing DOM access.

This is the "message contract testing" approach: instead of asserting on rendered pixels, assert on what the extension _does_ when the webview sends it a specific message.

### What exists today

**Nothing purpose-built.** As of March 2026:

- The Playwright MCP server (`@playwright/mcp`) automates web browsers only — no Electron or VS Code support
- The Claude Code VS Code extension exposes `mcp__ide__executeCode` and `mcp__ide__getDiagnostics` but not webview interaction or command-level VS Code control
- vscode-extension-tester is Selenium-based, not MCP-based

### What VS Code APIs would be needed

FlightPath already has `@modelcontextprotocol/sdk` as a dependency (it runs a stdio MCP server for queue management). The extension already knows how to run an MCP server. The missing pieces for UI automation are:

**Command execution** — straightforward:

```typescript
vscode.commands.executeCommand("flightpath.run");
vscode.commands.executeCommand("workbench.action.openSettings", "flightpath");
```

Expose via MCP tool: `execute_vscode_command(command: string, args?: unknown[])`.

**Extension state inspection** — straightforward:

```typescript
// Read WorkflowOrchestrator state
orchestrator.getActiveInstance()?.promptQueue.getState();
```

Expose via MCP tool: `get_queue_state() → { status, prompts, currentIndex, ... }`.

**Sending messages to the webview** — already exists:

```typescript
webviewProvider.postMessage({ type: "PROMPTS_EXTENDED", prompts: [...] })
```

Expose via MCP tool: `send_webview_message(type: string, payload: object)`.

**Reading DOM state from the webview** — this is the hard part. VS Code provides no API to query webview DOM from the extension host. The webview runs in a sandboxed iframe and only communicates via `postMessage`. To make webview DOM state observable from an MCP tool, the webview itself must be modified to report its state back.

### The "test mode" pattern

The cleanest approach: add a `TEST_MODE` flag to the webview. When enabled, the webview periodically posts its rendered state as a JSON snapshot:

```typescript
// In the webview (React), when TEST_MODE is active:
useEffect(() => {
  const interval = setInterval(() => {
    vscode.postMessage({
      type: "WEBVIEW_STATE_SNAPSHOT",
      state: {
        promptCount: prompts.length,
        executionState,
        canUndo: temporal.pastStates.length > 0,
        canRedo: temporal.futureStates.length > 0,
        undoDepth: temporal.pastStates.length,
        headerButtons: { runEnabled: canRun, undoEnabled: canUndo },
      },
    });
  }, 100);
  return () => clearInterval(interval);
}, [prompts, executionState, temporal]);
```

The extension MCP tool `get_webview_state()` waits for the next snapshot and returns it.

Combined with `send_webview_message()` and `execute_vscode_command()`, an AI agent could run a full undo/redo scenario:

```
1. execute_vscode_command("flightpath.loadWorkflow", ["/path/to/test.flightpath.yaml"])
2. get_webview_state() → { promptCount: 1, canUndo: false }
3. send_webview_message("QUEUE_PROMPT", { text: "new prompt" })
4. get_webview_state() → { promptCount: 2, canUndo: true, undoDepth: 1 }
5. execute_vscode_command("flightpath.undo")  // or send keyboard shortcut
6. get_webview_state() → { promptCount: 1, canUndo: false }
   ✓ Undo worked correctly
```

No DOM access required. No iframe timing fragility. No ChromeDriver.

### Scope and effort estimate

**Minimal viable version (1-2 days):**

- Add 3 MCP tools to the existing FlightPath MCP server (or a new dev-only server): `execute_vscode_command`, `get_queue_state`, `send_webview_message`
- Add `get_webview_state` by wiring a simple state-reporter into the webview (behind a dev flag)
- Write a handful of "scenario scripts" that Claude Code can run via these tools

**Full version (1 week):**

- Proper MCP server in a separate VS Code extension (doesn't require FlightPath-specific code)
- Richer webview state snapshot (accessibility tree excerpt, visible element list)
- Documented protocol so any Claude Code session can pick up and run test scenarios
- CI integration: launch VS Code in headless Electron, connect MCP, run scenarios, exit

### What this enables that nothing else does

1. **AI-driven manual testing** — Claude Code can run a scenario script, observe the result, and report pass/fail without a human clicking through the UI. This closes the gap between unit tests (which test logic in isolation) and the real thing (which tests the full message round-trip).

2. **Regression verification** — after fixing a bug like the 4-undo issue, Claude Code can run a scenario to confirm it's fixed, rather than handing off to a human for manual verification.

3. **Exploratory testing** — an AI agent can be told "test the undo/redo feature" and improvise a test plan using the available MCP tools, without a pre-written script.

4. **Works with the existing architecture** — no changes to how FlightPath runs. The MCP channel is a thin observability layer, not a replacement for the real UI.

### Relationship to FlightPath's existing MCP server

FlightPath already ships `src/mcp-server.ts` (a stdio server for queue management). The automation MCP server would be separate — either:

- A second server in the same extension (different stdio process)
- A standalone VS Code extension that any project can use
- A dev-only server registered in `DevCommands.ts` (stripped from production builds)

The standalone extension approach is the most reusable and aligns with the "side project" framing — it would be useful to anyone building VS Code extensions with webviews, not just FlightPath.

### References

- FlightPath MCP server: `src/mcp-server.ts`
- Dev-only commands pattern: `src/dev/DevCommands.ts` (stripped at `IS_DEV_MODE = false`)
- VS Code webview message API: `WebviewView.webview.postMessage()`, `onDidReceiveMessage`
- MCP SDK already in deps: `@modelcontextprotocol/sdk`
- VS Code commands reference: `docs/reference/VSCODE_COMMANDS.md`
