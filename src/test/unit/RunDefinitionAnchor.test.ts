import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, setup, teardown, test } from "mocha";
import type { WorkingFile, WorkflowStep } from "../../types/CtrlYokeTypes";
import {
  RUN_DEFINITION_CHANGE_SCOPES,
  RUN_DEFINITION_INTEGRITY,
} from "../../types/DashboardConstants";
import {
  assertTrustedRewindBase,
  describeRunDefinitionChanges,
  isRunDefinitionChangedError,
  readRunDefinitionAnchor,
  restoreTrustedRunDefinition,
  runDefinitionHashOf,
  verifyRunDefinitionFile,
  writeAnchoredRunDefinition,
} from "../../utils/RunDefinitionAnchor";
import { definitionAnchorPath } from "../../utils/WorkflowPaths";
import { projectKey, userProjectsRoot } from "../../utils/ProjectStatePaths";

const WORKFLOW_KEY = "anchor-test-2026-01-01T00-00-00";
const RUN_REF = "run-2026-01-01T00-00-00-000Z";

suite("RunDefinitionAnchor", () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let workingFilePath: string;
  const originalStateHome = process.env.CTRLYOKE_HOME;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-anchor-"));
    process.env.CTRLYOKE_HOME = path.join(tempRoot, "state-home");
    workspaceRoot = path.join(tempRoot, "workspace");
    // Workspace storage mode: the run file sits inside the workspace, where a
    // sandboxed harness may write.
    workingFilePath = path.join(
      workspaceRoot,
      ".ctrlyoke",
      ".runs",
      WORKFLOW_KEY,
      RUN_REF,
      "workflow.ctrlyoke.json"
    );
    await fs.mkdir(path.dirname(workingFilePath), { recursive: true });
  });

  teardown(async () => {
    if (originalStateHome === undefined) {
      delete process.env.CTRLYOKE_HOME;
    } else {
      process.env.CTRLYOKE_HOME = originalStateHome;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  function runFile(steps: WorkflowStep[], extra: object = {}): WorkingFile {
    return {
      startedAt: 1,
      definitionRevision: 1,
      steps,
      _runtime: { currentIndex: 0, executionState: "idle" },
      ...extra,
    } as WorkingFile;
  }

  /** Writes through the anchored path, as every ctrlyoke writer does. */
  async function writeAsCtrlyoke(
    workingFile: WorkingFile,
    options: Parameters<typeof writeAnchoredRunDefinition>[3] = {}
  ): Promise<void> {
    await writeAnchoredRunDefinition(
      workingFilePath,
      workingFile,
      () => fs.writeFile(workingFilePath, JSON.stringify(workingFile)),
      options
    );
  }

  /** Writes as something outside ctrlyoke would: the file only. */
  async function writeOutside(workingFile: WorkingFile): Promise<void> {
    await fs.writeFile(workingFilePath, JSON.stringify(workingFile));
  }

  async function statusOnDisk(): Promise<string | undefined> {
    return (await verifyRunDefinitionFile(workingFilePath))?.verdict.status;
  }

  test("keeps a workspace-mode anchor under the user state home", () => {
    const anchorPath = definitionAnchorPath(workingFilePath);
    assert.ok(anchorPath);
    const expectedProjectDir = path.join(
      userProjectsRoot(),
      projectKey(workspaceRoot)
    );
    assert.ok(
      anchorPath.startsWith(expectedProjectDir + path.sep),
      `${anchorPath} should be under ${expectedProjectDir}`
    );
    assert.ok(!anchorPath.startsWith(workspaceRoot + path.sep));
    assert.strictEqual(
      definitionAnchorPath(path.join(tempRoot, "elsewhere.json")),
      undefined
    );
  });

  test("history with no anchor is unanchored until ctrlyoke writes it", async () => {
    await writeOutside(runFile([{ prompt: "legacy" }]));
    assert.strictEqual(
      await statusOnDisk(),
      RUN_DEFINITION_INTEGRITY.UNANCHORED
    );

    await writeAsCtrlyoke(runFile([{ prompt: "legacy" }]));
    assert.strictEqual(await statusOnDisk(), RUN_DEFINITION_INTEGRITY.TRUSTED);
  });

  test("runtime and step identity changes keep the definition trusted", async () => {
    await writeAsCtrlyoke(
      runFile([{ prompt: "a", _runtime: { stepId: "id-a" } }])
    );
    await writeOutside(
      runFile([{ prompt: "a", _runtime: { startedAt: 5, completedAt: 9 } }], {
        _runtime: { currentIndex: 1, executionState: "completed" },
      })
    );
    assert.strictEqual(await statusOnDisk(), RUN_DEFINITION_INTEGRITY.TRUSTED);
  });

  test("an outside definition change is reported with the step and field it touched", async () => {
    await writeAsCtrlyoke(runFile([{ prompt: "a" }, { prompt: "b" }]));
    await writeOutside(
      runFile([
        { prompt: "a" },
        { prompt: "b", endCondition: { script: "node pwned.js" } },
        { type: "script", script: "node more.js" } as WorkflowStep,
      ])
    );

    const verified = await verifyRunDefinitionFile(workingFilePath);
    assert.strictEqual(
      verified?.verdict.status,
      RUN_DEFINITION_INTEGRITY.CHANGED_OUTSIDE
    );
    if (verified?.verdict.status !== RUN_DEFINITION_INTEGRITY.CHANGED_OUTSIDE) {
      return;
    }
    assert.deepStrictEqual(verified.verdict.changes, [
      {
        scope: RUN_DEFINITION_CHANGE_SCOPES.STEP,
        stepNumber: 2,
        fields: ["endCondition"],
      },
      {
        scope: RUN_DEFINITION_CHANGE_SCOPES.STEP,
        stepNumber: 3,
        fields: ["added"],
      },
    ]);
    assert.strictEqual(
      describeRunDefinitionChanges(verified.verdict.changes),
      "step 2: endCondition; step 3: added"
    );
  });

  test("a workflow-level permission change is caught", async () => {
    await writeAsCtrlyoke(runFile([{ prompt: "a" }]));
    await writeOutside(
      runFile([{ prompt: "a" }], {
        toolPermissions: { mode: "dangerouslyAllowAll" },
      })
    );
    const verified = await verifyRunDefinitionFile(workingFilePath);
    assert.strictEqual(
      verified?.verdict.status,
      RUN_DEFINITION_INTEGRITY.CHANGED_OUTSIDE
    );
  });

  test("refuses to write over an outside change unless told the content does not derive from it", async () => {
    await writeAsCtrlyoke(runFile([{ prompt: "a" }]));
    await writeOutside(runFile([{ prompt: "a", additionalArgs: "--yolo" }]));

    await assert.rejects(
      writeAsCtrlyoke(
        runFile([{ prompt: "edited", additionalArgs: "--yolo" }])
      ),
      (error: unknown) =>
        isRunDefinitionChangedError(error) &&
        /step 1: additionalArgs/.test(error.message)
    );

    await writeAsCtrlyoke(runFile([{ prompt: "restored" }]), {
      overwriteChangedDefinition: true,
    });
    assert.strictEqual(await statusOnDisk(), RUN_DEFINITION_INTEGRITY.TRUSTED);
  });

  test("a failed write puts the previous anchor back", async () => {
    const original = runFile([{ prompt: "original" }]);
    await writeAsCtrlyoke(original);
    const before = await readRunDefinitionAnchor(workingFilePath);

    await assert.rejects(
      writeAnchoredRunDefinition(
        workingFilePath,
        runFile([{ prompt: "never written" }]),
        async () => {
          throw new Error("disk full");
        }
      ),
      /disk full/
    );

    assert.deepStrictEqual(
      await readRunDefinitionAnchor(workingFilePath),
      before
    );
    assert.strictEqual(await statusOnDisk(), RUN_DEFINITION_INTEGRITY.TRUSTED);
  });

  test("the replaced definition is not accepted once the write settles", async () => {
    const first = runFile([{ prompt: "first" }]);
    await writeAsCtrlyoke(first);
    await writeAsCtrlyoke(runFile([{ prompt: "second" }]));
    assert.strictEqual(
      (await readRunDefinitionAnchor(workingFilePath))?.previousDefinitionHash,
      undefined
    );

    // An outside writer putting back the older definition is still a change.
    await writeOutside(first);
    assert.strictEqual(
      await statusOnDisk(),
      RUN_DEFINITION_INTEGRITY.CHANGED_OUTSIDE
    );
  });

  test("restoring keeps each step's runtime and drops outside additions", async () => {
    await writeAsCtrlyoke(
      runFile(
        [
          { prompt: "done", _runtime: { stepId: "s1" } },
          { prompt: "next", _runtime: { stepId: "s2" } },
        ],
        { harness: "claude-cli" }
      )
    );
    const tampered = runFile(
      [
        {
          prompt: "done",
          _runtime: { stepId: "s1", startedAt: 1, completedAt: 2 },
        },
        {
          prompt: "next",
          endCondition: { script: "node pwned.js" },
          _runtime: { stepId: "s2" },
        },
      ],
      {
        hooks: { stop: [{ command: "node hook.js" }] },
        _runtime: { currentIndex: 1, executionState: "running" },
      }
    );
    await writeOutside(tampered);
    const anchor = await readRunDefinitionAnchor(workingFilePath);
    assert.ok(anchor);

    const restored = restoreTrustedRunDefinition(tampered, anchor);

    assert.strictEqual(
      (restored as { hooks?: unknown }).hooks,
      undefined,
      "an outside workflow-level addition is dropped"
    );
    assert.strictEqual(restored.harness, "claude-cli");
    assert.strictEqual(
      (restored.steps?.[1] as { endCondition?: unknown }).endCondition,
      undefined
    );
    assert.deepStrictEqual(restored.steps?.[0]._runtime, {
      stepId: "s1",
      startedAt: 1,
      completedAt: 2,
    });
    assert.deepStrictEqual(restored._runtime, tampered._runtime);
    assert.strictEqual(
      runDefinitionHashOf(restored),
      anchor.definitionHash,
      "the restored file verifies as trusted"
    );
  });

  test("a pending rewind may only restore the snapshot anchored when it began", async () => {
    const base = runFile([{ prompt: "base" }]);
    await writeAsCtrlyoke(runFile([{ prompt: "rewound" }]), {
      rewindBaseHash: runDefinitionHashOf(base),
    });

    await assertTrustedRewindBase(workingFilePath, base);
    await assert.rejects(
      assertTrustedRewindBase(
        workingFilePath,
        runFile([{ type: "script", script: "node pwned.js" } as WorkflowStep])
      ),
      isRunDefinitionChangedError
    );

    await writeAsCtrlyoke(runFile([{ prompt: "rewound" }]), {
      rewindBaseHash: null,
    });
    assert.strictEqual(
      (await readRunDefinitionAnchor(workingFilePath))?.rewindBaseHash,
      undefined
    );
  });
});
