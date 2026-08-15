import {
  inspectUserProjects,
  pruneUserProjects,
  relinkUserProject,
  type UserProjectInspection,
} from "../utils/ProjectStateLifecycle";
import { repoToplevel } from "../utils/GitUtils";
import * as path from "node:path";
import type {
  HistoryPruneOptions,
  HistoryRelinkOptions,
} from "./HistoryCommandDefinitions";

export interface HistoryCommandIo {
  writeOut(message: string): void;
  writeErr(message: string): void;
  isInteractive: boolean;
  confirm(question: string): Promise<boolean>;
}

export async function pruneHistoryCommand(
  options: HistoryPruneOptions,
  io: HistoryCommandIo
): Promise<void> {
  const plan = await inspectUserProjects();
  const orphaned = plan.filter(
    (project) =>
      project.statePathStatus === "missing" && project.runnerStatus === "none"
  );

  renderPrunePlan(plan, io);
  if (orphaned.length === 0) {
    io.writeOut("No safely orphaned project history was found.");
    return;
  }

  const shouldApply = await confirmMutation(
    options.yes === true,
    io,
    `Delete ${orphaned.length} orphaned project director${orphaned.length === 1 ? "y" : "ies"}? [y/N] `
  );
  if (!shouldApply) {
    io.writeOut(
      "Dry run only; pass --yes to delete the listed project history."
    );
    return;
  }

  const result = await pruneUserProjects(false);
  for (const projectRoot of result.deleted) {
    io.writeOut(`Deleted ${projectRoot}`);
  }
  for (const project of result.inspections) {
    if (
      project.statePathStatus === "missing" &&
      project.runnerStatus !== "none"
    ) {
      io.writeErr(
        `Refused ${project.projectRoot}: runner state is ${project.runnerStatus}.`
      );
    }
  }
}

export async function relinkHistoryCommand(
  oldPath: string,
  newPath: string,
  options: HistoryRelinkOptions,
  io: HistoryCommandIo
): Promise<void> {
  const gitToplevel = await repoToplevel(path.resolve(newPath));
  const preview = await relinkUserProject(oldPath, newPath, {
    dryRun: true,
    gitToplevel: gitToplevel ?? null,
  });

  io.writeOut(
    `Would relink ${preview.oldProjectRoot} to ${preview.newProjectRoot}.`
  );
  if (preview.replacedEmptyScaffold) {
    io.writeOut("The matching empty destination scaffold would be replaced.");
  }

  const shouldApply = await confirmMutation(
    options.yes === true,
    io,
    `Relink project history to ${preview.newProjectRoot}? [y/N] `
  );
  if (!shouldApply) {
    io.writeOut("Dry run only; pass --yes to apply the relink.");
    return;
  }

  const result = await relinkUserProject(oldPath, newPath, {
    dryRun: false,
    gitToplevel: gitToplevel ?? null,
  });
  io.writeOut(`Relinked project history to ${result.newProjectRoot}.`);
}

function renderPrunePlan(
  inspections: UserProjectInspection[],
  io: HistoryCommandIo
): void {
  if (inspections.length === 0) {
    io.writeOut("No user-scoped project directories were found.");
    return;
  }

  for (const project of inspections) {
    const state = project.metadata?.statePath ?? "unknown statePath";
    if (project.statePathStatus === "missing") {
      if (project.runnerStatus === "none") {
        io.writeOut(`ORPHAN ${project.projectRoot} (statePath: ${state})`);
      } else {
        io.writeErr(
          `REFUSED ${project.projectRoot} (statePath: ${state}; runner: ${project.runnerStatus})`
        );
      }
      continue;
    }
    if (project.statePathStatus === "unknown") {
      io.writeErr(
        `UNKNOWN ${project.projectRoot} (statePath could not be verified${project.reason ? `: ${project.reason}` : ""})`
      );
      continue;
    }
    io.writeOut(`KEEP ${project.projectRoot} (statePath: ${state})`);
  }
}

async function confirmMutation(
  yes: boolean,
  io: HistoryCommandIo,
  question: string
): Promise<boolean> {
  if (yes) {
    return true;
  }
  if (!io.isInteractive) {
    return false;
  }
  return io.confirm(question);
}
