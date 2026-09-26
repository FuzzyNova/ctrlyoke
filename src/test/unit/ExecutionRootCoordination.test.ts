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
        kind: value.kind,
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
        kind: value.kind,
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
          kind: first.kind,
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
          kind: second.kind,
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

  test("detects path and glob intersections conservatively", () => {
    const overlappingPairs: Array<[string, string]> = [
      ["a*/file.txt", "*b/file.txt"],
      ["a*/file.txt", "ab/file.txt"],
      ["*b/file.txt", "ab/file.txt"],
      ["dir", "dir/child.ts"],
      ["dir/", "dir/**"],
      ["src/**", "src/core/x.ts"],
      ["**/*.md", "docs/a.md"],
      ["[ab]x", "bx"],
      ["dev/bugs", "dev/*/README.md"],
      ["./dir//", "dir/child.ts"],
    ];
    const disjointPairs: Array<[string, string]> = [
      ["a*/f", "b*/f"],
      ["src/*.ts", "src/*.js"],
      ["src/core", "src/corex"],
      ["x?", "xyz"],
      ["[ab]x", "cx"],
      ["dev/bugs", "dev/bugsy/x"],
    ];

    const foldPair = (leftPath: string, rightPath: string) => {
      const first = participant("first");
      const second = participant("second", { pid: 43 });
      return foldCoordinationEntries(
        [
          join(first, 1),
          claim(first, [leftPath], 2),
          join(second, 3),
          claim(second, [rightPath], 4),
        ],
        { now: 1_000, processLivenessCheck: () => true }
      );
    };

    for (const [left, right] of overlappingPairs) {
      assert.strictEqual(
        foldPair(left, right).claims.length,
        1,
        `${left} vs ${right}`
      );
      assert.strictEqual(
        foldPair(right, left).claims.length,
        1,
        `${right} vs ${left}`
      );
    }
    for (const [left, right] of disjointPairs) {
      assert.strictEqual(
        foldPair(left, right).claims.length,
        2,
        `${left} vs ${right}`
      );
    }
  });

  test("a shared concrete path conflicts with each overlapping wildcard claim", async () => {
    const root = await tempDirectory();
    try {
      const registry = new CoordinationParticipantRegistry(root, {
        now: () => 10_000,
      });
      const first = await registry.registerParticipant({
        kind: "external",
        label: "first",
        via: COORDINATION_PARTICIPANT_VIA.MCP,
      });
      const second = await registry.registerParticipant({
        kind: "external",
        label: "second",
        via: COORDINATION_PARTICIPANT_VIA.MCP,
      });
      assert.deepStrictEqual((await first.claim(["a*/file.txt"])).granted, [
        "a*/file.txt",
      ]);
      assert.deepStrictEqual(
        (await second.claim(["*b/file.txt"])).denied.map(
          (item) => item.owner.participantId
        ),
        [first.participantId]
      );
      assert.deepStrictEqual(
        (await second.claim(["ab/file.txt"])).denied.map(
          (item) => item.owner.participantId
        ),
        [first.participantId]
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("directory claims deny descendants in either claim order", async () => {
    for (const [firstPath, secondPath] of [
      ["dir", "dir/child.ts"],
      ["dir/child.ts", "dir"],
    ]) {
      const root = await tempDirectory();
      try {
        const registry = new CoordinationParticipantRegistry(root, {
          now: () => 10_000,
        });
        const first = await registry.registerParticipant({
          kind: "external",
          label: "first",
          via: COORDINATION_PARTICIPANT_VIA.MCP,
        });
        const second = await registry.registerParticipant({
          kind: "external",
          label: "second",
          via: COORDINATION_PARTICIPANT_VIA.MCP,
        });
        assert.deepStrictEqual((await first.claim([firstPath])).granted, [
          firstPath,
        ]);
        assert.deepStrictEqual(
          (await second.claim([secondPath])).denied.map(
            (item) => item.owner.participantId
          ),
          [first.participantId]
        );
      } finally {
        await removeDirectory(root);
      }
    }
  });

  test("reaps only pid-dead MCP participants, not merely heartbeat-stale ones", () => {
    const value = participant("mcp");
    const entries = [join(value, 1), claim(value, ["src/a.ts"], 2)];

    assert.strictEqual(
      foldCoordinationEntries(entries, {
        now: 1_000,
        processLivenessCheck: () => false,
      }).claims.length,
      0
    );
    // A quiet-but-alive MCP participant has no heartbeat ticker of its own —
    // lastHeartbeat only advances when it calls a coordination tool — so a
    // heartbeat gap past STALE_HEARTBEAT_MS must not reap a live pid. This is
    // the exact scenario Decision 2 of EXECUTION_ROOT_COORDINATION_PLAN.md
    // promises to handle correctly ("thinks for twenty minutes, keeps its
    // claim, because its process is still there").
    assert.strictEqual(
      foldCoordinationEntries(entries, {
        now: 1_000 + STALE_HEARTBEAT_MS + 1,
        processLivenessCheck: () => true,
      }).claims.length,
      1
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

  test("reuses one CLI participant per run address across separate calls", async () => {
    const root = await tempDirectory();
    let now = 10_000;
    try {
      const address = {
        workflowKey: "wf" as WorkflowKey,
        runRef: "run-1" as RunRef,
        stepIndex: 1,
        parallelGroupId: "group-1",
      };
      // A fresh registry per call mirrors the skill CLI, where every tool call
      // is a new process with no in-memory lease.
      const newRegistry = () =>
        new CoordinationParticipantRegistry(root, {
          now: () => now,
          processLivenessCheck: () => true,
        });
      const registerCliStep = (stepAddress = address) =>
        newRegistry().registerParticipant({
          kind: "ctrlyoke-step",
          label: "wf:1",
          via: COORDINATION_PARTICIPANT_VIA.CLI,
          address: stepAddress,
        });

      const first = await registerCliStep();
      await first.claim(["src/a.ts"]);

      now += 60_000;
      const second = await registerCliStep();
      assert.strictEqual(second.participantId, first.participantId);
      assert.ok(second.leaseExpiresAt! > first.leaseExpiresAt!);
      assert.deepStrictEqual((await second.claim(["src/a.ts"])).denied, []);
      assert.deepStrictEqual(await second.release(), ["src/a.ts"]);

      const sibling = await registerCliStep({ ...address, stepIndex: 2 });
      assert.notStrictEqual(sibling.participantId, first.participantId);
      assert.strictEqual((await newRegistry().fold()).participants.length, 2);

      now = second.leaseExpiresAt! + 1;
      const afterExpiry = await registerCliStep();
      assert.notStrictEqual(afterExpiry.participantId, first.participantId);
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

  test("a live-pid MCP claim survives compaction and stays exclusive past the heartbeat-stale window", async () => {
    const root = await tempDirectory();
    try {
      let now = 10_000;
      const registry = new CoordinationParticipantRegistry(root, {
        now: () => now,
        processLivenessCheck: () => true,
      });
      const owner = await registry.registerParticipant({
        kind: "external",
        label: "Codex CLI runner",
        via: COORDINATION_PARTICIPANT_VIA.MCP,
      });
      assert.deepStrictEqual(
        (await owner.claim(["manual-test/foo.yaml"])).granted,
        ["manual-test/foo.yaml"]
      );

      // The owner goes quiet (no tool call, so no heartbeat refresh) for
      // longer than STALE_HEARTBEAT_MS while its process stays alive. A
      // second participant then appends to the board, which re-runs
      // compaction over the whole board.
      now += STALE_HEARTBEAT_MS + 10_000;
      const contender = await registry.registerParticipant({
        kind: "external",
        label: "someone else",
        via: COORDINATION_PARTICIPANT_VIA.MCP,
      });

      const folded = await registry.fold();
      assert.strictEqual(folded.claims.length, 1);
      assert.strictEqual(folded.claims[0].path, "manual-test/foo.yaml");
      assert.strictEqual(
        folded.claims[0].owner.participantId,
        owner.participantId
      );

      const denied = await contender.claim(["manual-test/foo.yaml"]);
      assert.strictEqual(denied.granted.length, 0);
      assert.strictEqual(
        denied.denied[0].owner.participantId,
        owner.participantId
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("closes an unattested CLI participant for a settled sequential run", async () => {
    const root = await tempDirectory();
    try {
      const registry = new CoordinationParticipantRegistry(root, {
        now: () => 10_000,
        processLivenessCheck: () => true,
      });
      const address = {
        workflowKey: "workflow" as WorkflowKey,
        runRef: "run-1" as RunRef,
      };
      const lease = await registry.registerParticipant({
        kind: "ctrlyoke-step",
        label: "step",
        via: COORDINATION_PARTICIPANT_VIA.CLI,
        address: { ...address, stepIndex: 0 },
      });
      await lease.claim(["src/a.ts"]);

      await registry.closeRunParticipants({
        ...address,
        stepIndex: 1,
      });

      const folded = await registry.fold();
      assert.strictEqual(folded.participants.length, 0);
      assert.strictEqual(folded.claims.length, 0);
    } finally {
      await removeDirectory(root);
    }
  });

  test("releases and closes an unattested CLI group member at the join", async () => {
    const root = await tempDirectory();
    try {
      const registry = new CoordinationParticipantRegistry(root, {
        now: () => 10_000,
        processLivenessCheck: () => true,
      });
      const address = {
        workflowKey: "workflow" as WorkflowKey,
        runRef: "run-1" as RunRef,
        parallelGroupId: "group-1",
      };
      const lease = await registry.registerParticipant({
        kind: "ctrlyoke-step",
        label: "group member",
        via: COORDINATION_PARTICIPANT_VIA.CLI,
        address: { ...address, stepIndex: 1 },
      });
      await lease.claim(["src/a.ts"]);

      await registry.releaseClaimsForGroup(address);
      await registry.closeGroupParticipants(address);

      const folded = await registry.fold();
      assert.strictEqual(folded.participants.length, 0);
      assert.strictEqual(folded.claims.length, 0);

      const laterParticipant = await registry.registerParticipant({
        kind: "ctrlyoke-step",
        label: "later step",
        via: COORDINATION_PARTICIPANT_VIA.CLI,
        address: {
          workflowKey: address.workflowKey,
          runRef: address.runRef,
          stepIndex: 2,
        },
      });
      const claimResult = await laterParticipant.claim(["src/a.ts"]);
      assert.deepStrictEqual(claimResult.granted, ["src/a.ts"]);
    } finally {
      await removeDirectory(root);
    }
  });

  test("settlement leaves external claims untouched", async () => {
    const root = await tempDirectory();
    try {
      const registry = new CoordinationParticipantRegistry(root, {
        now: () => 10_000,
        processLivenessCheck: () => true,
      });
      const address = {
        workflowKey: "workflow" as WorkflowKey,
        runRef: "run-1" as RunRef,
        parallelGroupId: "group-1",
      };
      const external = await registry.registerParticipant({
        kind: "external",
        label: "external session",
        via: COORDINATION_PARTICIPANT_VIA.CLI,
      });
      await external.claim(["src/a.ts"]);

      await registry.releaseClaimsForGroup(address);
      await registry.closeGroupParticipants(address);

      const folded = await registry.fold();
      assert.strictEqual(folded.participants.length, 1);
      assert.strictEqual(
        folded.participants[0].participantId,
        external.participantId
      );
      assert.strictEqual(folded.claims.length, 1);
      assert.strictEqual(
        folded.claims[0].owner.participantId,
        external.participantId
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("group settlement leaves members of other runs and groups untouched", async () => {
    const root = await tempDirectory();
    try {
      const registry = new CoordinationParticipantRegistry(root, {
        now: () => 10_000,
        processLivenessCheck: () => true,
      });
      const address = {
        workflowKey: "workflow" as WorkflowKey,
        runRef: "run-1" as RunRef,
        parallelGroupId: "group-1",
      };
      const otherRun = await registry.registerParticipant({
        kind: "ctrlyoke-step",
        label: "other run",
        via: COORDINATION_PARTICIPANT_VIA.CLI,
        address: { ...address, runRef: "run-2" as RunRef, stepIndex: 1 },
      });
      const otherGroup = await registry.registerParticipant({
        kind: "ctrlyoke-step",
        label: "other group",
        via: COORDINATION_PARTICIPANT_VIA.CLI,
        address: { ...address, parallelGroupId: "group-2", stepIndex: 1 },
      });
      await otherRun.claim(["src/other-run.ts"]);
      await otherGroup.claim(["src/other-group.ts"]);

      await registry.releaseClaimsForGroup(address);
      await registry.closeGroupParticipants(address);

      const folded = await registry.fold();
      assert.deepStrictEqual(
        folded.participants.map(({ participantId }) => participantId).sort(),
        [otherRun.participantId, otherGroup.participantId].sort()
      );
      assert.deepStrictEqual(
        folded.claims.map(({ path }) => path).sort(),
        ["src/other-group.ts", "src/other-run.ts"]
      );
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
