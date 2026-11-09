export interface CliRunHeaderLabelOptions {
  addressed: boolean;
  workflowName?: string;
  workflowKey?: string;
  runRef?: string;
  resolvedFile?: string;
  inlinePrompt: boolean;
  fileBasename: (filePath: string) => string;
}

export function formatCliRunHeaderLabel(
  options: CliRunHeaderLabelOptions
): string {
  if (options.addressed) {
    const workflowName =
      options.workflowName || options.workflowKey || "workflow";
    return options.runRef
      ? `${workflowName} (${options.runRef})`
      : workflowName;
  }

  if (options.resolvedFile) {
    return options.fileBasename(options.resolvedFile);
  }

  return options.inlinePrompt ? "<inline prompt>" : "workflow";
}
