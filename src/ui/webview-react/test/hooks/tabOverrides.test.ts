import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  HARNESS_IDS,
  PERMISSION_MODES,
  TOAST_LEVEL_MODES,
} from "@root/types/DashboardConstants";
import type { GlobalSettings } from "@store/settingsStore";
import { useDrawerTabOverrides } from "@hooks/useDrawerTabOverrides";
import { useSettingsDrawerTabOverrides } from "@hooks/useSettingsDrawerTabOverrides";
import { getPermissionTabOverride } from "@components/shared/tabBadgeUtils";

const globalSettings: GlobalSettings = {
  toastLevel: TOAST_LEVEL_MODES.ALL,
  harness: HARNESS_IDS.CLAUDE_CLI,
  model: "",
  harnessDefaultModels: {},
  harnessDefaultAdditionalArgs: {},
  agent: "",
  skills: [],
  executionMode: "headless",
  resumeSession: false,
  mcpServers: [],
  hooks: [],
  autoFocusOutputOnExecution: false,
  toolPermissions: {
    mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
    allowedTools: [],
    deniedTools: [],
  },
  respectGitignore: true,
  autoExpandEditorWhenTyping: false,
  atomicContextReferences: false,
  outputVirtualizationRowThreshold: 200,
  collapsedToolOutputLineCount: 10,
  confirmDeleteOperations: true,
  confirmResetOperations: true,
  confirmContinuationDiscardOperations: true,
  hideGitIgnoredFiles: false,
  isMultiRoot: false,
  priorContext: "none",
  workspaceRoot: "",
  defaultErrorBehavior: null,
  defaultEndCondition: null,
  defaultPreCondition: null,
  settingSources: {},
};

describe("drawer permission tab override callers", () => {
  it("preserves the shape swap in the workflow-properties drawer caller", () => {
    const { result } = renderHook(() =>
      useDrawerTabOverrides({}, globalSettings)
    );

    expect(result.current.permissions).toEqual(
      getPermissionTabOverride(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
    );
    expect(result.current).not.toHaveProperty("harness");
  });

  it("preserves the shape swap in the settings drawer caller", () => {
    const { result } = renderHook(() =>
      useSettingsDrawerTabOverrides(
        { "defaults.toolPermissions": "user" },
        PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL
      )
    );

    expect(result.current.permissions).toEqual(
      getPermissionTabOverride(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
    );
  });

  it("keeps the configured MCP icon while adding a compatibility badge", () => {
    const { result } = renderHook(() =>
      useDrawerTabOverrides(
        { mcpServers: ["ctrlyoke"] },
        globalSettings,
        undefined,
        false,
        false,
        true
      )
    );

    expect(result.current.mcp).toMatchObject({
      color: "text-focus-border",
      badgeCodicon: "warning",
    });
  });
});
