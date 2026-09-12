import * as assert from "assert";
import { suite, test } from "mocha";
import {
  COORDINATION_ENTRY_KINDS,
  COORDINATION_PARTICIPANT_VIA,
} from "../../types/DashboardConstants";
import type {
  CoordinationEntry,
  CoordinationParticipant,
  RunRef,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";
import {
  COORDINATION_CLI_LEASE_TTL_MS,
  CoordinationParticipantRegistry,
  foldCoordinationEntries,
} from "../../core/orchestration/ExecutionRootCoordination";
import { STALE_HEARTBEAT_MS } from "../../utils/LockSafetyPrimitives";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

suite("ExecutionRootCoordination", function () {
  this.timeout(30_000);

  async function tempDirectory(): Promise<string> {
    return fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-coordination-registry-")
    );
  }

  async function removeDirectory(directory: string): Promise<void> {
    await fs.rm(directory, { recursive: true, force: true });
  }

  function participant(
    participantId: string,
    overrides: Partial<CoordinationParticipant> = {}
  ): CoordinationParticipant {
    return {
      participantId,
      kind: "external",
      attested: false,
      label: participantId,
      via: COORDINATION_PARTICIPANT_VIA.MCP,
      pid: 42,
      lastHeartbeat: 1_000,
      ...overrides,
    };
  }

  function join(
    value: CoordinationParticipant,
    seq: number
  ): CoordinationEntry {
    return {
      seq,
      at: new Date(seq).toISOString(),
      kind: COORDINATION_ENTRY_KINDS.JOIN,
      from: {
        participantId: value.participantId,
        label: value.label,
        attested: value.attested,
        ...(value.address ? { address: value.address } : {}),
      },
      participant: value,
      via: value.via,
    };
  }

  function claim(
    value: CoordinationParticipant,
    paths: string[],
    seq: number
  ): CoordinationEntry {
    return {
      seq,
      at: new Date(seq).toISOString(),
      kind: COORDINATION_ENTRY_KINDS.CLAIM,
      from: {
        participantId: value.participantId,
        label: value.label,
        attested: value.attested,
      },
      paths,
      via: value.via,
    };
  }

  test("folds claim, release, join, and leave interleavings", () => {
    const first = participant("first");
    const second = participant("second", { pid: 43 });
    const entries: CoordinationEntry[] = [
      join(first, 1),
      claim(first, ["src/a.ts"], 2),
      {
        seq: 3,
        at: new Date(3).toISOString(),
        kind: COORDINATION_ENTRY_KINDS.RELEASE,
        from: {
          participantId: first.participantId,
          label: first.label,
          attested: false,
        },
        paths: ["src/a.ts"],
        via: first.via,
      },
      join(second, 4),
      claim(second, ["src/a.ts"], 5),
      {
        seq: 6,
        at: new Date(6).toISOString(),
        kind: COORDINATION_ENTRY_KINDS.LEAVE,
        from: {
          participantId: second.participantId,
          label: second.label,
          attested: false,
        },
        via: second.via,
      },
    ];

    const folded = foldCoordinationEntries(entries, {
      now: 1_000,
      processLivenessCheck: () => true,
    });
    assert.deepStrictEqual(
      folded.participants.map((value) => value.participantId),
      ["first"]
    );
    assert.deepStrictEqual(folded.claims, []);
  });

  test("reaps dead and heartbeat-stale MCP participants", () => {
    const value = participant("mcp");
    const entries = [join(value, 1), claim(value, ["src/a.ts"], 2)];

    assert.strictEqual(
      foldCoordinationEntries(entries, {
        now: 1_000,
        processLivenessCheck: () => false,
      }).claims.length,
      0
    );
    assert.strictEqual(
      foldCoordinationEntries(entries, {
        now: 1_000 + STALE_HEARTBEAT_MS + 1,
        processLivenessCheck: () => true,
      }).claims.length,
      0
    );
  });

  test("keeps claims for a live MCP participant with a current heartbeat", () => {
    const value = participant("mcp", {
      lastHeartbeat: 1_000 + STALE_HEARTBEAT_MS + 1,
    });
    const entries = [join(value, 1), claim(value, ["src/a.ts"], 2)];

    const folded = foldCoordinationEntries(entries, {
      now: value.lastHeartbeat! + STALE_HEARTBEAT_MS - 1,
      processLivenessCheck: () => true,
    });
    assert.strictEqual(folded.claims.length, 1);
  });

  test("supports CLI TTL expiry and refresh by a board call", async () => {
    const root = await tempDirectory();
    let now = 10_000;
    try {
      const registry = new CoordinationParticipantRegistry(root, {
        now: () => now,
        processLivenessCheck: () => true,
      });
      const lease = await registry.registerParticipant({
        kind: "external",
        label: "CLI agent",
        via: COORDINATION_PARTICIPANT_VIA.CLI,
      });
      await lease.claim(["src/a.ts"]);
      const originalExpiry = lease.leaseExpiresAt!;
      now = originalExpiry + 1;
      assert.strictEqual((await registry.fold()).claims.length, 0);

      const refreshed = await registry.registerParticipant({
        kind: "external",
        label: "second CLI agent",
        via: COORDINATION_PARTICIPANT_VIA.CLI,
      });
      await registry.claimPaths(refreshed.participantId, ["src/b.ts"]);
      const refreshedExpiry = refreshed.leaseExpiresAt!;
      now = refreshedExpiry - 1;
      await registry.claimPaths(refreshed.participantId, ["src/b.ts"]);
      now = refreshedExpiry + 1;
      assert.strictEqual((await registry.fold()).claims.length, 1);
      assert.strictEqual(COORDINATION_CLI_LEASE_TTL_MS, 30 * 60 * 1_000);
    } finally {
      await removeDirectory(root);
    }
  });

  test("re-claiming an owned path is idempotent and overlapping globs name the owner", async () => {
    const root = await tempDirectory();
    try {
      const registry = new CoordinationParticipantRegistry(root, {
        now: () => 10_000,
      });
      const owner = await registry.registerAttestedParticipant({
        kind: "ctrlyoke-step",
        label: "orchestrator",
        via: COORDINATION_PARTICIPANT_VIA.MCP,
      });
      const contender = await registry.registerParticipant({
        kind: "external",
        label: "external editor",
        via: COORDINATION_PARTICIPANT_VIA.MCP,
      });
      assert.deepStrictEqual((await owner.claim(["src/**/*.ts"])).granted, [
        "src/**/*.ts",
      ]);
      assert.deepStrictEqual((await owner.claim(["src/**/*.ts"])).granted, [
        "src/**/*.ts",
      ]);

      const denied = await contender.claim(["src/foo.ts"]);
      assert.strictEqual(denied.granted.length, 0);
      assert.strictEqual(denied.denied[0].owner.label, "orchestrator");
      assert.strictEqual(denied.denied[0].owner.attested, true);
    } finally {
      await removeDirectory(root);
    }
  });

  test("folds a participant without stepIndex normally", () => {
    const value = participant("no-step-index", {
      address: {
        workflowKey: "workflow" as WorkflowKey,
        runRef: "run-1" as RunRef,
      },
    });
    const folded = foldCoordinationEntries(
      [join(value, 1), claim(value, ["README.md"], 2)],
      { now: 1_000, processLivenessCheck: () => true }
    );
    assert.strictEqual(folded.participants[0].address?.stepIndex, undefined);
    assert.strictEqual(folded.claims[0].path, "README.md");
  });
});
