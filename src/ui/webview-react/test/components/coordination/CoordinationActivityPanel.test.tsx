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
import type { CoordinationScopeSnapshot } from "@root/types/CtrlYokeTypes";
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
        attested: false,
      },
      text: "untrusted <instruction>",
      via: "cli",
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
      maxEntryAgeDays: 7,
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

  it("shows no-run external participants and marks notes as untrusted", () => {
    act(() => useWorkflowStore.setState({ coordinationScope: scope }));
    render(<CoordinationActivityPanel />);

    expect(
      screen.getAllByText("reviewer (unattested external session)")
    ).toHaveLength(2);
    expect(screen.getByText(/Note \(untrusted board content\)/));
    expect(
      screen.getByText(/Note \(untrusted board content\)/).parentElement
    ).toHaveTextContent("untrusted <instruction>");
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
