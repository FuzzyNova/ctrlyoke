import React, { useState } from "react";
import {
  CAPABILITY_FIDELITIES,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_SOURCE_TIERS,
  FINAL_STEP_PHASES,
  HARNESS_INFO,
  type HarnessId,
} from "@root/types/DashboardConstants";
import {
  PORTABILITY_ROW_STATUSES,
  type PortabilityDiagnostic,
  type PortabilityHarnessRow,
  type PortabilityReport,
  type PortabilityWorkspaceSideEffect,
  type PortabilityRowStatus,
} from "@root/types/PortabilityReport";
import { formatCompatibilitySource } from "@utils/compatibilityDiagnostics";
import { HarnessIcon } from "./HarnessIcon";
import { Icon } from "./Icon";

const STATUS_META: Record<
  PortabilityRowStatus,
  { label: string; icon: string; className: string }
> = {
  [PORTABILITY_ROW_STATUSES.READY]: {
    label: "Compatible",
    icon: "pass",
    className: "text-indicator-success",
  },
  [PORTABILITY_ROW_STATUSES.LOSSY]: {
    label: "Lossy",
    icon: "warning",
    className: "text-warning-fg",
  },
  [PORTABILITY_ROW_STATUSES.UNSUPPORTED]: {
    label: "Unsupported",
    icon: "error",
    className: "text-error-fg",
  },
  [PORTABILITY_ROW_STATUSES.WORKSPACE_SIDE_EFFECTS]: {
    label: "Workspace side effects",
    icon: "workspace-unknown",
    className: "text-warning-fg",
  },
};

const SOURCE_LABELS: Record<string, string> = {
  [COMPATIBILITY_SOURCE_TIERS.PROMPT]: "Prompt properties",
  [COMPATIBILITY_SOURCE_TIERS.WORKFLOW]: "Workflow properties",
  [COMPATIBILITY_SOURCE_TIERS.DEFAULTS]: "Global defaults",
};

function harnessLabel(harnessId: HarnessId): string {
  return HARNESS_INFO[harnessId]?.name ?? harnessId;
}

function compatibilityDetailsId(harnessId: HarnessId): string {
  return `harness-compatibility-details-${harnessId}`;
}

function consumerLabel(consumer: PortabilityDiagnostic["consumer"]): string {
  if (!consumer) return "Workflow-level";
  return consumer.kind === FINAL_STEP_PHASES.QUEUE
    ? `Step ${consumer.stepIndex + 1}`
    : "Final step";
}

function sourceLabel(sourceTier: PortabilityDiagnostic["sourceTier"]): string {
  if (!sourceTier) return "Resolved capability";
  return (
    SOURCE_LABELS[sourceTier] ??
    formatCompatibilitySource(sourceTier) ??
    sourceTier
  );
}

function propertyLabel(propertyPointer: string | undefined): string {
  return propertyPointer ?? "Resolved capability";
}

function statusText(row: PortabilityHarnessRow): string {
  const status = STATUS_META[row.status].label;
  return row.unverified ? `${status}; unverified support` : status;
}

function CapabilityStateSummary({
  state,
}: {
  state: PortabilityWorkspaceSideEffect["state"];
}): React.ReactElement {
  const fidelity =
    state.fidelity === CAPABILITY_FIDELITIES.EXACT ? "exact" : state.fidelity;
  const verification =
    state.verification === CAPABILITY_VERIFICATION_STATUSES.VERIFIED
      ? "verified"
      : "unverified";
  return (
    <span className="text-description-fg">
      {fidelity}, {verification}
    </span>
  );
}

function Finding({
  diagnostic,
}: {
  diagnostic: PortabilityDiagnostic;
}): React.ReactElement {
  return (
    <li className="rounded border border-panel-border px-3 py-2">
      <div className="grid gap-2 sm:grid-cols-[minmax(8rem,auto)_minmax(0,1fr)]">
        <span className="text-description-fg">Location</span>
        <span>
          {consumerLabel(diagnostic.consumer)} ·{" "}
          {propertyLabel(diagnostic.propertyPointer)}
        </span>
        <span className="text-description-fg">Source</span>
        <span>{sourceLabel(diagnostic.sourceTier)}</span>
        <span className="text-description-fg">Code</span>
        <code className="break-all text-xxs">{diagnostic.code}</code>
        <span className="text-description-fg">Message</span>
        <span>{diagnostic.message}</span>
        {diagnostic.remediation && (
          <>
            <span className="text-description-fg">Remediation</span>
            <span>{diagnostic.remediation}</span>
          </>
        )}
      </div>
    </li>
  );
}

function WorkspaceSideEffect({
  sideEffect,
}: {
  sideEffect: PortabilityWorkspaceSideEffect;
}): React.ReactElement {
  return (
    <li className="rounded border border-warning-fg border-opacity-40 bg-severity-warning-bg px-3 py-2">
      <div className="grid gap-2 sm:grid-cols-[minmax(8rem,auto)_minmax(0,1fr)]">
        <span className="text-description-fg">Location</span>
        <span>
          {consumerLabel(sideEffect.consumer)} ·{" "}
          {propertyLabel(sideEffect.propertyPointer)}
        </span>
        <span className="text-description-fg">Source</span>
        <span>{sourceLabel(sideEffect.sourceTier)}</span>
        <span className="text-description-fg">Capability</span>
        <span>{sideEffect.capability}</span>
        <span className="text-description-fg">Effect</span>
        <span>
          Workspace configuration may be changed.{" "}
          <CapabilityStateSummary state={sideEffect.state} />
        </span>
      </div>
    </li>
  );
}

