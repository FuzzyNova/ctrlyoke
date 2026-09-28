import { describe, expect, it } from "vitest";
import {
  GLOBAL_SETTINGS_TABS,
  type GlobalSettingsTab,
} from "@root/types/DashboardConstants";
import { DRAWER_PAGES } from "@/types/drawerPages";
import { searchSettingsCatalog } from "@components/settings/settingsSearch";

describe("searchSettingsCatalog", () => {
  it("normalizes dotted paths and hyphenated harness ids", () => {
    expect(
      searchSettingsCatalog("queue.maxSteps", { devEnabled: false }).matches
    ).toContainEqual(expect.objectContaining({ id: "queue.maxSteps" }));
    expect(
      searchSettingsCatalog("claude-cli model", { devEnabled: false }).matches
    ).toContainEqual(
      expect.objectContaining({ id: "defaults.models.claude-cli" })
    );
  });

  it("requires every query token to match", () => {
    expect(
      searchSettingsCatalog("max steps", { devEnabled: false }).matches
    ).toContainEqual(expect.objectContaining({ id: "queue.maxSteps" }));
    expect(
      searchSettingsCatalog("max absent", { devEnabled: false }).matches
    ).toHaveLength(0);
  });

  it("excludes developer entries unless developer settings are enabled", () => {
    expect(
      searchSettingsCatalog("snapshot button", { devEnabled: false }).matches
    ).toHaveLength(0);
    expect(
      searchSettingsCatalog("snapshot button", { devEnabled: true }).matches
    ).toContainEqual(
      expect.objectContaining({ id: "developer.showUXSnapshotButton" })
    );
  });

  it("searches generated harness context and keywords", () => {
    expect(
      searchSettingsCatalog("claude code model", { devEnabled: false }).matches
    ).toContainEqual(
      expect.objectContaining({ id: "defaults.models.claude-cli" })
    );
    expect(
      searchSettingsCatalog("extra args", { devEnabled: false }).matches
    ).toContainEqual(
      expect.objectContaining({ id: "defaults.additionalArgs.claude-cli" })
    );
  });

  it("returns tab and Workflow Defaults page counts", () => {
    const result = searchSettingsCatalog("model", { devEnabled: false });
    expect(result.countsByTab.get(GLOBAL_SETTINGS_TABS.WORKFLOW)).toBe(6);
    expect(result.countsByPage.get(DRAWER_PAGES.HARNESS)).toBe(6);
    expect(
      [...result.countsByTab.values()].reduce((sum, count) => sum + count, 0)
    ).toBe(result.matches.length);
  });

  it("keeps matches in tab order and preserves catalog order within a tab", () => {
    const result = searchSettingsCatalog("terminal", { devEnabled: true });
    const tabRank = new Map<GlobalSettingsTab, number>([
      [GLOBAL_SETTINGS_TABS.GENERAL, 0],
      [GLOBAL_SETTINGS_TABS.WORKFLOW, 1],
      [GLOBAL_SETTINGS_TABS.EXECUTION, 2],
      [GLOBAL_SETTINGS_TABS.QUEUE, 3],
      [GLOBAL_SETTINGS_TABS.WORKTREES, 4],
      [GLOBAL_SETTINGS_TABS.COORDINATION, 5],
      [GLOBAL_SETTINGS_TABS.TERMINAL, 6],
    ]);
    const ranks = result.matches.map((entry) => tabRank.get(entry.tab)!);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(
      result.matches.findIndex((entry) => entry.id === "terminal.fontSize")
    ).toBeLessThan(
      result.matches.findIndex((entry) => entry.id === "terminal.cursorStyle")
    );
  });

  it("treats an empty or whitespace-only query as inactive", () => {
    for (const query of ["", "  \t  "]) {
      const result = searchSettingsCatalog(query, { devEnabled: true });
      expect(result.tokens).toEqual([]);
      expect(result.matches).toEqual([]);
      expect(result.matchIds.size).toBe(0);
      expect(result.countsByTab.size).toBe(0);
      expect(result.countsByPage.size).toBe(0);
    }
  });
});
