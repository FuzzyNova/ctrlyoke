import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Command } from "commander";
import { suite, test, setup, teardown } from "mocha";
import {
  emptyTrashCommand,
  listTrashCommand,
  purgeTrashCommand,
  restoreTrashCommand,
} from "../../cli/HistoryTrashCommands";
import {
  registerHistoryCommands,
  type HistoryTrashListOptions,
  type HistoryTrashPurgeOptions,
} from "../../cli/HistoryCommandDefinitions";
import type { HistoryCommandIo } from "../../cli/HistoryCommands";
import { HistoryTrashRepository } from "../../core/orchestration/HistoryTrashRepository";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import * as WorkflowPaths from "../../utils/WorkflowPaths";

class RecordingIo implements HistoryCommandIo {
  readonly out: string[] = [];
  readonly err: string[] = [];
  confirmed: string[] = [];
  constructor(
    readonly isInteractive = false,
    private readonly answer = false
  ) {}
  writeOut(message: string): void {
    this.out.push(message);
  }
  writeErr(message: string): void {
    this.err.push(message);
  }
  async confirm(question: string): Promise<boolean> {
    this.confirmed.push(question);
    return this.answer;
  }
}

suite("CLI history trash commands", () => {
  let workspace: string;
  let entryId: string;
  let workflowKey: string;
  const dependencies = () => ({
    bootstrapCliWorkspace: async () => ({ workspaceRoot: workspace }),
  });

  setup(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cy-trash-cli-"));
    const lineage = await new WorkflowLineageRepository().createLineage(
      workspace,
      "cli-trash",
      "CLI Trash"
    );
    workflowKey = lineage.workflowKey;
    const entry = await new HistoryTrashRepository(workspace).trashLineage(
      lineage.workflowKey,
      "cli"
    );
    assert.ok(entry);
    entryId = entry.id;
  });

  teardown(async () => {
    await fs.rm(path.dirname(WorkflowPaths.runsRoot(workspace)), {
      recursive: true,
      force: true,
    });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  test("list prints each entry with its id, and --json is machine readable", async () => {
    const io = new RecordingIo();
    await listTrashCommand({}, io, dependencies());
    assert.match(io.out[0], new RegExp(`^${entryId}  "CLI Trash"`));

    const json = new RecordingIo();
    await listTrashCommand({ json: true }, json, dependencies());
    const parsed = JSON.parse(json.out[0]);
    assert.strictEqual(parsed.entries[0].id, entryId);
  });

  test("restore puts the workflow back", async () => {
    const io = new RecordingIo();
    await restoreTrashCommand(entryId, {}, io, dependencies());
    assert.deepStrictEqual(io.out, ["Restored 1 workflow"]);
    assert.deepStrictEqual(
      await new WorkflowLineageRepository().listLineageKeys(workspace),
      [workflowKey]
    );
  });

  test("purge and empty refuse to run non-interactively without --yes", async () => {
    const io = new RecordingIo(false);
    await purgeTrashCommand(entryId, {}, io, dependencies());
    await emptyTrashCommand({}, io, dependencies());
    assert.strictEqual(io.err.length, 2);
    assert.strictEqual(
      (await new HistoryTrashRepository(workspace).list(30)).length,
      1
    );
  });

  test("an interactive decline keeps the entry", async () => {
    const io = new RecordingIo(true, false);
    await emptyTrashCommand({}, io, dependencies());
    assert.strictEqual(io.confirmed.length, 1);
    assert.strictEqual(
      (await new HistoryTrashRepository(workspace).list(30)).length,
      1
    );
  });

  test("empty --yes permanently deletes everything", async () => {
    const io = new RecordingIo();
    await emptyTrashCommand({ yes: true }, io, dependencies());
    assert.deepStrictEqual(io.out, ["Permanently deleted 1 item."]);
    assert.deepStrictEqual(
      await new HistoryTrashRepository(workspace).list(30),
      []
    );
  });
});

suite("CLI history trash command parser", () => {
  test("registers list, restore, purge, and empty under history trash", async () => {
    const calls: {
      list?: HistoryTrashListOptions;
      restore?: string;
      purge?: { entryId: string; options: HistoryTrashPurgeOptions };
      empty?: boolean;
    } = {};
    const noop = async () => {};
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    registerHistoryCommands(program, {
      prune: noop,
      relink: noop,
      list: noop,
      runs: noop,
      show: noop,
      search: noop,
      trash: {
        list: async (options) => {
          calls.list = options;
        },
        restore: async (entryId) => {
          calls.restore = entryId;
        },
        purge: async (entryId, options) => {
          calls.purge = { entryId, options };
        },
        empty: async (options) => {
          calls.empty = options.yes === true;
        },
      },
    });

    await program.parseAsync(["history", "trash", "list", "--json"], {
      from: "user",
    });
    await program.parseAsync(["history", "trash", "restore", "abc"], {
      from: "user",
    });
    await program.parseAsync(["history", "trash", "purge", "abc", "--yes"], {
      from: "user",
    });
    await program.parseAsync(["history", "trash", "empty", "-y"], {
      from: "user",
    });

    assert.strictEqual(calls.list?.json, true);
    assert.strictEqual(calls.restore, "abc");
    assert.deepStrictEqual(calls.purge, {
      entryId: "abc",
      options: { yes: true },
    });
    assert.strictEqual(calls.empty, true);
  });
});
