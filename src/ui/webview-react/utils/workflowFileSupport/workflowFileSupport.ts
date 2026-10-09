/**
 * The lazily loaded half of ctrlyoke file support in the workspace editor. It
 * pulls in the `yaml` parser through the location facade, so nothing in the
 * dashboard's first paint imports it: `loadWorkflowFileSupport()` fetches it
 * the first time a ctrlyoke file opens.
 */
export {
  getWorkflowLocation,
  findRangeForPath,
  workflowPathFromInstancePath,
  parseWorkflowDocumentRoot,
} from "@root/completions/WorkflowDocumentLocation";
export { getWorkflowFileCompletions } from "@root/completions/WorkflowFileCompletionCore";
export { getWorkflowPromptDiagnostics } from "@root/completions/WorkflowPromptDiagnostics";
export { WORKFLOW_SCHEMA_OUTLINE } from "@root/types/generated/WorkflowSchemaOutline";
