import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  CURRENT_SCHEMA_VERSIONS,
  hasNewerSchema,
  isNewerSchemaError,
  NewerSchemaError,
  onNewerSchemaRefusal,
  PERSISTED_STORES,
  prepareRunFileForWrite,
  readSchemaVersion,
} from "../../utils/PersistedSchemaGuard";
import {
  LifetimeUsageStore,
  LIFETIME_USAGE_ERROR_CODES,
} from "../../core/harness/shared/usage/LifetimeUsageStore";
import {
  ObservedHarnessUsageStore,
  OBSERVED_USAGE_ERROR_CODES,
} from "../../core/harness/shared/usage/ObservedHarnessUsageStore";
import { HarnessUsageService } from "../../core/harness/shared/usage/HarnessUsageService";
import { providerSnapshotsPath } from "../../utils/UsagePaths";
import { formatRunRef } from "../../utils/WorkflowPaths";
import {
  EXECUTION_STATES,
  RUNNER_IDS,
  WORKFLOW_LOCK_LIVENESS,
  WORKFLOW_LOCK_LOCALITIES,
} from "../../types/DashboardConstants";
import type {
  RunRef,
  WorkflowKey,
  WorkflowRunnerLock,
  WorkingFile,
} from "../../types/CtrlYokeTypes";
import { inspectWorkflowLockOwnership } from "../../utils/WorkflowLockInspector";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { WorkingFileManager } from "../../core/WorkingFileManager";
import { ExternalRootsTrustStore } from "../../config/ExternalRootsTrustStore";
import { SecretGrantsTrustStore } from "../../config/SecretGrantsTrustStore";
import { TRUST_DECISIONS } from "../../types/DashboardConstants";
import { ExecutionRootCoordinationStore } from "../../core/orchestration/ExecutionRootCoordinationStore";

/** Awaits the persistence the service otherwise fires and forgets. */
class PersistingUsageService extends HarnessUsageService {
  persistNow(): Promise<void> {
    return this.persistProviderSnapshots();
  }
}

/** One past what this build supports: "written by a newer ctrlyoke". */
function newerThan(store: keyof typeof CURRENT_SCHEMA_VERSIONS): number {
  return CURRENT_SCHEMA_VERSIONS[store] + 1;
}

async function assertRefusesNewer(
  store: (typeof PERSISTED_STORES)[keyof typeof PERSISTED_STORES],
  action: () => Promise<unknown>
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(isNewerSchemaError(error), `expected NewerSchemaError: ${error}`);
    assert.strictEqual((error as NewerSchemaError).store, store);
    assert.match((error as Error).message, /newer version of ctrlyoke/);
    return true;
  });
}

