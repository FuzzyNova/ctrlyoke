import * as fs from "fs/promises";
import type {
  WorkflowKey,
  WorkflowLineageDescriptor,
  WorkingFile,
} from "../../types/CtrlYokeTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import {
  assertDefinitionRevision,
  assertDescriptorRevision,
} from "./RevisionPrecondition";

export async function readDraftAtRevisions(
  lineageRepository: WorkflowLineageRepository,
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  expectedDefinitionRevision: number,
  expectedDescriptorRevision: number
): Promise<{ descriptor: WorkflowLineageDescriptor; draft: WorkingFile }> {
  const descriptor = await lineageRepository.readDescriptor(
    workspaceRoot,
    workflowKey
  );
  assertDescriptorRevision(expectedDescriptorRevision, descriptor.revision);

  const draft = JSON.parse(
    await fs.readFile(
      WorkflowPaths.draftFilePath(workspaceRoot, workflowKey),
      "utf8"
    )
  ) as WorkingFile;
  assertDefinitionRevision(
    expectedDefinitionRevision,
    draft.definitionRevision
  );

  return { descriptor, draft };
}
