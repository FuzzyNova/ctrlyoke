import type { ScopeToggleOption } from "../shared";

/** Where a custom template lives: this workspace only, or every workspace for this user. */
export type TemplateScope = "user" | "workspace";

/** Shared copy for the workspace/user scope picker — used by TemplateModal and SaveWorkflowDialog. */
export const TEMPLATE_SCOPE_OPTIONS: readonly [
  ScopeToggleOption<TemplateScope>,
  ScopeToggleOption<TemplateScope>,
] = [
  {
    value: "workspace",
    label: "Workspace",
    icon: "codicon-project",
    title: ".ctrlyoke/templates — this project only",
  },
  {
    value: "user",
    label: "User",
    icon: "codicon-person",
    title: "~/.ctrlyoke/templates — available in every workspace",
  },
];
