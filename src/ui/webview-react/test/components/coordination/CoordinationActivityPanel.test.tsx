import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationActivityPanel } from "@components/coordination/CoordinationActivityPanel";
import { useCoordinationActivity } from "@hooks/useCoordinationActivity";
import { useWorkflowStore } from "@store/workflowStore";
import type { CoordinationScopeSnapshot } from "@root/types/CtrlYokeTypes";

const scope: CoordinationScopeSnapshot = {
  executionRoot: "C:\\workspace",
  identity: "workspace-identity",
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

describe("CoordinationActivityPanel", () => {
  afterEach(() => {
    act(() => useWorkflowStore.setState({ coordinationScope: null }));
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
    expect(screen.getByText(/Note \(untrusted board content\)/).parentElement)
      .toHaveTextContent("untrusted <instruction>");
    expect(screen.getByRole("complementary")).toHaveAttribute(
      "data-coordination-panel",
      "true"
    );
  });
});
