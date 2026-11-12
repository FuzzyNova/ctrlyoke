import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, teardown } from "mocha";
import { WORKTREE_MODES } from "../../types/DashboardConstants";
import type {
  WorktreeDefaultConfig,
  WorkingFileWorktreeRuntime,
} from "../../types/CtrlYokeTypes";
import {
  resolveWorktreeForWorkspace,
  resolveWorktreeSelection,
  recordedWorktreeConfigForContinue,
} from "../../utils/WorktreeResolution";

suite("WorktreeResolution", () => {
  test("continues a recorded checkout branch with current setup after defaults change", () => {
    const recorded = {
      mode: WORKTREE_MODES.NAMED,
      checkout: "bug-fix",
      branchName: "recorded-branch",
      executionCheckoutRoot: "/repo.worktrees/bug-fix",
      baseCommit: "captured-base",
    } as WorkingFileWorktreeRuntime;
    const result = recordedWorktreeConfigForContinue(recorded, {
      mode: WORKTREE_MODES.NAMED,
      branch: "new-default-branch",
      setup: "npm ci",
    });

    assert.deepStrictEqual(result, {
      mode: WORKTREE_MODES.NAMED,
      checkout: "/repo.worktrees/bug-fix",
      branch: "recorded-branch",
      base: "captured-base",
      setup: "npm ci",
    });
    assert.strictEqual(
      recordedWorktreeConfigForContinue(recorded, false),
      undefined,
      "a disabled current config still takes the worktree abandonment path"
    );
  });

  const temporaryDirectories: string[] = [];

  teardown(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true }))
    );
  });

  async function ineligibleRoot(): Promise<string> {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-worktree-resolution-")
    );
    temporaryDirectories.push(root);
    return root;
  }

  test("omission inherits the settings default", () => {
    const defaultValue: WorktreeDefaultConfig = {
      mode: WORKTREE_MODES.NAMED,
      branch: "feature/default",
      base: "main",
      setup: "npm ci",
    };

    assert.deepStrictEqual(resolveWorktreeSelection(undefined, defaultValue), {
      origin: "default",
      config: defaultValue,
    });
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

  test("normalizes authored managed shorthand and preserves managed options", () => {
    assert.deepStrictEqual(resolveWorktreeSelection(true, false), {
      origin: "authored",
      config: { mode: WORKTREE_MODES.MANAGED },
    });
    assert.deepStrictEqual(
      resolveWorktreeSelection(
        {
          mode: WORKTREE_MODES.MANAGED,
          keep: true,
          base: "main",
          setup: "npm ci",
        },
        false
      ),
      {
        origin: "authored",
        config: {
          mode: WORKTREE_MODES.MANAGED,
          keep: true,
          base: "main",
          setup: "npm ci",
        },
      }
    );
  });

  test("authored worktree hard-fails in an ineligible workspace", async () => {
    const root = await ineligibleRoot();
    await assert.rejects(
      resolveWorktreeForWorkspace("feature/authored", false, [
        { name: "root", fsPath: root },
      ]),
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
    assert.match(
      result.notice ?? "",
      /Configured worktree default did not apply/
    );
    assert.match(result.notice ?? "", /requires a Git repository/);
  });

  test("sub-option defaults are retained for named defaults", () => {
    const result = resolveWorktreeSelection(undefined, {
      mode: WORKTREE_MODES.NAMED,
      branch: "feature/named",
      base: "origin/main",
      setup: "pnpm install",
    });

    assert.deepStrictEqual(result.config, {
      mode: WORKTREE_MODES.NAMED,
      branch: "feature/named",
      base: "origin/main",
      setup: "pnpm install",
    });
  });

  test("normalizes a named checkout and rejects invalid checkout values", () => {
    assert.deepStrictEqual(
      resolveWorktreeSelection(
        { mode: WORKTREE_MODES.NAMED, branch: "feature", checkout: "  slot  " },
        false
      ).config,
      {
        mode: WORKTREE_MODES.NAMED,
        branch: "feature",
        checkout: "slot",
      }
    );
    for (const checkout of ["", "  ", "relative/path", "relative\\path"]) {
      assert.throws(
        () =>
          resolveWorktreeSelection(
            { mode: WORKTREE_MODES.NAMED, branch: "feature", checkout },
            false
          ),
        /checkout/
      );
    }
  });

  test("managed worktree config drops checkout", () => {
    assert.deepStrictEqual(
      resolveWorktreeSelection(
        { mode: WORKTREE_MODES.MANAGED, checkout: "slot" } as never,
        false
      ).config,
      { mode: WORKTREE_MODES.MANAGED }
    );
  });

  test("reuses the workflow worktree schema for settings defaults", async () => {
    const settingsSchemaPath = path.resolve(
      __dirname,
      "../../../schemas/settings-schema.json"
    );
    const workflowSchemaPath = path.resolve(
      __dirname,
      "../../../schemas/workflow-schema.json"
    );
    const settingsSchema = JSON.parse(
      await fs.readFile(settingsSchemaPath, "utf8")
    ) as {
      properties: {
        defaults: {
          properties: { worktree: { $ref: string } };
        };
      };
    };
    const workflowSchema = JSON.parse(
      await fs.readFile(workflowSchemaPath, "utf8")
    ) as {
      $defs: {
        worktreeConfig: {
          oneOf: Array<{ properties?: Record<string, unknown> }>;
        };
      };
    };

    assert.strictEqual(
      settingsSchema.properties.defaults.properties.worktree.$ref,
      // Settings live under /schema/v2/, so the ref names the v1 workflow schema.
      "../v1/workflow.json#/$defs/worktreeConfig"
    );
    const managed = workflowSchema.$defs.worktreeConfig.oneOf.find(
      (variant) => variant.properties && "merge" in variant.properties
    );
    const named = workflowSchema.$defs.worktreeConfig.oneOf.find(
      (variant) => variant.properties && "branch" in variant.properties
    );
    assert.ok(managed);
    assert.ok(named);
    assert.ok(named.properties && "checkout" in named.properties);
    assert.ok(managed.properties && !("checkout" in managed.properties));
  });
});
