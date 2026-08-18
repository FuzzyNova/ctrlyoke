import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowPortabilityReportModal } from "@components/shared/WorkflowPortabilityReportModal";
import { useCompatibilityStore } from "@store/compatibilityStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  CAPABILITY_DOMAINS,
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_STATUSES,
  HARNESS_IDS,
  PERMISSION_MODES,
} from "@root/types/DashboardConstants";
import type { HarnessCapabilityRegistrySnapshot } from "@root/types/CompatibilityTypes";

function makeSnapshot(available = true): HarnessCapabilityRegistrySnapshot {
  const harnesses = {} as HarnessCapabilityRegistrySnapshot["harnesses"];
  for (const harnessId of Object.values(HARNESS_IDS)) {
    const exactState = {
      fidelity: CAPABILITY_FIDELITIES.EXACT,
      mechanism: CAPABILITY_MECHANISMS.NATIVE,
      verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
    } as const;
    const declaration = {
      fidelity: CAPABILITY_FIDELITIES.EXACT,
      mechanism: CAPABILITY_MECHANISMS.NATIVE,
    } as const;
    harnesses[harnessId] = {
      available,
      descriptor: {
        harnessId,
        permissions: {
          mode: declaration,
          allowedTools: declaration,
          deniedTools: declaration,
        },
      },
      effective: {
        permissions: {
          mode: exactState,
          allowedTools: exactState,
          deniedTools: exactState,
        },
      },
    };
  }

  harnesses[HARNESS_IDS.CODEX_CLI].effective!.permissions!.allowedTools = {
    fidelity: CAPABILITY_FIDELITIES.UNSUPPORTED,
    mechanism: CAPABILITY_MECHANISMS.NONE,
    verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
  };
  harnesses[HARNESS_IDS.OPENCODE_CLI].effective!.permissions!.allowedTools = {
    fidelity: CAPABILITY_FIDELITIES.PARTIAL,
    mechanism: CAPABILITY_MECHANISMS.TRANSLATED_CLI,
    verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
  };
  harnesses[HARNESS_IDS.QWEN_CLI].effective!.permissions!.mode = {
    fidelity: CAPABILITY_FIDELITIES.EXACT,
    mechanism: CAPABILITY_MECHANISMS.WORKSPACE_CONFIG,
    verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
  };
  harnesses[HARNESS_IDS.ANTIGRAVITY_CLI].effective!.permissions!.mode = {
    fidelity: CAPABILITY_FIDELITIES.EXACT,
    mechanism: CAPABILITY_MECHANISMS.NATIVE,
    verification: CAPABILITY_VERIFICATION_STATUSES.UNKNOWN,
  };

  return {
    schemaVersion: 1,
    enabledDomains: [CAPABILITY_DOMAINS.PERMISSIONS],
    harnesses,
  };
}

function resetStores(): void {
  useCompatibilityStore.getState().resetCapabilitySnapshot();
  useSettingsStore.getState().resetSettings();
  useWorkflowStore.getState().resetWorkflow();
  useUiStore.getState().resetUi();
}

function seedWorkflow(): void {
  useWorkflowStore.setState({
    steps: [{ prompt: "Use the configured tools" }],
  });
  useSettingsStore.getState().setWorkflowProperties({
    toolPermissions: {
      mode: PERMISSION_MODES.CUSTOM,
      allowedTools: ["shell(git:*)"],
      deniedTools: [],
    },
  });
  useCompatibilityStore.getState().setCapabilitySnapshot(makeSnapshot());
  useUiStore.getState().setWorkflowPortabilityReportOpen(true);
}

describe("WorkflowPortabilityReportModal", () => {
  beforeEach(resetStores);
  afterEach(cleanup);

  it("renders one row per installed harness and classifies the projection", async () => {
    seedWorkflow();
    render(<WorkflowPortabilityReportModal />);

    expect(screen.getAllByRole("row")).toHaveLength(7);
    expect(screen.getAllByText("Ready")).toHaveLength(3);
    expect(screen.getByText("Lossy")).toBeInTheDocument();
    expect(screen.getByText("Unsupported")).toBeInTheDocument();
    expect(screen.getByText("Workspace side effects")).toBeInTheDocument();
    expect(screen.getByText("unverified")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Show Codex details" })
    );

    expect(screen.getByText("Codex details")).toBeInTheDocument();
    expect(
      screen.getByText("compatibility.permissions.allowedTools.notEnforced")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Remove the rule or select a harness/)
    ).toBeInTheDocument();
    expect(screen.getByText("Workflow properties")).toBeInTheDocument();
  });

  it("shows neutral loading and empty states without speculative rows", () => {
    useUiStore.getState().setWorkflowPortabilityReportOpen(true);
    render(<WorkflowPortabilityReportModal />);
    expect(screen.getByRole("status")).toHaveTextContent(
      /Checking installed harness capabilities/
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    cleanup();
    useCompatibilityStore.getState().setCapabilitySnapshot(makeSnapshot(false));
    render(<WorkflowPortabilityReportModal />);
    expect(screen.getByRole("status")).toHaveTextContent(
      /No installed harnesses/
    );
  });

  it("uses a responsive overflow region and restores focus to the opener", async () => {
    seedWorkflow();
    const opener = document.createElement("button");
    opener.type = "button";
    opener.textContent = "Open report";
    document.body.appendChild(opener);
    opener.focus();

    render(<WorkflowPortabilityReportModal />);
    expect(
      screen.getByRole("region", {
        name: "Installed harness portability report",
      })
    ).toHaveClass("overflow-x-auto");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Close modal" }));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
