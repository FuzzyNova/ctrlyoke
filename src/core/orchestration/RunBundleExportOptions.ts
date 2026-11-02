import * as os from "node:os";
import { createNodeSecretStore } from "../../platform/NodeSecretStore";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import type { RunBundleExportOptions } from "./RunBundleExporter";

export interface RunBundleExportOptionInput {
  stateRoot: string;
  workspaceRoot: string;
  workflowKey: WorkflowKey;
  runRef: RunRef;
  bundleDir: string;
  exportedByVersion: string;
  includeSnapshots?: boolean;
  includeStreamDeltas?: boolean;
  includeChanges?: boolean;
  replace?: boolean;
  environment?: NodeJS.ProcessEnv;
  homeDir?: string;
  onWarning?: (warning: string) => void;
}

/** Shared CLI/dashboard security context and defaults for bundle export. */
export function buildRunBundleExportOptions(
  input: RunBundleExportOptionInput
): RunBundleExportOptions {
  return {
    stateRoot: input.stateRoot,
    workspaceRoot: input.workspaceRoot,
    workflowKey: input.workflowKey,
    runRef: input.runRef,
    bundleDir: input.bundleDir,
    exportedByVersion: input.exportedByVersion,
    includeSnapshots: input.includeSnapshots === true,
    includeStreamDeltas: input.includeStreamDeltas === true,
    includeChanges: input.includeChanges !== false,
    secrets: {
      workspaceRoot: input.workspaceRoot,
      secretStore: createNodeSecretStore({
        warn: input.onWarning ?? (() => undefined),
      }),
      environment: input.environment ?? process.env,
    },
    homeDir: input.homeDir ?? os.homedir(),
    replace: input.replace === true,
  };
}
