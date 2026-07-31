import {
  WORKFLOW_FILE_FORMATS,
  type WorkflowFileFormat,
} from "../../types/messages";
import type { ScopeToggleOption } from "../shared";

export const TEMPLATE_FORMAT_OPTIONS: readonly [
  ScopeToggleOption<WorkflowFileFormat>,
  ScopeToggleOption<WorkflowFileFormat>,
] = [
  {
    value: WORKFLOW_FILE_FORMATS.YAML,
    label: "YAML",
    icon: "codicon-file-code",
    title: "Save as a .ctrlyoke.yaml template",
  },
  {
    value: WORKFLOW_FILE_FORMATS.JSON,
    label: "JSON",
    icon: "codicon-json",
    title: "Save as a .ctrlyoke.json template",
  },
];
