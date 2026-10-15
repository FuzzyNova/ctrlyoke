import * as assert from "assert";
import { suite, test } from "mocha";
import { CliIntegration } from "../../core/harness/CliIntegration";
import {
  CTRLYOKE_MCP_MODES,
  EXECUTION_MODES,
  HARNESS_IDS,
  PERMISSION_MODES,
} from "../../types/DashboardConstants";
import type { RunningTerminalContext } from "../../core/harness/shared/CliExecutionRunner";
import type { ResolvedProperties } from "../../types/ExecutionPropertyTypes";
import { spawnIdentityHash } from "../../types/ExecutionSpawnIdentity";

function createResolvedProperties(
  overrides: Partial<ResolvedProperties> = {}
): ResolvedProperties {
  return {
    harness: HARNESS_IDS.CLAUDE_CLI,
    model: "test-model",
    executionMode: EXECUTION_MODES.INTERACTIVE,
    resumeSession: true,
    mcpServers: null,
    hooks: null,
    toolPermissions: null,
    ...overrides,
  };
}

function createRunningTerminalContext(
  spawnedWith: ResolvedProperties
): RunningTerminalContext {
  return {
    logPath: "session.log",
    sessionId: "session-existing",
    spawnedWith,
    spawnedWithSessionId: "session-existing",
  };
}

function getTerminalReuseIncompatibilityReason(
  ctx: RunningTerminalContext,
  curr: ResolvedProperties
): string | null {
  return (CliIntegration as any).getTerminalReuseIncompatibilityReason(
    ctx,
    curr,
    "session-existing"
  );
}

suite("ExecutionSpawnIdentity", () => {
  test("does not change when object keys are reordered", () => {
    const first = createResolvedProperties({
      hooks: [
        { event: "stop", command: "node hook.js", env: { B: "2", A: "1" } },
      ],
    });
    const second = createResolvedProperties({
      hooks: [
        { event: "stop", command: "node hook.js", env: { A: "1", B: "2" } },
      ],
    });

    assert.strictEqual(spawnIdentityHash(first), spawnIdentityHash(second));
  });

  test("preserves array order", () => {
    const first = createResolvedProperties({ secrets: ["FIRST", "SECOND"] });
    const second = createResolvedProperties({ secrets: ["SECOND", "FIRST"] });

    assert.notStrictEqual(spawnIdentityHash(first), spawnIdentityHash(second));
  });

  test("folds undefined and null together but not empty arrays", () => {
    const absent = createResolvedProperties();
    delete (absent as Partial<ResolvedProperties>).mcpServers;
    const explicitNull = createResolvedProperties({ mcpServers: null });
    const empty = createResolvedProperties({ mcpServers: [] });

    assert.strictEqual(
      spawnIdentityHash(absent),
      spawnIdentityHash(explicitNull)
    );
    assert.notStrictEqual(
      spawnIdentityHash(explicitNull),
      spawnIdentityHash(empty)
    );
  });

  test("changing each hashed field changes the hash", () => {
    const base = createResolvedProperties({
      toolPermissions: {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["read"],
        deniedTools: [],
      },
      hooks: [{ event: "stop", command: "node hook.js" }],
      mcpServers: [{ id: "server", command: "node server.js" }],
      additionalArgs: "--one",
      secrets: ["API_TOKEN"],
      ctrlyokeMcpMode: CTRLYOKE_MCP_MODES.NATIVE,
    });
    const changes: Partial<Record<keyof ResolvedProperties, unknown>> = {
      harness: HARNESS_IDS.COPILOT_CLI,
      model: "other-model",
      toolPermissions: {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["write"],
        deniedTools: [],
      },
      hooks: [{ event: "stop", command: "node other-hook.js" }],
      mcpServers: [{ id: "other-server", command: "node server.js" }],
      additionalArgs: "--two",
      secrets: ["OTHER_TOKEN"],
      ctrlyokeMcpMode: CTRLYOKE_MCP_MODES.SKILL,
    };

    for (const [field, value] of Object.entries(changes)) {
      const changed = { ...base, [field]: value } as ResolvedProperties;
      assert.notStrictEqual(
        spawnIdentityHash(base),
        spawnIdentityHash(changed),
        `${field} should change the spawn identity`
      );
    }
  });

  test("excludes sessionId, executionMode, agent, and skills", () => {
    const base = createResolvedProperties();
    const changed = createResolvedProperties({
      sessionId: "different-session",
      executionMode: EXECUTION_MODES.HEADLESS,
      agent: "different-agent",
      skills: ["different-skill"],
    });

    assert.strictEqual(spawnIdentityHash(base), spawnIdentityHash(changed));
  });

  test("equal hashes imply no terminal-reuse field change", () => {
    const previous = createResolvedProperties({
      hooks: [{ event: "stop", command: "node hook.js" }],
      mcpServers: [{ id: "server", command: "node server.js" }],
      secrets: ["API_TOKEN"],
    });
    const current = createResolvedProperties({
      hooks: [{ event: "stop", command: "node hook.js" }],
      mcpServers: [{ id: "server", command: "node server.js" }],
      secrets: ["API_TOKEN"],
      sessionId: "different-session",
      executionMode: EXECUTION_MODES.HEADLESS,
      agent: "different-agent",
      skills: ["different-skill"],
    });

    assert.strictEqual(spawnIdentityHash(previous), spawnIdentityHash(current));
    assert.strictEqual(
      getTerminalReuseIncompatibilityReason(
        createRunningTerminalContext(previous),
        current
      ),
      null
    );
  });
});
