import type { ScopeToggleOption } from "../shared";
import {
  SETTING_SCOPES,
  SETTING_WRITE_SCOPE_LABELS,
} from "@root/types/DashboardConstants";

/** Where a custom template lives: this workspace only, or every workspace for this user. */
export type TemplateScope = "user" | "workspace";

/** Shared copy for the workspace/user scope picker — used by TemplateModal and SaveWorkflowDialog. */
export const TEMPLATE_SCOPE_OPTIONS: readonly [
  ScopeToggleOption<TemplateScope>,
  ScopeToggleOption<TemplateScope>,
] = [
  {
    value: "workspace",
    label: SETTING_WRITE_SCOPE_LABELS[SETTING_SCOPES.WORKSPACE],
    icon: "codicon-project",
    title: ".ctrlyoke/templates — this project only",
  },
  {
    value: "user",
    label: SETTING_WRITE_SCOPE_LABELS[SETTING_SCOPES.USER],
    icon: "codicon-person",
    title: "~/.ctrlyoke/templates — available in every workspace",
  },
];
