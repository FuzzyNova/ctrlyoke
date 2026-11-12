import React, { useEffect, useId, useMemo, useState } from "react";
import type {
  WorkflowSchedule,
  WorkflowViewAddress,
} from "@root/types/CtrlYokeTypes";
import {
  nextScheduleOccurrence,
  validateWorkflowSchedule,
} from "@root/utils/WorkflowSchedule";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { sendMessage } from "@messaging/sendMessage";
import { Button } from "@components/shared";
import { DropdownDrawerHeader } from "./DropdownDrawerHeader";
import {
  WORKFLOW_SCHEDULE_FREQUENCIES as FREQUENCY,
  WORKFLOW_SCHEDULE_DEFAULT_CRON,
  WORKFLOW_SCHEDULE_LABELS as LABELS,
  WORKFLOW_SCHEDULE_PREVIEW_HOST_ID,
  WORKFLOW_SCHEDULE_WEEKDAYS as WEEKDAYS,
} from "../../constants";

type Frequency = (typeof FREQUENCY)[keyof typeof FREQUENCY];

const FREQUENCY_OPTIONS: ReadonlyArray<readonly [Frequency, string]> = [
  [FREQUENCY.once, LABELS.once],
  [FREQUENCY.daily, LABELS.daily],
  [FREQUENCY.weekly, LABELS.weekly],
  [FREQUENCY.monthly, LABELS.monthly],
  [FREQUENCY.custom, LABELS.custom],
];

