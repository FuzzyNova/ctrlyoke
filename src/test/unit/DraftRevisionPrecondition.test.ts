import { suite, test } from "mocha";
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { WorkflowLineageDescriptor } from "../../types/CtrlYokeTypes";
import { EXECUTION_STATES } from "../../types/DashboardConstants";
import { WorkingFileManager } from "../../core/WorkingFileManager";
import { readDraftAtRevisions } from "../../core/orchestration/DraftRevisionPrecondition";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";

async function createDraftFixture(workspaceRoot: string) {
  const manager = new WorkingFileManager({
    getWorkingFilePath: () => undefined,
    getSteps: () => [{ prompt: "draft revision test" }],
    getCurrentIndex: () => 0,
    getStatus: () => EXECUTION_STATES.IDLE,
    getDefinitionRevision: () => 1,
    setDefinitionRevision: () => undefined,
    getWorkflowName: () => "Draft revision test",
    mergeDiskSteps: () => [],
    emitStateChange: () => undefined,
    getFinalStepRuntime: () => undefined,
    updateWorkflowProperty: () => undefined,
  });
  const created = await manager.createWorkingFile(
    "draft-revision-test",
    [{ prompt: "draft revision test" }],
    workspaceRoot,
    "Draft revision test"
  );
  const repository = new WorkflowLineageRepository();
  const descriptor = await repository.readDescriptor(
    workspaceRoot,
    created.workflowKey
  );
  return {
    repository,
    workflowKey: created.workflowKey,
    descriptor,
    draftFilePath: created.workingFilePath,
  };
}

suite("DraftRevisionPrecondition", () => {
  test("returns the checked descriptor and draft", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-draft-revision-read-")
    );
    try {
      const fixture = await createDraftFixture(workspaceRoot);

      const result = await readDraftAtRevisions(
        fixture.repository,
        workspaceRoot,
        fixture.workflowKey,
        1,
        fixture.descriptor.revision
      );

      assert.deepStrictEqual(result.descriptor, fixture.descriptor);
      assert.strictEqual(result.draft.definitionRevision, 1);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("asserts the descriptor revision before reading the draft", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-draft-revision-descriptor-")
    );
    try {
      const fixture = await createDraftFixture(workspaceRoot);
      await fs.rm(fixture.draftFilePath);
      const staleRepository = new (class extends WorkflowLineageRepository {
        override async readDescriptor(): Promise<WorkflowLineageDescriptor> {
          return {
            ...fixture.descriptor,
            revision: fixture.descriptor.revision + 1,
          };
        }
      })();

      await assert.rejects(
        readDraftAtRevisions(
          staleRepository,
          workspaceRoot,
          fixture.workflowKey,
          1,
          fixture.descriptor.revision
        ),
        new RegExp(
          `Descriptor revision conflict: expected ${fixture.descriptor.revision}, found ${fixture.descriptor.revision + 1}`
        )
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("asserts the draft definition revision", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-draft-revision-definition-")
    );
    try {
      const fixture = await createDraftFixture(workspaceRoot);

      await assert.rejects(
        readDraftAtRevisions(
          fixture.repository,
          workspaceRoot,
          fixture.workflowKey,
          2,
          fixture.descriptor.revision
        ),
        /Definition revision conflict: expected 2, found 1/
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
