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
import { ExecutionRootCoordinationStore } from "../../core/orchestration/ExecutionRootCoordinationStore";
import { STALE_HEARTBEAT_MS } from "../../utils/LockSafetyPrimitives";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

suite("ExecutionRootCoordination", function () {
  this.timeout(30_000);

  async function withPlatform<T>(
    platform: NodeJS.Platform,
    action: () => T | Promise<T>
  ): Promise<T> {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      ...descriptor,
      value: platform,
    });
    try {
      return await action();
    } finally {
      if (descriptor) Object.defineProperty(process, "platform", descriptor);
    }
  }

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
      ["", "src/a.ts"],
      ["", "**/*.md"],
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

  test("uses Windows path casing for claim overlap and release", async () => {
    const root = await tempDirectory();
    try {
      await withPlatform("win32", async () => {
        const registry = new CoordinationParticipantRegistry(root, {
          now: () => 10_000,
          processLivenessCheck: () => true,
        });
        const owner = await registry.registerParticipant({
          kind: "external",
          label: "owner",
          via: COORDINATION_PARTICIPANT_VIA.MCP,
        });
        const contender = await registry.registerParticipant({
          kind: "external",
          label: "contender",
          via: COORDINATION_PARTICIPANT_VIA.MCP,
        });
        const originalPath = "Coordination-Probe/R2/DIR";
        assert.deepStrictEqual((await owner.claim([originalPath])).granted, [
          originalPath,
        ]);
        assert.deepStrictEqual(
          (
            await contender.claim(["coordination-probe/r2/dir/child.txt"])
          ).denied.map((item) => item.owner.participantId),
          [owner.participantId]
        );
        assert.deepStrictEqual(
          await owner.release(["coordination-probe/r2/dir"]),
          [originalPath]
        );
        assert.deepStrictEqual((await registry.fold()).claims, []);

        const classEntries = [
          join(participant("class-owner"), 1),
          claim(participant("class-owner"), ["[A-Z]ile.ts"], 2),
          join(participant("class-contender", { pid: 43 }), 3),
          claim(participant("class-contender", { pid: 43 }), ["file.ts"], 4),
        ];
        assert.strictEqual(
          foldCoordinationEntries(classEntries, {
            now: 1_000,
            processLivenessCheck: () => true,
          }).claims.length,
          1
        );
      });
    } finally {
      await removeDirectory(root);
    }
  });

  test("keeps claim path comparisons case-sensitive on Linux", async () => {
    await withPlatform("linux", () => {
      const first = participant("first");
      const second = participant("second", { pid: 43 });
      const folded = foldCoordinationEntries(
        [
          join(first, 1),
          claim(first, ["Coordination-Probe/R2/DIR"], 2),
          join(second, 3),
          claim(second, ["coordination-probe/r2/dir/child.txt"], 4),
        ],
        { now: 1_000, processLivenessCheck: () => true }
      );
      assert.strictEqual(folded.claims.length, 2);
    });
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

  test("denies a claim when an earlier own claim masks another owner's conflict", async () => {
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

      assert.deepStrictEqual((await first.claim(["src/a.ts"])).granted, [
        "src/a.ts",
      ]);
      assert.deepStrictEqual((await second.claim(["src/b.ts"])).granted, [
        "src/b.ts",
      ]);

      const result = await first.claim(["src"]);
      assert.deepStrictEqual(result.granted, []);
      assert.deepStrictEqual(
        result.denied.map(({ path: claimPath, owner }) => [
          claimPath,
          owner.participantId,
        ]),
        [["src", second.participantId]]
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("replay denies a claim when an earlier own claim masks another owner", () => {
    const first = participant("first");
    const second = participant("second", { pid: 43 });
    const folded = foldCoordinationEntries(
      [
        join(first, 1),
        claim(first, ["src/a.ts"], 2),
        join(second, 3),
        claim(second, ["src/b.ts"], 4),
        claim(first, ["src"], 5),
      ],
      { now: 1_000, processLivenessCheck: () => true }
    );

    assert.deepStrictEqual(
      folded.claims.map(({ path: claimPath, owner }) => [
        claimPath,
        owner.participantId,
      ]),
      [
        ["src/a.ts", first.participantId],
        ["src/b.ts", second.participantId],
      ]
    );
  });

  test("finds a concrete conflict after an earlier own claim overlaps the glob", async () => {
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

      await first.claim(["src/a.ts"]);
      await second.claim(["src/b.ts"]);

      const result = await first.claim(["src/*.ts"]);
      assert.deepStrictEqual(result.granted, []);
      assert.deepStrictEqual(
        result.denied.map((item) => item.owner.participantId),
        [second.participantId]
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("grants a claim overlapping only the participant's own claims", async () => {
    const root = await tempDirectory();
    try {
      const registry = new CoordinationParticipantRegistry(root, {
        now: () => 10_000,
      });
      const owner = await registry.registerParticipant({
        kind: "external",
        label: "owner",
        via: COORDINATION_PARTICIPANT_VIA.MCP,
      });

      await owner.claim(["src/a.ts"]);
      assert.deepStrictEqual((await owner.claim(["src"])).granted, ["src"]);
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

  test("keeps a CLI claim live when a later join renews its lifecycle lease", () => {
    const firstJoin = participant("cli", {
      via: COORDINATION_PARTICIPANT_VIA.CLI,
      leaseExpiresAt: 50,
      pid: undefined,
      lastHeartbeat: undefined,
    });
    const latestJoin = { ...firstJoin, leaseExpiresAt: 75 };
    const folded = foldCoordinationEntries(
      [
        join(firstJoin, 1),
        claim(firstJoin, ["src/held.ts"], 2),
        join(latestJoin, 3),
      ],
      { now: 55 }
    );

    assert.deepStrictEqual(
      folded.participants.map((value) => value.participantId),
      ["cli"]
    );
    assert.deepStrictEqual(
      folded.claims.map((value) => value.path),
      ["src/held.ts"]
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

  test("compacts repeated CLI refreshes while preserving live claims and calls", async () => {
    for (const startsWithClaim of [false, true]) {
      const root = await tempDirectory();
      try {
        const registry = new CoordinationParticipantRegistry(root, {
          now: () => 10_000,
          processLivenessCheck: () => true,
          retention: { maxEntries: 5 },
        });
        const lease = await registry.registerParticipant({
          kind: "external",
          label: "CLI agent",
          via: COORDINATION_PARTICIPANT_VIA.CLI,
        });
        if (startsWithClaim) await lease.claim(["src/held.ts"]);

        const beforeRefreshes = await registry.fold();
        for (let index = 0; index < 25; index += 1) {
          await registry.heartbeatParticipant(lease.participantId);
        }
        assert.deepStrictEqual(await registry.fold(), beforeRefreshes);
        const compactedEntries = (
          await new ExecutionRootCoordinationStore(root).read({ limit: 100 })
        ).entries;
        assert.strictEqual(
          compactedEntries.filter(
            (entry) => entry.kind === COORDINATION_ENTRY_KINDS.JOIN
          ).length,
          2
        );
        assert.deepStrictEqual(
          (await registry.fold()).claims.map((entry) => entry.path),
          beforeRefreshes.claims.map((entry) => entry.path)
        );

        assert.deepStrictEqual(
          (await registry.claimPaths(lease.participantId, ["src/later.ts"]))
            .granted,
          ["src/later.ts"]
        );
        await registry.postNote(lease.participantId, "still active");
        assert.deepStrictEqual(
          await registry.releasePaths(lease.participantId),
          startsWithClaim ? ["src/held.ts", "src/later.ts"] : ["src/later.ts"]
        );
        assert.deepStrictEqual((await registry.fold()).claims, []);
      } finally {
        await removeDirectory(root);
      }
    }
  });

  test("reclaims capacity from dead PID and expired CLI participant joins", async () => {
    for (const staleKind of ["pid", "lease"] as const) {
      const root = await tempDirectory();
      let now = 10_000;
      let processAlive = true;
      try {
        const registry = new CoordinationParticipantRegistry(root, {
          now: () => now,
          processLivenessCheck: () => processAlive,
          cliParticipantTtlMinutes: 1,
          retention: { maxEntries: 5 },
        });
        const staleVia =
          staleKind === "pid"
            ? COORDINATION_PARTICIPANT_VIA.MCP
            : COORDINATION_PARTICIPANT_VIA.CLI;
        for (let index = 0; index < 5; index += 1) {
          await registry.registerParticipant({
            kind: "external",
            label: `stale-${index}`,
            via: staleVia,
          });
        }

        if (staleKind === "pid") {
          processAlive = false;
        } else {
          now += 60 * 1_000 + 1;
        }
        const writer = await registry.registerParticipant({
          kind: "external",
          label: "current writer",
          via: COORDINATION_PARTICIPANT_VIA.CLI,
        });
        await registry.postNote(writer.participantId, "capacity recovered");

        const entries = (
          await new ExecutionRootCoordinationStore(root).read({ limit: 20 })
        ).entries;
        assert.deepStrictEqual(
          entries.map((entry) => entry.kind),
          ["join", "join", "note"]
        );
        assert.strictEqual(entries[0].from.participantId, writer.participantId);
        assert.strictEqual(entries[1].from.participantId, writer.participantId);
        assert.strictEqual(entries[2].text, "capacity recovered");
      } finally {
        await removeDirectory(root);
      }
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
      assert.deepStrictEqual(folded.claims.map(({ path }) => path).sort(), [
        "src/other-group.ts",
        "src/other-run.ts",
      ]);
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

  suite("reader state", () => {
    async function twoParticipants(
      root: string,
      retention?: { readNotesPageSize: number }
    ) {
      const registry = new CoordinationParticipantRegistry(root, {
        ...(retention ? { retention } : {}),
      });
      const register = (label: string) =>
        registry.registerParticipant({
          kind: "external",
          label,
          via: COORDINATION_PARTICIPANT_VIA.MCP,
        });
      return {
        registry,
        reader: await register("reader"),
        writer: await register("writer"),
      };
    }

    const texts = (result: { entries: CoordinationEntry[] }) =>
      result.entries.map((entry) => entry.text);

    test("read_notes returns only unread notes and never the reader's own", async () => {
      const root = await tempDirectory();
      try {
        const { registry, reader, writer } = await twoParticipants(root);
        await registry.postNote(writer.participantId, "one");
        await registry.postNote(reader.participantId, "mine");
        await registry.postNote(writer.participantId, "two");

        assert.deepStrictEqual(
          texts(await registry.readNotes(reader.participantId)),
          ["one", "two"]
        );
        assert.deepStrictEqual(
          texts(await registry.readNotes(reader.participantId)),
          []
        );

        await registry.postNote(writer.participantId, "three");
        assert.deepStrictEqual(
          texts(await registry.readNotes(reader.participantId)),
          ["three"]
        );

        assert.deepStrictEqual(
          texts(await registry.readNotes(reader.participantId, { since: 0 })),
          ["one", "two", "three"],
          "an explicit since re-reads history"
        );
        assert.deepStrictEqual(
          texts(await registry.readNotes(reader.participantId)),
          [],
          "re-reading history must not move the cursor backwards"
        );
      } finally {
        await removeDirectory(root);
      }
    });

    test("a first read shows the newest page and counts the older notes", async () => {
      const root = await tempDirectory();
      try {
        const { registry, reader, writer } = await twoParticipants(root, {
          readNotesPageSize: 2,
        });
        for (const text of ["one", "two", "three"]) {
          await registry.postNote(writer.participantId, text);
        }

        const first = await registry.readNotes(reader.participantId);
        assert.deepStrictEqual(texts(first), ["two", "three"]);
        assert.strictEqual(first.omittedOlder, 1);
        assert.deepStrictEqual(
          texts(await registry.readNotes(reader.participantId)),
          []
        );
      } finally {
        await removeDirectory(root);
      }
    });

    test("a from filter does not mark skipped notes as read", async () => {
      const root = await tempDirectory();
      try {
        const { registry, reader, writer } = await twoParticipants(root);
        await registry.postNote(writer.participantId, "from writer");
        assert.deepStrictEqual(
          texts(
            await registry.readNotes(reader.participantId, {
              from: ["nobody"],
            })
          ),
          []
        );
        assert.deepStrictEqual(
          texts(await registry.readNotes(reader.participantId)),
          ["from writer"]
        );
      } finally {
        await removeDirectory(root);
      }
    });

    test("participantsIfChanged reports the list only when membership changes", async () => {
      const root = await tempDirectory();
      try {
        const { registry, reader } = await twoParticipants(root);
        assert.deepStrictEqual(
          (await registry.participantsIfChanged(reader.participantId))
            ?.map((value) => value.label)
            .sort(),
          ["reader", "writer"]
        );
        assert.strictEqual(
          await registry.participantsIfChanged(reader.participantId),
          undefined
        );

        const late = await registry.registerParticipant({
          kind: "external",
          label: "late",
          via: COORDINATION_PARTICIPANT_VIA.MCP,
        });
        assert.strictEqual(
          (await registry.participantsIfChanged(reader.participantId))?.length,
          3
        );
        await late.leave();
        assert.strictEqual(
          (await registry.participantsIfChanged(reader.participantId))?.length,
          2
        );
      } finally {
        await removeDirectory(root);
      }
    });
  });
});
