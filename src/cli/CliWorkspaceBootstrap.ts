import * as path from "path";

import type { ConfigBackend } from "../config/CtrlYokeConfigService";
import { configService as defaultConfigService } from "../config/CtrlYokeConfigService";
import {
  createUserConfigBackend,
  createWorkspaceConfigBackend,
} from "../config/FileConfigBackend";
import { OutputHistoryManager } from "../core/orchestration/OutputHistoryManager";
import { WorkflowLineageRepository } from "../core/orchestration/WorkflowLineageRepository";
import type { PartialCtrlYokeSettings } from "../types/CtrlYokeSettings";
import { Log } from "../utils/Log";
import { repoToplevel } from "../utils/GitUtils";
import { ProjectStateRegistry } from "../utils/ProjectStateRegistry";
import {
  initializeRunHistoryLocation,
  isRunHistoryLocationInitialized,
} from "../utils/RunHistoryStoragePolicy";
import type { RunHistoryLocation } from "../types/CtrlYokeSettings";

export interface CliWorkspaceOptions {
  cwd?: string;
}

export interface CliWorkspaceConfigService {
  setUserBackend(backend: ConfigBackend): void;
  setWorkspaceBackend(backend: ConfigBackend): void;
  setCliOverlay(overlay: PartialCtrlYokeSettings): void;
  get(key: "storage"): { runHistoryLocation: RunHistoryLocation };
}

export interface CliWorkspaceBootstrapDependencies {
  configService?: CliWorkspaceConfigService;
  initializeCliLog?: (workspaceRoot: string, verbose: boolean) => void;
  createUserConfigBackend?: () => ConfigBackend;
  createWorkspaceConfigBackend?: (workspaceRoot: string) => ConfigBackend;
  isRunHistoryLocationInitialized?: typeof isRunHistoryLocationInitialized;
  initializeRunHistoryLocation?: typeof initializeRunHistoryLocation;
  repoToplevel?: typeof repoToplevel;
  createProjectStateRegistry?: () => Pick<ProjectStateRegistry, "initialize">;
}

export interface CliWorkspaceBootstrap {
  workspaceRoot: string;
  createOutputHistoryManager(): OutputHistoryManager;
  createLineageRepository(): WorkflowLineageRepository;
}

/** Initialize the workspace-scoped state shared by CLI history commands. */
export async function bootstrapCliWorkspace(
  options: CliWorkspaceOptions,
  cliOverlay: PartialCtrlYokeSettings = {},
  dependencies: CliWorkspaceBootstrapDependencies = {}
): Promise<CliWorkspaceBootstrap> {
  const workspaceRoot = path.resolve(options.cwd ?? process.cwd());
  const activeConfigService =
    dependencies.configService ?? defaultConfigService;
  const initializeCliLog =
    dependencies.initializeCliLog ??
    ((root, verbose) => Log.initializeCli(root, verbose));
  const createUserBackend =
    dependencies.createUserConfigBackend ?? createUserConfigBackend;
  const createWorkspaceBackend =
    dependencies.createWorkspaceConfigBackend ?? createWorkspaceConfigBackend;
  const isHistoryLocationInitialized =
    dependencies.isRunHistoryLocationInitialized ??
    isRunHistoryLocationInitialized;
  const initializeHistoryLocation =
    dependencies.initializeRunHistoryLocation ?? initializeRunHistoryLocation;
  const resolveGitToplevel = dependencies.repoToplevel ?? repoToplevel;
  const createRegistry =
    dependencies.createProjectStateRegistry ??
    (() => new ProjectStateRegistry());

  initializeCliLog(workspaceRoot, false);

  activeConfigService.setUserBackend(createUserBackend());
  activeConfigService.setWorkspaceBackend(
    createWorkspaceBackend(workspaceRoot)
  );
  activeConfigService.setCliOverlay(cliOverlay);

  if (!isHistoryLocationInitialized()) {
    initializeHistoryLocation(
      activeConfigService.get("storage").runHistoryLocation
    );
  }

  const gitToplevel = await resolveGitToplevel(workspaceRoot);
  await createRegistry().initialize(workspaceRoot, gitToplevel ?? undefined);

  return {
    workspaceRoot,
    createOutputHistoryManager: () => new OutputHistoryManager(workspaceRoot),
    createLineageRepository: () => new WorkflowLineageRepository(),
  };
}
