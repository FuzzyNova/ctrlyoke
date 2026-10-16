import * as assert from "assert";
import { suite, test } from "mocha";
import { trustExternalRootsCommand } from "../../cli/ExternalRootsTrustCommands";
import type { ExternalRootTrustDecision } from "../../config/ExternalRootsTrustStore";
import { TRUST_DECISIONS } from "../../types/DashboardConstants";
import { RecordingCliTrustIo } from "../helpers/RecordingCliTrustIo";

suite("External roots trust command", () => {
  const roots = ["/outside/data", "/outside/config"];

  function createStore() {
    const decisions: Array<{
      scope: string;
      roots: readonly string[];
      decision: ExternalRootTrustDecision;
    }> = [];
    return {
      decisions,
      store: {
        setDecisions: async (
          scope: string,
          selectedRoots: readonly string[],
          decision: ExternalRootTrustDecision
        ) => {
          decisions.push({ scope, roots: selectedRoots, decision });
        },
      },
    };
  }

  const run = (
    io: RecordingCliTrustIo,
    store: ReturnType<typeof createStore>["store"],
    yes = false
  ) =>
    trustExternalRootsCommand(
      "workspace-id",
      roots,
      "This workspace requests external roots:",
      "No pending roots.",
      { yes },
      io,
      store
    );

  test("without a terminal or --yes exits 2 and records no decisions", async () => {
    const io = new RecordingCliTrustIo(false);
    const { decisions, store } = createStore();

    const exitCode = await run(io, store);

    assert.strictEqual(exitCode, 2);
    assert.deepStrictEqual(decisions, []);
    assert.ok(io.err.some((line) => line.includes(roots[0])));
    assert.ok(io.err.some((line) => line.includes("--yes")));
  });

  test("--yes allows every pending root without prompting", async () => {
    const io = new RecordingCliTrustIo(false);
    const { decisions, store } = createStore();

    const exitCode = await run(io, store, true);

    assert.strictEqual(exitCode, 0);
    assert.deepStrictEqual(decisions, [
      { scope: "workspace-id", roots, decision: TRUST_DECISIONS.ALLOW },
    ]);
    assert.deepStrictEqual(io.questions, []);
  });

  test("interactive yes records allow and interactive no records deny", async () => {
    for (const [answer, decision] of [
      [true, TRUST_DECISIONS.ALLOW],
      [false, TRUST_DECISIONS.DENY],
    ] as const) {
      const io = new RecordingCliTrustIo(true, [answer]);
      const { decisions, store } = createStore();

      const exitCode = await run(io, store);

      assert.strictEqual(exitCode, 0);
      assert.strictEqual(decisions[0]?.decision, decision);
      assert.deepStrictEqual(decisions[0]?.roots, roots);
      assert.strictEqual(io.questions.length, 1);
    }
  });
});
