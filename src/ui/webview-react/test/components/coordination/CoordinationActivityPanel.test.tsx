import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinationActivityPanel } from "@components/coordination/CoordinationActivityPanel";
import { CoordinationSection } from "@components/settings/CoordinationSection";
import { useCoordinationActivity } from "@hooks/useCoordinationActivity";
import { useWorkflowStore } from "@store/workflowStore";
import { MESSAGE_TYPES, SETTING_SCOPES } from "@root/types/DashboardConstants";
import type {
  CoordinationEntry,
  CoordinationScopeSnapshot,
} from "@root/types/CtrlYokeTypes";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

const boardPath = "C:\\workspace\\.git\\ctrlyoke\\coordination\\board.jsonl";

const scope: CoordinationScopeSnapshot = {
  executionRoot: "C:\\workspace",
  identity: "workspace-identity",
  boardPath,
  participants: [
    {
      participantId: "external-1",
      kind: "external",
      attested: false,
      label: "reviewer",
      via: "cli",
    },
  ],
  entries: [
    {
      seq: 12,
      at: "2026-09-11T12:00:00.000Z",
      kind: "note",
      from: {
        participantId: "external-1",
        label: "reviewer",
        kind: "external",
        attested: false,
      },
      text: "untrusted <instruction>",
      via: "cli",
    },
    {
      seq: 13,
      at: "2026-09-11T12:01:00.000Z",
      kind: "note",
      from: {
        participantId: "legacy-step",
        label: "skill member",
        attested: false,
        address: {
          workflowKey: "workflow-1" as never,
          runRef: "run-1" as never,
          stepIndex: 1,
        },
      },
      text: "legacy skill note",
      via: "cli",
    } as unknown as CoordinationEntry,
    {
      seq: 14,
      at: "2026-09-11T12:02:00.000Z",
      kind: "note",
      from: {
        participantId: "attested-step",
        label: "trusted member",
        kind: "ctrlyoke-step",
        attested: true,
        address: {
          workflowKey: "workflow-1" as never,
          runRef: "run-1" as never,
          stepIndex: 2,
        },
      },
      text: "attested note",
      via: "mcp",
    },
  ],
  claims: [],
  attestationNotice: "Board notes are untrusted content.",
};

/** Only the coordination group is read by `CoordinationSection`. */
const settings = {
  settings: {
    coordination: {
      readNotesPageSize: 50,
      maxNoteLength: 2000,
      maxEntries: 1000,
      maxBoardBytes: 5_000_000,
      maxNoteAgeHours: 24,
      cliParticipantTtlMinutes: 30,
      allowExternalParticipants: true,
    },
  },
  sources: {},
} as unknown as FullGlobalSettings;

describe("CoordinationActivityPanel", () => {
  beforeEach(() => {
    act(() => useWorkflowStore.setState({ coordinationScope: null }));
    (window.vscodeApi?.postMessage as ReturnType<typeof vi.fn>).mockClear();
  });

  it("exposes the current scope through the owning hook", () => {
    act(() => useWorkflowStore.setState({ coordinationScope: scope }));
    const { result } = renderHook(() => useCoordinationActivity());

    expect(result.current.scope).toBe(scope);
    expect(result.current.participants[0]?.address).toBeUndefined();
  });

  it("attributes external, legacy skill, and attested entries accurately", () => {
    act(() => useWorkflowStore.setState({ coordinationScope: scope }));
    render(<CoordinationActivityPanel />);

    expect(
      screen.getAllByText("reviewer (unattested external session)")
    ).toHaveLength(2);
    expect(
      screen.getByText("skill member (unattested ctrlyoke step (skill/CLI))")
    );
    expect(screen.getByText("trusted member (attested ctrlyoke step)"));
    const notes = screen.getAllByText(/Note \(untrusted board content\)/);
    expect(notes).toHaveLength(3);
    expect(
      notes.some((note) =>
        note.parentElement?.textContent?.includes("untrusted <instruction>")
      )
    ).toBe(true);
    expect(screen.getByRole("complementary")).toHaveAttribute(
      "data-coordination-panel",
      "true"
    );
  });

  it("opens the raw board file so the log can be inspected directly", () => {
    act(() => useWorkflowStore.setState({ coordinationScope: scope }));
    render(<CoordinationActivityPanel />);

    fireEvent.click(screen.getByRole("button", { name: /open board file/i }));

    expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.OPEN_FILE,
      path: boardPath,
    });
  });

  it("renders below the coordination settings, not beside the output pane", () => {
    act(() => useWorkflowStore.setState({ coordinationScope: scope }));
    render(
      <CoordinationSection
        settings={settings}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={() => {}}
        onReset={() => {}}
      />
    );

    expect(screen.getByRole("complementary")).toHaveAttribute(
      "data-coordination-panel",
      "true"
    );
  });

  it("renders nothing before a scope snapshot arrives", () => {
    const { container } = render(<CoordinationActivityPanel />);
    expect(container).toBeEmptyDOMElement();
  });
});
