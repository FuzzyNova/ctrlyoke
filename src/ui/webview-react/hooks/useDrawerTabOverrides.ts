import { useMemo } from "react";
import { PERMISSION_MODES } from "@root/types/DashboardConstants";
import type { DrawerPage } from "../types/drawerPages";
import type { WorkflowProperties, GlobalSettings } from "@store/settingsStore";
import type { PropertyValues } from "@store/editorStore";
import {
  type TabIconOverride,
  getPermissionTabOverride,
  getHooksTabOverride,
  getMcpTabOverride,
  getValidationTabOverride,
  getContextTabOverride,
} from "@components/shared/tabBadgeUtils";

/**
 * Computes tab icon overrides for DrawerTabBar based on resolved property state.
 *
 * - WorkflowPropertiesPanel: omit promptProperties → resolves workflow → global
 * - PropertiesDrawer: pass promptProperties → resolves prompt → workflow → global
 */
export function useDrawerTabOverrides(
  workflowProperties: WorkflowProperties,
  globalSettings: GlobalSettings,
  promptProperties?: PropertyValues
): Partial<Record<DrawerPage, TabIconOverride | undefined>> {
  return useMemo(() => {
    // ── Permissions ────────────────────────────────────────────────────────
    const wfPerms = workflowProperties.toolPermissions;
    const wfPermMode =
      wfPerms === null
        ? PERMISSION_MODES.NONE
        : (wfPerms?.mode ??
          globalSettings.toolPermissions.mode ??
          PERMISSION_MODES.ALLOW_ALL);
    const resolvedPermMode =
      promptProperties === undefined
        ? wfPermMode
        : promptProperties.toolPermissions === undefined
          ? wfPermMode
          : promptProperties.toolPermissions === null
            ? PERMISSION_MODES.NONE
            : (promptProperties.toolPermissions.mode ??
              PERMISSION_MODES.ALLOW_ALL);

    // ── Hooks ──────────────────────────────────────────────────────────────
    const wfHooks =
      workflowProperties.hooks !== undefined
        ? workflowProperties.hooks
        : globalSettings.hooks;
    const resolvedHooks =
      promptProperties !== undefined && promptProperties.hooks !== undefined
        ? promptProperties.hooks
        : wfHooks;

    // ── MCP servers ────────────────────────────────────────────────────────
    const wfMcp =
      workflowProperties.mcpServers !== undefined
        ? workflowProperties.mcpServers
        : globalSettings.mcpServers;
    const resolvedMcp =
      promptProperties !== undefined &&
      promptProperties.mcpServers !== undefined
        ? promptProperties.mcpServers
        : wfMcp;

    // ── Validation: pre- and end-conditions ─────────────────────────────────
    const wfEndCondition =
      workflowProperties.endCondition !== undefined
        ? workflowProperties.endCondition
        : globalSettings.defaultEndCondition;
    const resolvedEndCondition =
      promptProperties !== undefined &&
      promptProperties.endCondition !== undefined
        ? promptProperties.endCondition
        : wfEndCondition;
    const wfPreCondition =
      workflowProperties.preCondition !== undefined
        ? workflowProperties.preCondition
        : globalSettings.defaultPreCondition;
    const resolvedPreCondition =
      promptProperties !== undefined &&
      promptProperties.preCondition !== undefined
        ? promptProperties.preCondition
        : wfPreCondition;

    // ── Context: resume session + prior context ────────────────────────────
    const wfResumeSession =
      workflowProperties.resumeSession ?? globalSettings.resumeSession;
    const resolvedResumeSession =
      promptProperties !== undefined &&
      promptProperties.resumeSession !== undefined
        ? promptProperties.resumeSession
        : wfResumeSession;

    const wfPriorContext =
      workflowProperties.priorContext ?? globalSettings.priorContext;
    const resolvedPriorContext =
      promptProperties !== undefined &&
      promptProperties.priorContext !== undefined
        ? promptProperties.priorContext
        : wfPriorContext;

    return {
      permissions: getPermissionTabOverride(resolvedPermMode),
      hooks: getHooksTabOverride(resolvedHooks),
      mcp: getMcpTabOverride(resolvedMcp),
      validation: getValidationTabOverride(
        resolvedEndCondition?.script
          ? resolvedEndCondition
          : resolvedPreCondition
      ),
      context: getContextTabOverride(
        resolvedResumeSession,
        resolvedPriorContext
      ),
    };
  }, [workflowProperties, globalSettings, promptProperties]);
}