suite("PersistedSchemaGuard", () => {
  let tempRoot: string;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-schema-"));
  });

  teardown(async () => {
    await fs.rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  suite("version helpers", () => {
    test("a missing or non-integer version is not newer", () => {
      assert.strictEqual(readSchemaVersion({}), undefined);
      assert.strictEqual(readSchemaVersion({ schemaVersion: "9" }), undefined);
      assert.strictEqual(readSchemaVersion(null), undefined);
      assert.strictEqual(
        hasNewerSchema(PERSISTED_STORES.RUN_FILE, { schemaVersion: 1.5 }),
        false
      );
    });

    test("prepareRunFileForWrite stamps the current version", () => {
      const unversioned = { _runtime: { currentIndex: 0 } };
      const stamped = prepareRunFileForWrite(unversioned, "run.json");
      assert.strictEqual(
        readSchemaVersion(stamped._runtime),
        CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.RUN_FILE]
      );
    });

    test("every refusal reaches the listeners, even one the caller swallows", () => {
      const seen: NewerSchemaError[] = [];
      const unsubscribe = onNewerSchemaRefusal((error) => seen.push(error));
      try {
        try {
          prepareRunFileForWrite(
            {
              _runtime: { schemaVersion: newerThan(PERSISTED_STORES.RUN_FILE) },
            },
            "run.json"
          );
        } catch {
          // The executor catches this and reports a failed step.
        }
      } finally {
        unsubscribe();
      }
      assert.deepStrictEqual(
        seen.map((error) => error.store),
        [PERSISTED_STORES.RUN_FILE]
      );
    });

    test("prepareRunFileForWrite refuses a newer run file", () => {
      assert.throws(
        () =>
          prepareRunFileForWrite(
            {
              _runtime: {
                schemaVersion: newerThan(PERSISTED_STORES.RUN_FILE),
              },
            },
            "run.json"
          ),
        NewerSchemaError
      );
    });
  });

  suite("usage statistics", () => {
    let previousHome: string | undefined;

    setup(() => {
      previousHome = process.env.CTRLYOKE_HOME;
      process.env.CTRLYOKE_HOME = path.join(tempRoot, "home");
    });

    teardown(() => {
      if (previousHome === undefined) {
        delete process.env.CTRLYOKE_HOME;
      } else {
        process.env.CTRLYOKE_HOME = previousHome;
      }
    });

    async function writeNewer(
      filePath: string,
      store: (typeof PERSISTED_STORES)[keyof typeof PERSISTED_STORES]
    ): Promise<string> {
      const contents = JSON.stringify({
        schemaVersion: newerThan(store),
        someNewField: true,
      });
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents, "utf8");
      return contents;
    }

    async function assertUntouched(
      filePath: string,
      contents: string
    ): Promise<void> {
      assert.strictEqual(await fs.readFile(filePath, "utf8"), contents);
      const siblings = await fs.readdir(path.dirname(filePath));
      assert.ok(
        !siblings.some((file) => file.includes(".corrupt-")),
        `a newer file must not be quarantined: ${siblings.join(", ")}`
      );
    }

    test("lifetime stats: refused and left in place, not quarantined", async () => {
      const store = new LifetimeUsageStore(tempRoot);
      const contents = await writeNewer(
        store.getPath(),
        PERSISTED_STORES.LIFETIME_USAGE
      );

      await assertRefusesNewer(PERSISTED_STORES.LIFETIME_USAGE, () =>
        store.read()
      );
      await assert.rejects(store.fullRebuild());
      assert.strictEqual(
        store.getLastErrorCode(),
        LIFETIME_USAGE_ERROR_CODES.NEWER_DATA
      );
      await assertUntouched(store.getPath(), contents);
    });

    test("observed usage: refused and left in place, not quarantined", async () => {
      const store = new ObservedHarnessUsageStore(tempRoot);
      const contents = await writeNewer(
        store.getPath(),
        PERSISTED_STORES.OBSERVED_USAGE
      );

      await assertRefusesNewer(PERSISTED_STORES.OBSERVED_USAGE, () =>
        store.read()
      );
      await assert.rejects(
        store.upsertRunContribution(
          "schema-usage" as WorkflowKey,
          formatRunRef(Date.now()),
          undefined
        )
      );
      assert.strictEqual(
        store.getLastErrorCode(),
        OBSERVED_USAGE_ERROR_CODES.NEWER_DATA
      );
      await assertUntouched(store.getPath(), contents);
    });

    test("provider snapshots: not loaded, not overwritten, not quarantined", async () => {
      const filePath = providerSnapshotsPath();
      const contents = await writeNewer(
        filePath,
        PERSISTED_STORES.PROVIDER_USAGE
      );

      const service = new PersistingUsageService(tempRoot, []);
      await service.initialize();
      await service.persistNow();
      await assertUntouched(filePath, contents);
    });
  });

  suite("runner lock", () => {
    const workflowKey = "schema-lock" as WorkflowKey;
    const runRef = "run-2026-01-01T00-00-00-000Z" as RunRef;

    function newerLock(overrides: Record<string, unknown> = {}) {
      return {
        schemaVersion: newerThan(PERSISTED_STORES.RUNNER_LOCK),
        workflowKey,
        runRef,
        // A newer format may drop or rename the fields this build reads.
        ...overrides,
      };
    }

    test("a newer lock is held even when its liveness fields are unreadable", () => {
      const inspection = inspectWorkflowLockOwnership(newerLock(), {
        runner: RUNNER_IDS.VSCODE,
        hostInstanceId: "observer",
        pid: process.pid,
      });
      assert.strictEqual(inspection.liveness, WORKFLOW_LOCK_LIVENESS.ACTIVE);
      assert.strictEqual(
        inspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE &&
          inspection.locality,
        WORKFLOW_LOCK_LOCALITIES.INDETERMINATE
      );
    });

    test("stale-lock recovery leaves a newer lock and its run alone", async () => {
      const lockPath = WorkflowPaths.runnerLockPath(tempRoot, workflowKey);
      const runFile = WorkflowPaths.runFilePath(tempRoot, workflowKey, runRef);
      await fs.mkdir(path.dirname(runFile), { recursive: true });
      const runContent = JSON.stringify({
        _runtime: { currentIndex: 0, executionState: EXECUTION_STATES.RUNNING },
      });
      await fs.writeFile(runFile, runContent, "utf8");
      // Dead PID and ancient heartbeat: stale by this build's rules.
      await fs.writeFile(
        lockPath,
        JSON.stringify(newerLock({ pid: 999_999_999, lastHeartbeat: 0 })),
        "utf8"
      );

      const result = await WorkflowLockManager.normalizeStaleLocks(tempRoot, [
        workflowKey,
      ]);

      assert.deepStrictEqual(result.recoveredRunFiles, []);
      assert.strictEqual(await fs.readFile(runFile, "utf8"), runContent);
      await fs.access(lockPath);
    });

    test("acquire never reclaims a newer lock", async function () {
      this.timeout(60_000);
      const lockPath = WorkflowPaths.runnerLockPath(tempRoot, workflowKey);
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(
        lockPath,
        JSON.stringify(newerLock({ pid: 999_999_999, lastHeartbeat: 0 })),
        "utf8"
      );

      const lock: WorkflowRunnerLock = {
        schemaVersion: CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.RUNNER_LOCK],
        workflowKey,
        runRef,
        runner: RUNNER_IDS.CLI,
        pid: process.pid,
        hostInstanceId: "host",
        executionInstanceId: "exec",
        ownerToken: "token",
        startedAt: Date.now(),
        lastHeartbeat: Date.now(),
      };
      await assert.rejects(
        WorkflowLockManager.acquireLock(tempRoot, workflowKey, lock),
        /held by a live owner/
      );
      const onDisk = JSON.parse(await fs.readFile(lockPath, "utf8"));
      assert.strictEqual(
        onDisk.schemaVersion,
        newerThan(PERSISTED_STORES.RUNNER_LOCK)
      );
    });
  });

  suite("lineage descriptor", () => {
    test("writes are stamped, and a newer descriptor is refused", async () => {
      const repository = new WorkflowLineageRepository();
      const lineage = await repository.createLineage(tempRoot, "wf", "Wf");
      const descriptorPath = WorkflowPaths.descriptorPath(
        tempRoot,
        lineage.workflowKey
      );
      const written = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
      assert.strictEqual(
        written.schemaVersion,
        CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.LINEAGE_DESCRIPTOR]
      );

      const newer = {
        ...written,
        schemaVersion: newerThan(PERSISTED_STORES.LINEAGE_DESCRIPTOR),
      };
      await fs.writeFile(descriptorPath, JSON.stringify(newer), "utf8");

      await assertRefusesNewer(PERSISTED_STORES.LINEAGE_DESCRIPTOR, () =>
        repository.updateDescriptor(tempRoot, lineage.workflowKey, (d) => ({
          ...d,
          isFavorite: true,
        }))
      );
      assert.deepStrictEqual(
        JSON.parse(await fs.readFile(descriptorPath, "utf8")),
        newer
      );
      // Reading for display still works.
      assert.strictEqual(
        (await repository.readDescriptor(tempRoot, lineage.workflowKey))
          .workflowName,
        "Wf"
      );
    });
  });

  suite("run working file", () => {
    test("the shared writer refuses a newer run and leaves it untouched", async () => {
      const runFile = path.join(tempRoot, "workflow.ctrlyoke.json");
      const newer = {
        steps: [],
        _runtime: {
          schemaVersion: newerThan(PERSISTED_STORES.RUN_FILE),
          currentIndex: 0,
          executionState: EXECUTION_STATES.PAUSED,
        },
      };
      await fs.writeFile(runFile, JSON.stringify(newer), "utf8");
      const read = await WorkingFileManager.readWorkingFileFromDisk(runFile);

      await assertRefusesNewer(PERSISTED_STORES.RUN_FILE, () =>
        WorkingFileManager.writeWorkingFileAtomic(runFile, {
          ...read,
          _runtime: {
            ...read._runtime!,
            executionState: EXECUTION_STATES.RUNNING,
          },
        })
      );
      assert.deepStrictEqual(
        JSON.parse(await fs.readFile(runFile, "utf8")),
        newer
      );
    });

    test("the shared writer stamps runs written before versioning", async () => {
      const runFile = path.join(tempRoot, "workflow.ctrlyoke.json");
      await WorkingFileManager.writeWorkingFileAtomic(runFile, {
        steps: [],
        _runtime: { currentIndex: 0, executionState: EXECUTION_STATES.IDLE },
      } as unknown as WorkingFile);
      const written = JSON.parse(await fs.readFile(runFile, "utf8"));
      assert.strictEqual(
        written._runtime.schemaVersion,
        CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.RUN_FILE]
      );
    });
  });

  suite("trust stores", () => {
    const cases = [
      {
        store: PERSISTED_STORES.EXTERNAL_ROOTS_TRUST,
        write: (storePath: string) =>
          new ExternalRootsTrustStore(storePath).setDecisions(
            "scope",
            [os.tmpdir()],
            TRUST_DECISIONS.ALLOW
          ),
      },
      {
        store: PERSISTED_STORES.SECRET_GRANTS_TRUST,
        write: (storePath: string) =>
          new SecretGrantsTrustStore(storePath).setDecisions(
            os.tmpdir(),
            ["TOKEN"],
            TRUST_DECISIONS.ALLOW
          ),
      },
    ];

    for (const { store, write } of cases) {
      test(`${store}: stamps writes and refuses a newer file`, async () => {
        const storePath = path.join(tempRoot, `${store}.json`);
        await write(storePath);
        const written = JSON.parse(await fs.readFile(storePath, "utf8"));
        assert.strictEqual(
          written.schemaVersion,
          CURRENT_SCHEMA_VERSIONS[store]
        );

        const newer = {
          ...written,
          schemaVersion: newerThan(store),
          addedByNewerVersion: true,
        };
        await fs.writeFile(storePath, JSON.stringify(newer), "utf8");
        await assertRefusesNewer(store, () => write(storePath));
        assert.deepStrictEqual(
          JSON.parse(await fs.readFile(storePath, "utf8")),
          newer
        );
      });
    }
  });

  suite("coordination board", () => {
    test("appends are stamped; a newer entry makes the board read-only", async function () {
      this.timeout(30_000);
      const store = new ExecutionRootCoordinationStore(tempRoot);
      const note = {
        kind: "note" as const,
        from: {
          participantId: "p",
          label: "p",
          kind: "external" as const,
          attested: false,
        },
        text: "hello",
        via: "cli" as const,
      };
      const appended = await store.append(note);
      assert.strictEqual(
        appended.schemaVersion,
        CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.COORDINATION_BOARD]
      );

      const { boardPath } = await store.getScopeInfo();
      const newerBoard =
        JSON.stringify({
          ...appended,
          schemaVersion: newerThan(PERSISTED_STORES.COORDINATION_BOARD),
        }) + "\n";
      await fs.writeFile(boardPath, newerBoard, "utf8");

      await assertRefusesNewer(PERSISTED_STORES.COORDINATION_BOARD, () =>
        store.append(note)
      );
      assert.strictEqual(await fs.readFile(boardPath, "utf8"), newerBoard);
      assert.strictEqual((await store.read()).entries.length, 1);
    });
  });
});