function ReportDetails({
  row,
}: {
  row: PortabilityHarnessRow;
}): React.ReactElement {
  const findingCount = row.diagnostics.length + row.workspaceSideEffects.length;
  return (
    <div
      id={compatibilityDetailsId(row.harnessId)}
      aria-labelledby={`${compatibilityDetailsId(row.harnessId)}-title`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4
          id={`${compatibilityDetailsId(row.harnessId)}-title`}
          className="text-sm font-semibold"
        >
          {harnessLabel(row.harnessId)} details
        </h4>
        <span className="text-xxs text-description-fg" aria-live="polite">
          {findingCount} {findingCount === 1 ? "finding" : "findings"}
        </span>
      </div>
      {findingCount === 0 ? (
        <p className="mt-3 text-xs text-description-fg">
          No step, final-step, or workspace findings for this harness.
        </p>
      ) : (
        <ul
          className="mt-3 flex flex-col gap-2 text-xs"
          aria-label={`${harnessLabel(row.harnessId)} findings`}
        >
          {row.diagnostics.map((diagnostic) => (
            <Finding key={diagnostic.identity} diagnostic={diagnostic} />
          ))}
          {row.workspaceSideEffects.map((sideEffect) => (
            <WorkspaceSideEffect
              key={sideEffect.identity}
              sideEffect={sideEffect}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ReportBody({
  report,
  expandedHarnessIds,
  onToggle,
}: {
  report: PortabilityReport;
  expandedHarnessIds: ReadonlySet<HarnessId>;
  onToggle: (harnessId: HarnessId) => void;
}): React.ReactElement {
  if (report.rows.length === 0) {
    return (
      <div
        className="rounded border border-panel-border px-3 py-4 text-sm text-description-fg"
        role="status"
      >
        No installed harnesses are available to compare with this workflow.
      </div>
    );
  }

  return (
    <div
      className="overflow-x-auto"
      role="region"
      aria-label="Installed harness compatibility report"
    >
      <table className="w-full min-w-[34rem] border-collapse text-left text-xs">
        <caption className="sr-only">
          Installed harness compatibility classifications
        </caption>
        <thead className="text-description-fg">
          <tr className="border-b border-panel-border">
            <th scope="col" className="px-2 py-2 font-semibold">
              Harness
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              Result
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              Findings
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              <span className="sr-only">Select</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => {
            const meta = STATUS_META[row.status];
            const expanded = expandedHarnessIds.has(row.harnessId);
            const detailsId = compatibilityDetailsId(row.harnessId);
            return (
              <React.Fragment key={row.harnessId}>
                <tr className="border-b border-panel-border">
                  <th scope="row" className="px-2 py-3 font-normal">
                    <button
                      type="button"
                      className="flex min-w-0 items-center gap-2 rounded text-left text-foreground underline-offset-2 hover:underline focus:outline-none focus:ring-1 focus:ring-focus-border"
                      aria-controls={detailsId}
                      aria-expanded={expanded}
                      onClick={() => onToggle(row.harnessId)}
                    >
                      <HarnessIcon harnessId={row.harnessId} size={20} />
                      <span className="min-w-0 break-words">
                        {harnessLabel(row.harnessId)}
                      </span>
                    </button>
                  </th>
                  <td className={`px-2 py-3 ${meta.className}`}>
                    <span
                      className="inline-flex items-center gap-1"
                      aria-label={statusText(row)}
                    >
                      <Icon name={meta.icon} />
                      <span>{meta.label}</span>
                      {row.unverified && (
                        <span className="ml-1 text-xxs text-description-fg">
                          unverified
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-2 py-3 text-description-fg">
                    {row.diagnostics.length + row.workspaceSideEffects.length}
                  </td>
                  <td className="px-2 py-3 text-right">
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-link-fg hover:underline focus:outline-none focus:ring-1 focus:ring-focus-border"
                      aria-label={`${expanded ? "Hide" : "Show"} ${harnessLabel(row.harnessId)} details`}
                      aria-controls={detailsId}
                      aria-expanded={expanded}
                      onClick={() => onToggle(row.harnessId)}
                    >
                      {expanded ? "Hide" : "Details"}
                    </button>
                  </td>
                </tr>
                {expanded && (
                  <tr className="border-b border-panel-border">
                    <td colSpan={4} className="bg-input-bg px-4 py-3">
                      <ReportDetails row={row} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export interface PortabilityReportSectionProps {
  report: PortabilityReport | null;
  isChecking: boolean;
}

/** Renders the installed-harness compatibility comparison as a Dry Run
 * overview section. `report` is only null while `isChecking` is true — the
 * caller is expected to keep `includePortabilityReport` enabled whenever this
 * section is mounted. Each row's details expand inline, accordion-style,
 * directly beneath that row; multiple rows may stay expanded at once. */
export const PortabilityReportSection: React.FC<
  PortabilityReportSectionProps
> = ({ report, isChecking }) => {
  const [expandedHarnessIds, setExpandedHarnessIds] = useState<
    ReadonlySet<HarnessId>
  >(new Set());

  const toggleHarness = (harnessId: HarnessId) => {
    setExpandedHarnessIds((current) => {
      const next = new Set(current);
      if (next.has(harnessId)) {
        next.delete(harnessId);
      } else {
        next.add(harnessId);
      }
      return next;
    });
  };

  return (
    <section aria-live="polite">
      <h3 className="mb-3 text-sm font-semibold text-foreground">
        Harness compatibility report
      </h3>
      {isChecking || !report ? (
        <p
          className="flex items-center gap-2 text-sm text-description-fg"
          role="status"
        >
          <Icon name="loading" className="codicon-modifier-spin" />
          Checking installed harness capabilities…
        </p>
      ) : (
        <ReportBody
          report={report}
          expandedHarnessIds={expandedHarnessIds}
          onToggle={toggleHarness}
        />
      )}
    </section>
  );
};
