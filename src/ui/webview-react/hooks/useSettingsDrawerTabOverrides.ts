import { useMemo } from "react";
import type { SettingSource } from "@root/types/WebviewMessageTypes";
import type { DrawerPage } from "../types/drawerPages";
import {
  FOCUS_TAB_OVERRIDE,
  getPermissionTabOverride,
  type TabIconOverride,
} from "../components/shared/tabBadgeUtils";

function hasSourceOverride(
  sources: Record<string, SettingSource>,
  prefixes: string[]
): boolean {
  const sourceKeys = Object.keys(sources);
  return sourceKeys.some((key) =>
    prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))
  );
}

export function useSettingsDrawerTabOverrides(
  sources: Record<string, SettingSource>,
  permissionMode: string
): Partial<Record<DrawerPage, TabIconOverride | undefined>> {
  return useMemo(
    () => ({
      harness: hasSourceOverride(sources, [
        "defaults.harness",
        "defaults.models",
        "defaults.additionalArgs",
        "defaults.agent",
        "defaults.skills",
      ])
        ? FOCUS_TAB_OVERRIDE
        : undefined,
      context: hasSourceOverride(sources, [
        "defaults.resumeSession",
        "defaults.priorContext",
      ])
        ? FOCUS_TAB_OVERRIDE
        : undefined,
      validation: hasSourceOverride(sources, [
        "defaults.preCondition",
        "defaults.endCondition",
      ])
        ? FOCUS_TAB_OVERRIDE
        : undefined,
      mcp: hasSourceOverride(sources, ["defaults.mcpServers"])
        ? FOCUS_TAB_OVERRIDE
        : undefined,
      hooks: hasSourceOverride(sources, ["defaults.hooks"])
        ? FOCUS_TAB_OVERRIDE
        : undefined,
      permissions: hasSourceOverride(sources, ["defaults.toolPermissions"])
        ? (getPermissionTabOverride(permissionMode) ?? FOCUS_TAB_OVERRIDE)
        : undefined,
    }),
    [sources, permissionMode]
  );
}
