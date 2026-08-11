import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, teardown } from "mocha";
import { WORKTREE_MODES } from "../../types/DashboardConstants";
import type { WorktreeDefaultConfig } from "../../types/CtrlYokeTypes";
import {
  resolveWorktreeForWorkspace,
  resolveWorktreeSelection,
} from "../../utils/WorktreeResolution";

suite("WorktreeResolution", () => {
  const temporaryDirectories: string[] = [];

  teardown(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true })
      )
    );
  });

  async function ineligibleRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-worktree-resolution-"));
    temporaryDirectories.push(root);
    return root;
  }

  test("omission inherits the settings default", () => {
    const defaultValue: WorktreeDefaultConfig = {
      mode: WORKTREE_MODES.NAMED,
      branch: "feature/default",
      base: "main",
      setup: "npm ci",
      keep: true,
    };

    assert.deepStrictEqual(
      resolveWorktreeSelection(undefined, defaultValue),
      { origin: "default", config: defaultValue }
    );
  });

  test("authored false overrides a configured default", () => {
    assert.deepStrictEqual(
      resolveWorktreeSelection(false, {
        mode: WORKTREE_MODES.MANAGED,
        base: "main",
      }),
      { origin: "authored" }
    );
  });

  test("authored worktree hard-fails in an ineligible workspace", async () => {
    const root = await ineligibleRoot();
    await assert.rejects(
      resolveWorktreeForWorkspace(
        "feature/authored",
        { mode: WORKTREE_MODES.NONE },
        [{ name: "root", fsPath: root }]
      ),
      /requires a Git repository/
    );
  });

  test("inherited worktree degrades and records the eligibility notice", async () => {
    const root = await ineligibleRoot();
    const result = await resolveWorktreeForWorkspace(
      undefined,
      { mode: WORKTREE_MODES.MANAGED, base: "main" },
      [{ name: "root", fsPath: root }]
    );

    assert.strictEqual(result.origin, "default");
    assert.strictEqual(result.config, undefined);
    assert.match(result.notice ?? "", /Configured worktree default did not apply/);
    assert.match(result.notice ?? "", /requires a Git repository/);
  });

  test("sub-option defaults are retained for named defaults", () => {
    const result = resolveWorktreeSelection(undefined, {
      mode: WORKTREE_MODES.NAMED,
      branch: "feature/named",
      base: "origin/main",
      setup: "pnpm install",
      keep: false,
    });

    assert.deepStrictEqual(result.config, {
      mode: WORKTREE_MODES.NAMED,
      branch: "feature/named",
      base: "origin/main",
      setup: "pnpm install",
      keep: false,
    });
  });

  test("does not expose merge in the settings schema", async () => {
    const schemaPath = path.resolve(__dirname, "../../../schemas/settings-schema.json");
    const schema = JSON.parse(await fs.readFile(schemaPath, "utf8")) as {
      properties: {
        defaults: { properties: { worktree: { properties: Record<string, unknown> } } };
      };
    };

    assert.strictEqual(
      "merge" in schema.properties.defaults.properties.worktree.properties,
      false
    );
  });
});
