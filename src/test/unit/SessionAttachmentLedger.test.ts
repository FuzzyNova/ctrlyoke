import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import {
  CURRENT_SCHEMA_VERSIONS,
  PERSISTED_STORES,
} from "../../utils/PersistedSchemaGuard";
import { SessionAttachmentLedger } from "../../utils/SessionAttachmentLedger";

suite("SessionAttachmentLedger", () => {
  let dir: string;
  let filePath: string;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-session-ledger-"));
    filePath = path.join(dir, "project", "session-attachments.json");
  });

  teardown(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("returns undefined for a session it has never seen", async () => {
    const ledger = new SessionAttachmentLedger(filePath);

    assert.strictEqual(
      await ledger.get(HARNESS_IDS.CLAUDE_CLI, "session-1"),
      undefined
    );
  });

  test("accumulates attachments across turns, keyed by harness and session", async () => {
    const ledger = new SessionAttachmentLedger(filePath);

    await ledger.record(HARNESS_IDS.CLAUDE_CLI, "session-1", {
      agent: "reviewer",
      skills: ["git"],
    });
    await ledger.record(HARNESS_IDS.CLAUDE_CLI, "session-1", {
      agent: "reviewer",
      skills: [],
    });
    await ledger.record(HARNESS_IDS.CLAUDE_CLI, "session-1", {
      skills: ["testing", "git"],
    });
    await ledger.record(HARNESS_IDS.CODEX_CLI, "session-1", {
      skills: ["lint"],
    });

    assert.deepStrictEqual(
      await ledger.get(HARNESS_IDS.CLAUDE_CLI, "session-1"),
      { agents: ["reviewer"], skills: ["git", "testing"] }
    );
    assert.deepStrictEqual(
      await new SessionAttachmentLedger(filePath).get(
        HARNESS_IDS.CODEX_CLI,
        "session-1"
      ),
      { agents: [], skills: ["lint"] }
    );
  });

  test("keeps every write when records run concurrently", async () => {
    const ledger = new SessionAttachmentLedger(filePath);

    await Promise.all(
      ["a", "b", "c", "d"].map((skill) =>
        ledger.record(HARNESS_IDS.CLAUDE_CLI, "session-1", { skills: [skill] })
      )
    );

    const entry = await ledger.get(HARNESS_IDS.CLAUDE_CLI, "session-1");
    assert.deepStrictEqual([...(entry?.skills ?? [])].sort(), [
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("drops the least recently updated sessions beyond the cap", async () => {
    let now = 0;
    const ledger = new SessionAttachmentLedger(filePath, {
      maxSessions: 2,
      now: () => ++now,
    });

    for (const sessionId of ["old", "middle", "new"]) {
      await ledger.record(HARNESS_IDS.CLAUDE_CLI, sessionId, {
        skills: ["git"],
      });
    }

    assert.strictEqual(
      await ledger.get(HARNESS_IDS.CLAUDE_CLI, "old"),
      undefined
    );
    assert.ok(await ledger.get(HARNESS_IDS.CLAUDE_CLI, "middle"));
    assert.ok(await ledger.get(HARNESS_IDS.CLAUDE_CLI, "new"));
  });

  test("rebuilds a malformed file instead of failing", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ not json");
    const ledger = new SessionAttachmentLedger(filePath);

    await ledger.record(HARNESS_IDS.CLAUDE_CLI, "session-1", {
      skills: ["git"],
    });

    assert.deepStrictEqual(
      await ledger.get(HARNESS_IDS.CLAUDE_CLI, "session-1"),
      { agents: [], skills: ["git"] }
    );
  });

  test("leaves a file written by a newer ctrlyoke untouched", async () => {
    const newer = JSON.stringify({
      schemaVersion:
        CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.SESSION_ATTACHMENTS] + 1,
      sessions: {},
    });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, newer);
    const ledger = new SessionAttachmentLedger(filePath);

    await ledger.record(HARNESS_IDS.CLAUDE_CLI, "session-1", {
      skills: ["git"],
    });

    assert.strictEqual(await fs.readFile(filePath, "utf8"), newer);
    assert.strictEqual(
      await ledger.get(HARNESS_IDS.CLAUDE_CLI, "session-1"),
      undefined
    );
  });
});
