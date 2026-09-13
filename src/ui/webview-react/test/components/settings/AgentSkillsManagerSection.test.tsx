import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { sendMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
}));

vi.mock("@hooks/useMessageHandler", () => ({
  sendMessage: sendMessageMock,
}));

import { AgentSkillsManagerSection } from "@components/settings/AgentSkillsManagerSection";
import { useHarnessFileStore } from "@store/useHarnessFileStore";
import { useSettingsStore } from "@store/settingsStore";
import {
  HARNESS_FILE_TYPES,
  HARNESS_IDS,
  HARNESS_STATUS_STRINGS,
  MESSAGE_TYPES,
  SETTING_SCOPES,
  SPECIAL_TARGET_IDS,
} from "@/types/messages";
import type {
  ManagedFile,
  ManagedTargetDirectory,
} from "@root/types/WebviewMessageTypes";

function createManagedFile(name: string): ManagedFile {
  return {
    name,
    displayName: name,
    type: HARNESS_FILE_TYPES.SKILL,
    locations: [
      {
        harnessId: SPECIAL_TARGET_IDS.CTRLYOKE,
        scope: SETTING_SCOPES.USER,
        path: `C:\\repo\\.ctrlyoke\\skills\\${name}`,
      },
      {
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        scope: SETTING_SCOPES.USER,
        path: `C:\\Users\\test\\.claude\\skills\\${name}`,
      },
    ],
  };
}

const TARGET_DIRECTORIES: ManagedTargetDirectory[] = [
  {
    harnessId: HARNESS_IDS.CLAUDE_CLI,
    scope: SETTING_SCOPES.USER,
    path: "C:\\Users\\test\\.claude\\skills",
  },
  {
    harnessId: SPECIAL_TARGET_IDS.CTRLYOKE,
    scope: SETTING_SCOPES.USER,
    path: "C:\\repo\\.ctrlyoke\\skills",
  },
];

function renderSkillsSection(files: ManagedFile[]) {
  useHarnessFileStore.setState({
    managedFiles: files,
    targetDirectories: TARGET_DIRECTORIES,
    activeType: HARNESS_FILE_TYPES.SKILL,
    loading: false,
    error: null,
    requestFiles: vi.fn(),
  });
  return render(
    <AgentSkillsManagerSection activeScope={SETTING_SCOPES.USER} />
  );
}

