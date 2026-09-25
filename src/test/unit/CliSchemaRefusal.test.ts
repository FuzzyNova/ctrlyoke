import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  applyRunStateRefusal,
  NEWER_SCHEMA_EXIT_CODE,
  trackRunStateRefusals,
  type RunStateRefusalTracker,
} from "../../cli/CliSchemaRefusal";
import { ObservedHarnessUsageStore } from "../../core/harness/shared/usage/ObservedHarnessUsageStore";
import {
  CURRENT_SCHEMA_VERSIONS,
  PERSISTED_STORES,
  prepareRunFileForWrite,
} from "../../utils/PersistedSchemaGuard";

suite("CliSchemaRefusal", () => {
  let tempRoot: string;
  let previousHome: string | undefined;
  let tracker: RunStateRefusalTracker;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-refusal-"));
    previousHome = process.env.CTRLYOKE_HOME;
    process.env.CTRLYOKE_HOME = tempRoot;
    tracker = trackRunStateRefusals();
  });

  teardown(async () => {
    tracker.dispose();
    if (previousHome === undefined) {
      delete process.env.CTRLYOKE_HOME;
    } else {
      process.env.CTRLYOKE_HOME = previousHome;
    }
    await fs.rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  test("a refused run-file write turns a failed run into exit 2", () => {
    // The executor swallows this and reports a failed step; the tracker still
    // sees it.
    assert.throws(() =>
      prepareRunFileForWrite(
        {
          _runtime: {
            schemaVersion:
              CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.RUN_FILE] + 1,
          },
        },
        "run.json"
      )
    );

    const refusal = tracker.first();
    assert.strictEqual(refusal?.store, PERSISTED_STORES.RUN_FILE);
    assert.strictEqual(
      applyRunStateRefusal(1, refusal),
      NEWER_SCHEMA_EXIT_CODE
    );
    assert.strictEqual(
      applyRunStateRefusal(4, refusal),
      NEWER_SCHEMA_EXIT_CODE
    );
    assert.strictEqual(applyRunStateRefusal(0, refusal), 0);
    assert.strictEqual(applyRunStateRefusal(1, undefined), 1);
  });

  test("refusals from advisory stores do not change the exit code", async () => {
    const store = new ObservedHarnessUsageStore(tempRoot);
    await fs.mkdir(path.dirname(store.getPath()), { recursive: true });
    await fs.writeFile(
      store.getPath(),
      JSON.stringify({
        schemaVersion:
          CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.OBSERVED_USAGE] + 1,
      }),
      "utf8"
    );

    await assert.rejects(store.read());
    assert.strictEqual(tracker.first(), undefined);
  });

  test("disposing stops tracking", () => {
    tracker.dispose();
    assert.throws(() =>
      prepareRunFileForWrite(
        {
          _runtime: {
            schemaVersion:
              CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.RUN_FILE] + 1,
          },
        },
        "run.json"
      )
    );
    assert.strictEqual(tracker.first(), undefined);
  });
});
