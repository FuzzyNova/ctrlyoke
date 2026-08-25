import * as fs from "fs/promises";
import { writeFileAtomic } from "./AtomicFileUtils";
import * as WorkflowPaths from "./WorkflowPaths";
import type { WorkflowKey } from "../types/CtrlYokeTypes";

export interface WorkflowStopRequest {
  ownerToken: string;
  requestId: string;
  requestedAt: number;
}

export async function writeWorkflowStopRequest(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  ownerToken: string,
  requestId: string
): Promise<string> {
  const requestPath = WorkflowPaths.stopRequestPath(
    workspaceRoot,
    workflowKey,
    ownerToken
  );
  await fs.mkdir(WorkflowPaths.lineageDir(workspaceRoot, workflowKey), {
    recursive: true,
  });
  await writeFileAtomic(
    requestPath,
    JSON.stringify({ ownerToken, requestId, requestedAt: Date.now() }, null, 2)
  );
  return requestPath;
}

export async function readWorkflowStopRequest(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  ownerToken: string
): Promise<WorkflowStopRequest | undefined> {
  const requestPath = WorkflowPaths.stopRequestPath(
    workspaceRoot,
    workflowKey,
    ownerToken
  );
  try {
    const request = JSON.parse(
      await fs.readFile(requestPath, "utf8")
    ) as Partial<WorkflowStopRequest>;
    if (
      request.ownerToken !== ownerToken ||
      typeof request.requestId !== "string" ||
      typeof request.requestedAt !== "number"
    ) {
      return undefined;
    }
    return request as WorkflowStopRequest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function deleteWorkflowStopRequest(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  ownerToken: string
): Promise<void> {
  const requestPath = WorkflowPaths.stopRequestPath(
    workspaceRoot,
    workflowKey,
    ownerToken
  );
  await fs.unlink(requestPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

/** Wait until the owning instance removes the request, or report a timeout. */
export async function waitForWorkflowStopRequestPickup(
  requestPath: string,
  timeoutMs: number,
  pollMs = 100
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.stat(requestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}