describe("AgentSkillsManagerSection", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    useSettingsStore.getState().resetSettings();
    useHarnessFileStore.setState({
      managedFiles: [],
      targetDirectories: [],
      activeType: HARNESS_FILE_TYPES.AGENT,
      loading: false,
      error: null,
      requestFiles: vi.fn(),
    });
    useSettingsStore.getState().setHarnessStatus(HARNESS_IDS.CLAUDE_CLI, {
      available: true,
      status: HARNESS_STATUS_STRINGS.AVAILABLE,
    });
  });

  it("dispatches save only for selected files", async () => {
    const user = userEvent.setup();
    renderSkillsSection([
      createManagedFile("skill-a"),
      createManagedFile("skill-b"),
    ]);
    const bulkBar = screen.getByText(/Select all \(2\/2\)/).closest("div")!;

    sendMessageMock.mockClear();

    await user.click(screen.getByRole("checkbox", { name: "Select skill-b" }));
    await user.click(
      within(bulkBar).getAllByRole("button", { name: "Save" })[0]
    );
    await user.click(
      within(bulkBar).getAllByRole("button", { name: "Save" })[1]
    );

    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.SYNC_ALL_TO_HARNESS,
      expect.objectContaining({
        targetHarnessId: HARNESS_IDS.CLAUDE_CLI,
        fileType: HARNESS_FILE_TYPES.SKILL,
        scope: SETTING_SCOPES.USER,
        files: [
          {
            name: "skill-a",
            sourcePath: "C:\\repo\\.ctrlyoke\\skills\\skill-a",
          },
        ],
      })
    );
  });

  it("dispatches delete only for selected files and never uses delete-all", async () => {
    const user = userEvent.setup();
    renderSkillsSection([
      createManagedFile("skill-a"),
      createManagedFile("skill-b"),
    ]);
    const bulkBar = screen.getByText(/Select all \(2\/2\)/).closest("div")!;

    sendMessageMock.mockClear();

    await user.click(screen.getByRole("checkbox", { name: "Select skill-b" }));
    await user.click(
      within(bulkBar).getAllByRole("button", { name: "Save" })[0]
    );
    await user.click(
      screen
        .getAllByRole("button", { name: "Delete" })
        .find((button) => button.className.includes("block w-full text-left"))!
    );
    await user.click(
      within(bulkBar).getAllByRole("button", { name: "Delete" })[1]
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" })
    );

    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.DELETE_FROM_HARNESS,
      {
        name: "skill-a",
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        fileType: HARNESS_FILE_TYPES.SKILL,
        scope: SETTING_SCOPES.USER,
      }
    );
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      MESSAGE_TYPES.DELETE_ALL_FROM_HARNESS,
      expect.anything()
    );
  });

  it("closes the delete dialog backdrop from Space", async () => {
    const user = userEvent.setup();
    renderSkillsSection([createManagedFile("skill-a")]);

    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    await user.click(deleteButtons[deleteButtons.length - 1]);
    await user.click(
      screen
        .getAllByRole("button", { name: /Claude Code/ })
        .find((button) => button.className.includes("cy-dropdown-row"))!
    );

    const backdrop = screen.getByRole("button", {
      name: "Close delete skill dialog",
    });
    fireEvent.keyDown(backdrop, { key: " " });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows bulk set default for skills and preserves non-visible defaults", async () => {
    const user = userEvent.setup();
    useSettingsStore
      .getState()
      .updateGlobalSetting("skills", ["legacy-skill", "skill-b"]);
    renderSkillsSection([
      createManagedFile("skill-a"),
      createManagedFile("skill-b"),
    ]);
    const bulkBar = screen.getByText(/Select all \(2\/2\)/).closest("div")!;

    sendMessageMock.mockClear();

    await user.click(screen.getByRole("checkbox", { name: "Select skill-b" }));
    await user.click(
      within(bulkBar).getAllByRole("button", { name: "Save" })[0]
    );
    await user.click(screen.getByRole("button", { name: "Set Default" }));
    await user.click(screen.getByRole("button", { name: "Set as Default" }));

    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      {
        path: "defaults.skills",
        value: ["legacy-skill", "skill-a"],
        scope: SETTING_SCOPES.USER,
      }
    );
  });

  it("does not offer bulk set default for agents", async () => {
    const user = userEvent.setup();
    useHarnessFileStore.setState({
      managedFiles: [
        {
          ...createManagedFile("agent-a"),
          type: HARNESS_FILE_TYPES.AGENT,
          locations: [
            {
              harnessId: SPECIAL_TARGET_IDS.CTRLYOKE,
              scope: SETTING_SCOPES.USER,
              path: "C:\\repo\\.ctrlyoke\\agents\\agent-a.agent.md",
            },
          ],
        },
      ],
      targetDirectories: TARGET_DIRECTORIES,
      activeType: HARNESS_FILE_TYPES.AGENT,
      loading: false,
      error: null,
      requestFiles: vi.fn(),
    });

    render(<AgentSkillsManagerSection activeScope={SETTING_SCOPES.USER} />);
    const bulkBar = screen.getByText(/Select all \(1\/1\)/).closest("div")!;

    await user.click(
      within(bulkBar).getAllByRole("button", { name: "Save" })[0]
    );
    expect(screen.queryByRole("button", { name: "Set Default" })).toBeNull();
  });

  it("offers built-in skills through the same save flow", async () => {
    const user = userEvent.setup();
    const builtInSourcePath =
      "extension/templates/skills/ctrlyoke-mcp-tools/SKILL.md";
    renderSkillsSection([
      {
        name: "ctrlyoke-mcp-tools",
        displayName: "ctrlyoke MCP Tools",
        type: HARNESS_FILE_TYPES.SKILL,
        locations: [],
        builtInSourcePath,
      },
    ]);

    const fileRow = screen.getByText("ctrlyoke MCP Tools").closest("div")!;
    await user.click(within(fileRow).getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Workspace" }));
    const claudeCodeTargets = screen.getAllByRole("button", {
      name: "Claude Code",
    });
    await user.click(claudeCodeTargets[claudeCodeTargets.length - 1]);

    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.EXPORT_TO_HARNESS,
      expect.objectContaining({
        sourcePath: builtInSourcePath,
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        fileType: HARNESS_FILE_TYPES.SKILL,
      })
    );
  });
});
