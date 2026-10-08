/**
 * The lazily loaded half of ctrlyoke file support in the workspace editor. It
 * pulls in the `yaml` parser through the location facade, so nothing in the
 * dashboard's first paint imports it: `loadWorkflowFileSupport()` fetches it
 * the first time a ctrlyoke file opens.
 */
export {
  getWorkflowLocation,
  parseWorkflowDocumentRoot,
} from "@root/completions/WorkflowDocumentLocation";
export { getWorkflowFileCompletions } from "@root/completions/WorkflowFileCompletionCore";
