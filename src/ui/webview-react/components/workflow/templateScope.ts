import type { ScopeToggleOption } from "../shared";
import {
  SETTING_SCOPES,
  SETTING_WRITE_SCOPE_LABELS,
} from "@root/types/DashboardConstants";

/** Where a custom template lives: this workspace only, or every workspace for this user. */
export type TemplateScope = "user" | "workspace";

/** Each scope's custom-template folder, as shown to the user. */
export const TEMPLATE_SCOPE_DIRS: Record<TemplateScope, string> = {
  workspace: ".ctrlyoke/templates",
  user: "~/.ctrlyoke/templates",
};

/** Shared copy for the workspace/user scope picker — used by TemplateModal and SaveWorkflowDialog. */
export const TEMPLATE_SCOPE_OPTIONS: readonly [
  ScopeToggleOption<TemplateScope>,
  ScopeToggleOption<TemplateScope>,
] = [
  {
    value: "workspace",
    label: SETTING_WRITE_SCOPE_LABELS[SETTING_SCOPES.WORKSPACE],
    icon: "codicon-project",
    title: `${TEMPLATE_SCOPE_DIRS.workspace} — this project only`,
  },
  {
    value: "user",
    label: SETTING_WRITE_SCOPE_LABELS[SETTING_SCOPES.USER],
    icon: "codicon-person",
    title: `${TEMPLATE_SCOPE_DIRS.user} — available in every workspace`,
  },
];