const pad = (n: number) => String(n).padStart(2, "0");
const localDateTimeValue = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
const localTimeValue = (date: Date) =>
  `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** Everything the pickers edit. A cron trigger stores no start date, so recurring pickers edit a time, not a datetime. */
interface PickerState {
  frequency: Frequency;
  onceAt: string;
  time: string;
  weekdays: number[];
  dayOfMonth: number;
  custom: string;
}

function cronFor(picker: PickerState): string {
  const [hour, minute] = picker.time.split(":").map(Number);
  switch (picker.frequency) {
    case FREQUENCY.daily:
      return `${minute} ${hour} * * *`;
    case FREQUENCY.weekly:
      return `${minute} ${hour} * * ${picker.weekdays.join(",")}`;
    case FREQUENCY.monthly:
      return `${minute} ${hour} ${picker.dayOfMonth} * *`;
    case FREQUENCY.custom:
      return picker.custom;
    default:
      return "";
  }
}

/** Maps a stored schedule back onto the friendliest picker that reproduces it exactly. */
function pickerFor(schedule?: WorkflowSchedule): PickerState {
  const soon = new Date(Date.now() + 60 * 60_000);
  soon.setMinutes(0, 0, 0);
  const defaults: PickerState = {
    frequency: FREQUENCY.once,
    onceAt: localDateTimeValue(soon),
    time: localTimeValue(soon),
    weekdays: [soon.getDay()],
    dayOfMonth: soon.getDate(),
    custom: WORKFLOW_SCHEDULE_DEFAULT_CRON,
  };
  if (!schedule) return defaults;
  if ("at" in schedule.trigger) {
    const at = new Date(schedule.trigger.at);
    return {
      ...defaults,
      onceAt: schedule.trigger.at.slice(0, 16),
      time: localTimeValue(at),
    };
  }
  const cron = schedule.trigger.cron;
  const custom = { ...defaults, frequency: FREQUENCY.custom, custom: cron };
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return custom;
  const [minute, hour, dom, month, dow] = fields;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || month !== "*")
    return custom;
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (dom === "*" && dow === "*")
    return { ...custom, frequency: FREQUENCY.daily, time };
  if (dom === "*" && /^\d+(,\d+)*$/.test(dow)) {
    const weekdays = [
      ...new Set(
        dow
          .split(",")
          .map(Number)
          .map((day) => (day === 7 ? 0 : day))
      ),
    ].sort((a, b) => a - b);
    return { ...custom, frequency: FREQUENCY.weekly, time, weekdays };
  }
  if (/^\d+$/.test(dom) && dow === "*")
    return {
      ...custom,
      frequency: FREQUENCY.monthly,
      time,
      dayOfMonth: Number(dom),
    };
  return custom;
}

const FIELD_LABEL_CLASS = "mb-1 block text-xs text-description-fg";
const INPUT_CLASS =
  "h-7 rounded-sm border border-input-border bg-input-bg px-1.5 text-xs text-input-fg outline-hidden focus:border-focus-border";
const SEGMENT_CLASS =
  "h-7 flex-1 border-y border-l border-btn-border px-2 text-xs transition-colors first:rounded-l-sm last:rounded-r-sm last:border-r";
const segmentStateClass = (selected: boolean) =>
  selected
    ? "bg-btn-bg text-btn-fg"
    : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover";

export interface SchedulePanelProps {
  address: WorkflowViewAddress;
  workflowName: string;
  schedule?: WorkflowSchedule;
  scheduleLastMissedAt?: number;
  scheduleOnOtherHost?: boolean;
  /** Names where Back returns to (the workflow list or the run panel). */
  backLabel: string;
  /** Leaves the panel: Back, Cancel, and after Save or Remove. */
  onBack: () => void;
  onClose?: () => void;
}

/**
 * SchedulePanel - drill-in view of the workflow dropdown that creates, edits,
 * pauses or removes one lineage's schedule. It slides over the list (or the
 * run panel) like the run panel slides over the list, so interacting with it
 * never counts as a click outside the dropdown.
 */
export const SchedulePanel: React.FC<SchedulePanelProps> = ({
  address,
  workflowName,
  schedule,
  scheduleLastMissedAt,
  scheduleOnOtherHost,
  backLabel,
  onBack,
  onClose,
}) => {
  const idPrefix = useId();
  const fieldId = (name: string) => `${idPrefix}-${name}`;
  const initial = useMemo(() => pickerFor(schedule), [schedule]);
  const [picker, setPicker] = useState<PickerState>(initial);
  const [until, setUntil] = useState(schedule?.until?.slice(0, 16) ?? "");
  // A new schedule is always created active: pressing Schedule is the opt-in.
  // Pausing only exists for a schedule that is already saved.
  const [paused, setPaused] = useState(schedule ? !schedule.enabled : false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const update = (patch: Partial<PickerState>) =>
    setPicker((prev) => ({ ...prev, ...patch }));
  const { frequency } = picker;
  const isRecurring = frequency !== FREQUENCY.once;
  const trigger =
    frequency === FREQUENCY.once
      ? { at: picker.onceAt }
      : { cron: cronFor(picker) };
  const untilField = isRecurring && until ? { until } : {};
  const previewSchedule = {
    enabled: true,
    trigger,
    ...untilField,
    hostId: schedule?.hostId ?? WORKFLOW_SCHEDULE_PREVIEW_HOST_ID,
  } as WorkflowSchedule;
  const shapeError =
    frequency === FREQUENCY.weekly && picker.weekdays.length === 0
      ? LABELS.noWeekdays
      : validateWorkflowSchedule(previewSchedule);
  // A cron trigger stores no start date, so the backend fires the first
  // occurrence after now. Preview exactly that.
  const next =
    typeof shapeError === "string"
      ? null
      : nextScheduleOccurrence(previewSchedule, now);
  // A one-shot in the past (or an Until already behind every occurrence)
  // saves fine but never fires, so refuse it unless the schedule is paused.
  const validationError =
    typeof shapeError === "string"
      ? shapeError
      : next === null && !paused
        ? LABELS.neverRuns
        : undefined;
  const hasError = validationError !== undefined;

  const save = () => {
    sendMessage(MESSAGE_TYPES.SET_SCHEDULE, {
      address,
      enabled: !paused,
      trigger,
      ...untilField,
    });
    onBack();
  };
  const remove = () => {
    sendMessage(MESSAGE_TYPES.CLEAR_SCHEDULE, { address });
    onBack();
  };

  return (
    <section
      className="schedule-panel flex h-full flex-col"
      aria-label={`${LABELS.scheduleTitle} ${workflowName}`}
    >
      <DropdownDrawerHeader
        eyebrow={LABELS.scheduleTitle}
        title={workflowName}
        backLabel={backLabel}
        onBack={onBack}
        onClose={onClose}
      />

      <div className="schedule-panel-body min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-xs text-foreground">
        <div role="radiogroup" aria-label={LABELS.repeat}>
          <span className={FIELD_LABEL_CLASS} aria-hidden="true">
            {LABELS.repeat}
          </span>
          <div className="flex">
            {FREQUENCY_OPTIONS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={frequency === value}
                onClick={() => update({ frequency: value })}
                className={`${SEGMENT_CLASS} ${segmentStateClass(frequency === value)}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {frequency === FREQUENCY.once && (
          <div>
            <label htmlFor={fieldId("at")} className={FIELD_LABEL_CLASS}>
              {LABELS.dateTime}
            </label>
            <input
              id={fieldId("at")}
              type="datetime-local"
              value={picker.onceAt}
              onChange={(e) => update({ onceAt: e.target.value })}
              className={`${INPUT_CLASS} w-full max-w-[220px]`}
            />
          </div>
        )}

        {frequency === FREQUENCY.weekly && (
          <div role="group" aria-label={LABELS.weekdays}>
            <span className={FIELD_LABEL_CLASS} aria-hidden="true">
              {LABELS.weekdays}
            </span>
            <div className="flex">
              {WEEKDAYS.map((day, index) => {
                const selected = picker.weekdays.includes(index);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      update({
                        weekdays: selected
                          ? picker.weekdays.filter((d) => d !== index)
                          : [...picker.weekdays, index].sort((a, b) => a - b),
                      })
                    }
                    className={`${SEGMENT_CLASS} ${segmentStateClass(selected)}`}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {(frequency === FREQUENCY.daily ||
          frequency === FREQUENCY.weekly ||
          frequency === FREQUENCY.monthly) && (
          <div className="flex flex-wrap gap-3">
            {frequency === FREQUENCY.monthly && (
              <div>
                <label htmlFor={fieldId("dom")} className={FIELD_LABEL_CLASS}>
                  {LABELS.dayOfMonth}
                </label>
                <input
                  id={fieldId("dom")}
                  type="number"
                  min={1}
                  max={31}
                  value={picker.dayOfMonth}
                  onChange={(e) =>
                    update({
                      dayOfMonth: Math.min(
                        31,
                        Math.max(1, Math.trunc(Number(e.target.value)) || 1)
                      ),
                    })
                  }
                  className={`${INPUT_CLASS} w-[72px]`}
                />
              </div>
            )}
            <div>
              <label htmlFor={fieldId("time")} className={FIELD_LABEL_CLASS}>
                {LABELS.time}
              </label>
              <input
                id={fieldId("time")}
                type="time"
                value={picker.time}
                onChange={(e) =>
                  e.target.value && update({ time: e.target.value })
                }
                className={`${INPUT_CLASS} w-[120px]`}
              />
            </div>
          </div>
        )}
        {frequency === FREQUENCY.monthly && picker.dayOfMonth > 28 && (
          <p className="text-description-fg">{LABELS.dayOfMonthSkipNote}</p>
        )}

        {frequency === FREQUENCY.custom && (
          <div>
            <label htmlFor={fieldId("cron")} className={FIELD_LABEL_CLASS}>
              {LABELS.cronExpression}
            </label>
            <input
              id={fieldId("cron")}
              value={picker.custom}
              onChange={(e) => update({ custom: e.target.value })}
              spellCheck={false}
              aria-describedby={fieldId("cron-hint")}
              className={`${INPUT_CLASS} w-full max-w-[220px] font-mono`}
            />
            <p id={fieldId("cron-hint")} className="mt-1 text-description-fg">
              {LABELS.cronHint}
            </p>
          </div>
        )}

        {isRecurring && (
          <div>
            <label htmlFor={fieldId("until")} className={FIELD_LABEL_CLASS}>
              {LABELS.untilOptional}
            </label>
            <input
              id={fieldId("until")}
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className={`${INPUT_CLASS} w-full max-w-[220px]`}
            />
          </div>
        )}

        {schedule && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={paused}
              onChange={(e) => setPaused(e.target.checked)}
            />
            {LABELS.pauseSchedule}
          </label>
        )}

        <p>
          <span className="text-description-fg">{LABELS.nextRun}: </span>
          {paused
            ? LABELS.pausedNextRun
            : next === null
              ? LABELS.noNextRun
              : new Date(next).toLocaleString()}
        </p>
        {hasError && (
          <p role="alert" className="text-error-fg">
            {validationError}
          </p>
        )}
        {scheduleOnOtherHost && <p>{LABELS.otherHostNote}</p>}
        {scheduleLastMissedAt !== undefined && (
          <p className="text-description-fg">{LABELS.missedRunNote}</p>
        )}
        <p className="text-description-fg">{LABELS.hostRunningNote}</p>
      </div>

      <div className="schedule-panel-footer flex shrink-0 items-center gap-2 border-t border-dropdown-border bg-editor-bg px-2 py-2">
        {schedule && (
          <button
            type="button"
            onClick={remove}
            className="cursor-pointer rounded-sm border-none bg-transparent px-2 py-1 text-xs text-link-fg hover:bg-list-hover-bg"
          >
            {LABELS.remove}
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onBack}>
            {LABELS.cancel}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={hasError}
            onClick={save}
          >
            {schedule ? LABELS.saveChanges : LABELS.create}
          </Button>
        </div>
      </div>
    </section>
  );
};
