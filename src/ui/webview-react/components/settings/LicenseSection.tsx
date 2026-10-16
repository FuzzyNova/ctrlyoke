import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LICENSE_ACTIONS,
  LICENSE_UI,
  MESSAGE_TYPES,
  USER_FEEDBACK_SEVERITY,
  VSCODE_COMMANDS,
} from "@root/types/DashboardConstants";
import { LICENSE_SOURCES } from "../../../../license/LicenseService";
import type {
  LicenseMachineSummary,
  LicenseSeatUsage,
} from "@root/types/WebviewMessageTypes";
import { useVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { useSettingsStore } from "@store/settingsStore";
import {
  ActionButton,
  actionFeedbackDurationMs,
  type ActionFeedback,
} from "../shared/ActionButton";
import { LocalTextInput } from "../shared/LocalInputs";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { Icon } from "../shared/Icon";

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDate(value: number | string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

function trialDaysLeft(trialEndsAt: number | null, now: number): number | null {
  if (trialEndsAt === null || trialEndsAt <= now) return null;
  return Math.ceil((trialEndsAt - now) / DAY_MS);
}

function machineLabel(machine: LicenseMachineSummary): string {
  return (
    [machine.name, machine.platform].filter(Boolean).join(" · ") ||
    "Unknown machine"
  );
}

/** Feedback key for an error on one machine row. */
function machineFeedbackKey(machineId: string): string {
  return `${MESSAGE_TYPES.DEACTIVATE_LICENSE_MACHINE}:${machineId}`;
}

function SeatUsageMeter({ usage }: { usage: LicenseSeatUsage }) {
  const used = usage.used.toLocaleString();
  if (usage.max === null) {
    return <p className="text-xs text-foreground">{used} seats in use</p>;
  }
  const remaining = Math.max(0, usage.max - usage.used);
  const percent = Math.min(100, (usage.used / Math.max(1, usage.max)) * 100);
  return (
    <div className="space-y-1">
      <p className="text-xs text-foreground">
        {used} of {usage.max.toLocaleString()} seats in use ·{" "}
        {remaining.toLocaleString()} remaining
      </p>
      <div
        role="meter"
        aria-label="Seats in use"
        aria-valuemin={0}
        aria-valuemax={usage.max}
        aria-valuenow={usage.used}
        className="h-1.5 overflow-hidden rounded-sm bg-panel-border"
      >
        <div className="h-full bg-pro-brand" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function LicenseSection() {
  const vscode = useVsCodeApi();
  const licenseAccess = useSettingsStore((state) => state.licenseAccess);
  const machines = useSettingsStore((state) => state.licenseMachines);
  const seatUsage = useSettingsStore((state) => state.licenseSeatUsage);
  const actionResult = useSettingsStore((state) => state.licenseActionResult);
  const clearActionResult = useSettingsStore(
    (state) => state.clearLicenseActionResult
  );
  const [licenseKey, setLicenseKey] = useState("");
  const [licenseBlob, setLicenseBlob] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [pendingMachine, setPendingMachine] =
    useState<LicenseMachineSummary | null>(null);
  const [feedback, setFeedback] = useState<Record<string, ActionFeedback>>({});
  const feedbackTimersRef = useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});
  const [machineError, setMachineError] = useState<string | undefined>();
  const [machineListPending, setMachineListPending] = useState(false);
  const [seatUsagePending, setSeatUsagePending] = useState(false);
  const [seatUsageError, setSeatUsageError] = useState<string | undefined>();
  const [activationLimit, setActivationLimit] = useState(false);
  const [confirmingDeactivation, setConfirmingDeactivation] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      for (const timer of Object.values(feedbackTimersRef.current))
        clearTimeout(timer);
    },
    []
  );

  const clearFeedback = useCallback((key: string) => {
    clearTimeout(feedbackTimersRef.current[key]);
    delete feedbackTimersRef.current[key];
    setFeedback((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const showFeedback = useCallback(
    (key: string, result: ActionFeedback) => {
      clearTimeout(feedbackTimersRef.current[key]);
      setFeedback((current) => ({ ...current, [key]: result }));
      feedbackTimersRef.current[key] = setTimeout(
        () => clearFeedback(key),
        actionFeedbackDurationMs(result)
      );
    },
    [clearFeedback]
  );

  const isEnterprise = licenseAccess.isEnterprise === true;
  const tierLabel = isEnterprise
    ? "Enterprise"
    : licenseAccess.isPro
      ? "Pro"
      : "Free";
  const isOnlineLicense =
    licenseAccess.isPro &&
    licenseAccess.source !== LICENSE_SOURCES.OFFLINE_FILE;
  const showMachines = !isEnterprise && (activationLimit || isOnlineLicense);
  // Enterprise keys are shared company-wide, so employees see the seat count
  // but never the machine list (anyone could otherwise deactivate everyone).
  const showSeatUsage = isEnterprise && isOnlineLicense;

  const requestMachines = useCallback(() => {
    setMachineListPending(true);
    setMachineError(undefined);
    vscode.postMessage({ type: MESSAGE_TYPES.REQUEST_LICENSE_MACHINES });
  }, [vscode]);

  const requestSeatUsage = useCallback(() => {
    setSeatUsagePending(true);
    setSeatUsageError(undefined);
    vscode.postMessage({ type: MESSAGE_TYPES.REQUEST_LICENSE_SEAT_USAGE });
  }, [vscode]);

  useEffect(() => {
    if (showMachines) requestMachines();
  }, [requestMachines, showMachines]);

  useEffect(() => {
    if (showSeatUsage) requestSeatUsage();
  }, [requestSeatUsage, showSeatUsage]);

  useEffect(() => {
    if (!actionResult) return;

    if (actionResult.action === MESSAGE_TYPES.REQUEST_LICENSE_MACHINES) {
      setMachineListPending(false);
      if (actionResult.status === USER_FEEDBACK_SEVERITY.ERROR)
        setMachineError(actionResult.message);
      clearActionResult();
      return;
    }

    if (actionResult.action === MESSAGE_TYPES.REQUEST_LICENSE_SEAT_USAGE) {
      setSeatUsagePending(false);
      if (actionResult.status === USER_FEEDBACK_SEVERITY.ERROR)
        setSeatUsageError(actionResult.message);
      clearActionResult();
      return;
    }

    if (actionResult.action === LICENSE_ACTIONS.ACTIVATION_LIMIT) {
      setPendingAction(null);
      setActivationLimit(true);
      clearActionResult();
      return;
    }

    if (actionResult.action === MESSAGE_TYPES.DEACTIVATE_LICENSE_MACHINE) {
      setPendingAction(null);
      setPendingMachine(null);
      // A deactivated machine drops out of the refreshed list, so success is
      // reported once for the section; an error stays on the row it concerns.
      if (actionResult.status === USER_FEEDBACK_SEVERITY.SUCCESS) {
        showFeedback(MESSAGE_TYPES.DEACTIVATE_LICENSE_MACHINE, {
          status: actionResult.status,
          message: pendingMachine
            ? `Deactivated ${machineLabel(pendingMachine)}.`
            : actionResult.message,
        });
      } else if (pendingMachine) {
        showFeedback(machineFeedbackKey(pendingMachine.id), {
          status: actionResult.status,
          message: actionResult.message,
        });
      }
      clearActionResult();
      return;
    }

    if (pendingAction !== actionResult.action) return;
    setPendingAction(null);
    showFeedback(actionResult.action, {
      status: actionResult.status,
      message: actionResult.message,
    });
    if (
      actionResult.action === MESSAGE_TYPES.ACTIVATE_LICENSE_KEY &&
      actionResult.status === USER_FEEDBACK_SEVERITY.SUCCESS
    ) {
      setLicenseKey("");
      setActivationLimit(false);
    }
    if (
      actionResult.action === MESSAGE_TYPES.IMPORT_LICENSE_FILE &&
      actionResult.status === USER_FEEDBACK_SEVERITY.SUCCESS
    ) {
      setLicenseBlob("");
    }
    clearActionResult();
  }, [
    actionResult,
    clearActionResult,
    pendingAction,
    pendingMachine,
    showFeedback,
  ]);

  const postAction = useCallback(
    (action: string, payload: Record<string, unknown> = {}) => {
      clearFeedback(action);
      setPendingAction(action);
      vscode.postMessage({ type: action, ...payload });
    },
    [clearFeedback, vscode]
  );

  const deactivateMachine = useCallback(
    (machine: LicenseMachineSummary) => {
      clearFeedback(machineFeedbackKey(machine.id));
      setPendingMachine(machine);
      postAction(MESSAGE_TYPES.DEACTIVATE_LICENSE_MACHINE, {
        machineId: machine.id,
      });
    },
    [clearFeedback, postAction]
  );

  const trialLeft = trialDaysLeft(licenseAccess.trialEndsAt, now);
  const expiry = licenseAccess.expiresAt
    ? formatDate(licenseAccess.expiresAt)
    : "Perpetual";
  const source = licenseAccess.isPro
    ? licenseAccess.source === LICENSE_SOURCES.OFFLINE_FILE
      ? "Offline license file"
      : "Online activation"
    : "None";

  const deactivateFeedback = feedback[MESSAGE_TYPES.DEACTIVATE_LICENSE];
  const machineFeedback = feedback[MESSAGE_TYPES.DEACTIVATE_LICENSE_MACHINE];
  const activateFeedback = feedback[MESSAGE_TYPES.ACTIVATE_LICENSE_KEY];
  const importFeedback = feedback[MESSAGE_TYPES.IMPORT_LICENSE_FILE];

  const statusDetails = useMemo(
    () => [
      ["Tier", tierLabel],
      ["Source", source],
      ["Expiry", expiry],
    ],
    [expiry, source, tierLabel]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            data-settings-search-id="landmark:license:account"
            className="text-xs font-semibold uppercase text-description-fg mb-1 tracking-wide"
          >
            License
          </h3>
          <p className="text-xs text-description-fg">
            Manage the Pro license for ctrlyoke and the machine it is activated
            on.
          </p>
        </div>
        {!licenseAccess.isPro && (
          <a
            href={LICENSE_UI.PRICING_URL}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded-sm bg-pro-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
          >
            Purchase a License
          </a>
        )}
      </div>

      <section
        className="rounded-sm border border-panel-border bg-input-bg p-3"
        aria-label="License status"
      >
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-foreground">
            License status
          </h4>
          <span
            className={`rounded-sm px-2 py-0.5 text-xs font-semibold ${licenseAccess.isPro ? "bg-pro-brand text-white" : "border border-panel-border text-description-fg"}`}
          >
            {tierLabel}
          </span>
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
          {statusDetails.map(([label, value]) => (
            <div key={label}>
              <dt className="text-description-fg">{label}</dt>
              <dd className="mt-0.5 text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        {trialLeft !== null && !licenseAccess.isPro && (
          <p className="mt-3 text-xs text-pro-brand" role="status">
            Remote access trial: {trialLeft} {trialLeft === 1 ? "day" : "days"}{" "}
            left
          </p>
        )}
        {!licenseAccess.isPro && licenseAccess.trialEndsAt === null && (
          <p className="mt-3 text-xs text-description-fg">
            {LICENSE_UI.REMOTE_ACCESS_TRIAL_AVAILABLE}
          </p>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="activate-license-heading">
        <div>
          <h4
            id="activate-license-heading"
            className="text-sm font-semibold text-foreground"
          >
            Activate with license key
          </h4>
          <p className="text-xs text-description-fg">
            Enter the Pro key from your ctrlyoke purchase.
          </p>
        </div>
        {isStandalone && (
          <p className="text-xs text-description-fg">
            Activating applies to the machine running ctrlyoke, not this
            browser.
          </p>
        )}
        <div className="flex flex-wrap items-start gap-2">
          <LocalTextInput
            id="license-key"
            aria-label="Pro license key"
            type="password"
            value={licenseKey}
            onCommit={setLicenseKey}
            onValueChange={setLicenseKey}
            placeholder="Paste your Pro license key"
            className="min-w-0 basis-64 flex-1 bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground font-mono focus:outline-hidden focus:border-focus-border"
          />
          <ActionButton
            label="Activate"
            pendingLabel="Activating…"
            icon="key"
            pending={pendingAction === MESSAGE_TYPES.ACTIVATE_LICENSE_KEY}
            feedback={activateFeedback}
            disabled={!licenseKey.trim()}
            onClick={() =>
              postAction(MESSAGE_TYPES.ACTIVATE_LICENSE_KEY, {
                key: licenseKey,
              })
            }
          />
        </div>
        {activationLimit && (
          <p className="text-xs text-warning-fg" role="alert">
            This license is active on its maximum number of machines. Free up a
            slot, then retry activation.
          </p>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="import-license-heading">
        <div>
          <h4
            id="import-license-heading"
            className="text-sm font-semibold text-foreground"
          >
            Import offline license file
          </h4>
          <p className="text-xs text-description-fg">
            For an air-gapped activation using a signed{" "}
            <code>-----BEGIN LICENSE FILE-----</code> blob. See the{" "}
            <a
              href="https://github.com/FuzzyNova/ctrlyoke/blob/main/docs/pro/index.md"
              target="_blank"
              rel="noreferrer"
              className="text-link-fg hover:underline"
            >
              offline activation guide
            </a>
            .
          </p>
        </div>

        {!isStandalone && (
          <button
            type="button"
            className="cy-select-trigger w-auto shrink-0 gap-1 px-3 text-xs"
            onClick={() =>
              vscode.postMessage({
                type: MESSAGE_TYPES.EXECUTE_VSCODE_COMMAND,
                command: VSCODE_COMMANDS.ACTIVATE_OFFLINE_PRO,
              })
            }
          >
            <Icon name="folder-opened" className="text-xxs" />
            Browse for license file…
          </button>
        )}

        <div className="space-y-2">
          <p className="text-xs text-description-fg">
            {isStandalone
              ? "Paste the license file blob:"
              : "Or paste it in here and import it:"}
          </p>
          <textarea
            id="license-file"
            aria-label="Offline license file"
            value={licenseBlob}
            onChange={(event) => setLicenseBlob(event.target.value)}
            placeholder="-----BEGIN LICENSE FILE-----"
            rows={5}
            className="w-full resize-y bg-input-bg border border-input-border rounded-sm px-2 py-1 text-xs text-foreground font-mono focus:outline-hidden focus:border-focus-border"
          />
          <ActionButton
            label="Import license file"
            pendingLabel="Importing…"
            icon="file-add"
            pending={pendingAction === MESSAGE_TYPES.IMPORT_LICENSE_FILE}
            feedback={importFeedback}
            disabled={!licenseBlob.trim()}
            onClick={() =>
              postAction(MESSAGE_TYPES.IMPORT_LICENSE_FILE, {
                blob: licenseBlob,
              })
            }
          />
        </div>
      </section>

      {showMachines && (
        <section
          className="space-y-2"
          aria-labelledby="license-machines-heading"
        >
          <div className="flex items-baseline justify-between gap-2">
            <div>
              <h4
                id="license-machines-heading"
                className="text-sm font-semibold text-foreground"
              >
                Activated machines
              </h4>
              <p className="text-xs text-description-fg">
                Deactivate an unused machine to free a slot for this activation.
              </p>
            </div>
            <button
              type="button"
              className="cy-select-trigger w-auto shrink-0 gap-1 px-3 text-xs"
              onClick={requestMachines}
              disabled={machineListPending}
            >
              <Icon name="refresh" className="text-xxs" />
              Refresh
            </button>
          </div>
          {machineError && (
            <p className="text-xs text-error-fg" role="alert">
              {machineError}
            </p>
          )}
          {machineFeedback && (
            <p className="text-xs text-indicator-success" role="status">
              {machineFeedback.message}
            </p>
          )}
          {machineListPending ? (
            <p className="text-xs text-description-fg">Loading machines…</p>
          ) : machines.length === 0 ? (
            <p className="text-xs text-description-fg">
              No activated machines found.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-sm border border-panel-border">
              <table className="w-full text-xs">
                <thead className="bg-input-bg text-left text-description-fg">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Machine</th>
                    <th className="px-2 py-1.5 font-medium">Activated</th>
                    <th className="px-2 py-1.5 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {machines.map((machine) => (
                    <tr
                      key={machine.id}
                      className="border-t border-panel-border"
                    >
                      <td className="px-2 py-1.5 text-foreground">
                        {machineLabel(machine)}{" "}
                        {machine.isThisMachine && (
                          <span className="ml-1 rounded-sm border border-pro-brand px-1 text-xxs text-pro-brand">
                            This machine
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-description-fg">
                        {formatDate(machine.createdAt)}
                      </td>
                      <td className="px-2 py-1.5">
                        <ActionButton
                          label="Deactivate"
                          pendingLabel="Deactivating…"
                          icon="close"
                          disabled={
                            machine.isThisMachine || pendingMachine !== null
                          }
                          pending={pendingMachine?.id === machine.id}
                          feedback={feedback[machineFeedbackKey(machine.id)]}
                          onClick={() => deactivateMachine(machine)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {licenseAccess.isPro && isEnterprise && (
        <section
          className="space-y-2 rounded-sm border border-panel-border bg-input-bg p-3"
          aria-label="Enterprise seats"
        >
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-foreground">Seats</h4>
            {showSeatUsage && (
              <button
                type="button"
                className="cy-select-trigger w-auto shrink-0 gap-1 px-3 text-xs"
                onClick={requestSeatUsage}
                disabled={seatUsagePending}
              >
                <Icon name="refresh" className="text-xxs" />
                Refresh
              </button>
            )}
          </div>
          {seatUsageError && (
            <p className="text-xs text-error-fg" role="alert">
              {seatUsageError}
            </p>
          )}
          {showSeatUsage &&
            (seatUsagePending ? (
              <p className="text-xs text-description-fg">Loading seats…</p>
            ) : (
              seatUsage && <SeatUsageMeter usage={seatUsage} />
            ))}
          <p className="text-xs text-description-fg">
            Each machine that activates your company's key uses a seat until
            it's deactivated. To free seats held by machines you no longer use,
            or to raise your limit, email{" "}
            <a
              href={`mailto:${LICENSE_UI.SUPPORT_EMAIL}`}
              className="text-link-fg hover:underline"
            >
              {LICENSE_UI.SUPPORT_EMAIL}
            </a>
            .
          </p>
        </section>
      )}

      {licenseAccess.isPro && (
        <section
          className="border-t border-panel-border pt-3"
          aria-label="Deactivate license"
        >
          <ActionButton
            label="Deactivate Pro License"
            pendingLabel="Deactivating…"
            icon="close"
            pending={pendingAction === MESSAGE_TYPES.DEACTIVATE_LICENSE}
            feedback={deactivateFeedback}
            onClick={() => setConfirmingDeactivation(true)}
          />
          <p className="mt-1 text-xs text-description-fg">
            This removes the Pro activation from the current machine.
          </p>
        </section>
      )}

      <Modal
        isOpen={confirmingDeactivation}
        onClose={() => setConfirmingDeactivation(false)}
        title="Deactivate Pro License"
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              size="md"
              onClick={() => setConfirmingDeactivation(false)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="md"
              onClick={() => {
                setConfirmingDeactivation(false);
                postAction(MESSAGE_TYPES.DEACTIVATE_LICENSE);
              }}
            >
              Deactivate
            </Button>
          </>
        }
      >
        <p className="text-foreground">
          Deactivate the Pro license on this machine? You can activate it again
          later.
        </p>
      </Modal>
    </div>
  );
}
