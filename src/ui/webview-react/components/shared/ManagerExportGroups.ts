import type { ActionDropdownItem } from "./ActionDropdown";
import type { FlyoutGroup } from "./FlyoutActionDropdown";
import { encodeManagerTarget } from "./ManagerUi";
import {
  SETTING_SCOPES,
  type SettingWriteScope,
} from "@root/types/DashboardConstants";

export function buildManagerExportGroups(options: {
  hasWorkspaceRoot: boolean;
  workspaceTargetIds: readonly string[];
  userTargetIds: readonly string[];
  labelForTarget: (id: string) => string;
  descriptionForTarget: (id: string, scope: SettingWriteScope) => string;
  presentKeys?: Set<string>;
}): FlyoutGroup[] {
  const makeItems = (
    ids: readonly string[],
    scope: SettingWriteScope
  ): ActionDropdownItem[] =>
    ids.map((id) => {
      const value = encodeManagerTarget(id, scope);
      const alreadyPresent = options.presentKeys?.has(value) ?? false;
      return {
        label: options.labelForTarget(id),
        value,
        description: options.descriptionForTarget(id, scope),
        disabled: alreadyPresent,
        title: alreadyPresent ? "Already exported" : undefined,
      };
    });
  const workspaceItems = options.hasWorkspaceRoot
    ? makeItems(options.workspaceTargetIds, SETTING_SCOPES.WORKSPACE)
    : [];
  return [
    ...(workspaceItems.length
      ? [{ id: "workspace", label: "Workspace", items: workspaceItems }]
      : []),
    {
      id: "user",
      label: "User",
      items: makeItems(options.userTargetIds, SETTING_SCOPES.USER),
    },
  ];
}
