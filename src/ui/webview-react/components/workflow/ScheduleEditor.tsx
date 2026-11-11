import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
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
import { Icon } from "../shared/Icon";
import {
  WORKFLOW_SCHEDULE_FREQUENCIES as FREQUENCY,
  WORKFLOW_SCHEDULE_DEFAULT_CRON,
  WORKFLOW_SCHEDULE_LABELS as LABELS,
  WORKFLOW_SCHEDULE_PREVIEW_HOST_ID,
  WORKFLOW_SCHEDULE_WEEKDAYS as WEEKDAYS,
} from "../../constants";

type Frequency = (typeof FREQUENCY)[keyof typeof FREQUENCY];
const localInputValue = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const cronFor = (
  frequency: Frequency,
  date: Date,
  weekdays: number[],
  custom: string
) => {
  const minute = date.getMinutes();
  const hour = date.getHours();
  switch (frequency) {
    case FREQUENCY.daily:
      return `${minute} ${hour} * * *`;
    case FREQUENCY.weekly:
      return `${minute} ${hour} * * ${weekdays.length ? weekdays.join(",") : date.getDay()}`;
    case FREQUENCY.monthly:
      return `${minute} ${hour} ${date.getDate()} * *`;
    case FREQUENCY.custom:
      return custom;
    default:
      return "";
  }
};
function pickerFor(schedule?: WorkflowSchedule): {
  frequency: Frequency;
  date: Date;
  weekdays: number[];
  custom: string;
} {
  const date = new Date(Date.now() + 60_000);
  if (!schedule)
    return {
      frequency: FREQUENCY.once,
      date,
      weekdays: [date.getDay()],
      custom: WORKFLOW_SCHEDULE_DEFAULT_CRON,
    };
  if ("at" in schedule.trigger)
    return {
      frequency: FREQUENCY.once,
      date: new Date(schedule.trigger.at),
      weekdays: [date.getDay()],
      custom: WORKFLOW_SCHEDULE_DEFAULT_CRON,
    };
  const fields = schedule.trigger.cron.trim().split(/\s+/);
  if (fields.length !== 5)
    return {
      frequency: FREQUENCY.custom,
      date,
      weekdays: [],
      custom: schedule.trigger.cron,
    };
  const minute = /^\d+$/.test(fields[0]) ? Number(fields[0]) : 0;
  const hour = /^\d+$/.test(fields[1]) ? Number(fields[1]) : 9;
  date.setHours(hour, minute, 0, 0);
  let frequency: Frequency = FREQUENCY.custom;
  let weekdays: number[] = [];
  if (fields[2] === "*" && fields[3] === "*" && fields[4] === "*")
    frequency = FREQUENCY.daily;
  else if (
    fields[2] === "*" &&
    fields[3] === "*" &&
    /^\d+(,\d+)*$/.test(fields[4])
  ) {
    frequency = FREQUENCY.weekly;
    weekdays = fields[4]
      .split(",")
      .map(Number)
      .map((day) => (day === 7 ? 0 : day));
  } else if (
    /^\d+$/.test(fields[2]) &&
    fields[3] === "*" &&
    fields[4] === "*"
  ) {
    frequency = FREQUENCY.monthly;
    date.setDate(Number(fields[2]));
  }
  if (frequency === FREQUENCY.custom)
    return { frequency, date, weekdays, custom: schedule.trigger.cron };
  return { frequency, date, weekdays, custom: schedule.trigger.cron };
}

export interface ScheduleEditorProps {
  address: WorkflowViewAddress;
  workflowName: string;
  schedule?: WorkflowSchedule;
  scheduleNextRunAt?: number;
  scheduleLastMissedAt?: number;
  scheduleOnOtherHost?: boolean;
  anchor: HTMLElement | null;
  onClose: () => void;
}

/** Compact, anchored editor for a lineage schedule. */
export function ScheduleEditor(props: ScheduleEditorProps) {
  const { address, workflowName, schedule, anchor, onClose } = props;
  const initial = useMemo(() => pickerFor(schedule), [schedule]);
  const [frequency, setFrequency] = useState<Frequency>(initial.frequency);
  const [start, setStart] = useState(localInputValue(initial.date));
  const [weekdays, setWeekdays] = useState(initial.weekdays);
  const [custom, setCustom] = useState(initial.custom);
  const [until, setUntil] = useState(schedule?.until ?? "");
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      const panel = document.getElementById("workflow-schedule-editor");
      if (
        panel &&
        !panel.contains(event.target as Node) &&
        !anchor?.contains(event.target as Node)
      )
        onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [anchor, onClose]);
  const startDate = new Date(start);
  const trigger =
    frequency === FREQUENCY.once
      ? { at: start }
      : { cron: cronFor(frequency, startDate, weekdays, custom) };
  const previewSchedule = {
    enabled: true,
    trigger,
    ...(frequency !== FREQUENCY.once && until ? { until } : {}),
    hostId: schedule?.hostId ?? WORKFLOW_SCHEDULE_PREVIEW_HOST_ID,
  } as WorkflowSchedule;
  const scheduleValidation = validateWorkflowSchedule(previewSchedule);
  const next = nextScheduleOccurrence(
    previewSchedule,
    Math.max(now, new Date(start).getTime() - 60_000)
  );
  const rect = anchor?.getBoundingClientRect();
  const style: React.CSSProperties = {
    position: "fixed",
    zIndex: 10000,
    top: Math.min(window.innerHeight - 20, (rect?.bottom ?? 100) + 4),
    left: Math.max(8, Math.min(rect?.left ?? 100, window.innerWidth - 340)),
  };
  const save = () =>
    sendMessage(MESSAGE_TYPES.SET_SCHEDULE, {
      address,
      enabled,
      trigger,
      ...(frequency !== FREQUENCY.once && until ? { until } : {}),
    });
  const remove = () => sendMessage(MESSAGE_TYPES.CLEAR_SCHEDULE, { address });
  return createPortal(
    <section
      id="workflow-schedule-editor"
      role="dialog"
      aria-label={`${LABELS.scheduleTitle} ${workflowName}`}
      style={style}
      className="w-[320px] max-h-[80vh] overflow-auto rounded border border-panel-border bg-editor-bg p-3 text-xs text-foreground shadow-xl"
    >
      <header className="mb-2 flex items-center justify-between">
        <strong className="truncate">
          {LABELS.scheduleTitle} {workflowName}
        </strong>
        <button type="button" aria-label={LABELS.close} onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <label className="mb-2 block">
        {LABELS.frequency}
        <select
          className="mt-1 block w-full"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value as Frequency)}
        >
          {[
            [FREQUENCY.once, LABELS.once],
            [FREQUENCY.daily, LABELS.daily],
            [FREQUENCY.weekly, LABELS.weekly],
            [FREQUENCY.monthly, LABELS.monthly],
            [FREQUENCY.custom, LABELS.customCron],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="mb-2 block">
        {LABELS.startDateTime}
        <input
          className="mt-1 block w-full"
          type="datetime-local"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
      </label>
      {frequency === FREQUENCY.weekly && (
        <fieldset className="mb-2">
          <legend>{LABELS.weekdays}</legend>
          <div className="flex gap-1">
            {WEEKDAYS.map((day, index) => (
              <label key={day}>
                <input
                  type="checkbox"
                  checked={weekdays.includes(index)}
                  onChange={() =>
                    setWeekdays((prev) =>
                      prev.includes(index)
                        ? prev.filter((d) => d !== index)
                        : [...prev, index].sort()
                    )
                  }
                />
                {day}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {frequency === FREQUENCY.custom && (
        <label className="mb-2 block">
          {LABELS.cronExpression}
          <input
            className="mt-1 block w-full font-mono"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        </label>
      )}
      {frequency !== FREQUENCY.once && (
        <label className="mb-2 block">
          {LABELS.untilOptional}
          <input
            className="mt-1 block w-full"
            type="datetime-local"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
        </label>
      )}
      <label className="mb-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {LABELS.enabled}
      </label>
      <p className="mb-1">
        {LABELS.nextRun}:{" "}
        {next === null ? LABELS.noNextRun : new Date(next).toLocaleString()}
        {!enabled && LABELS.paused}
      </p>
      {typeof scheduleValidation === "string" && (
        <p role="alert" className="text-error-fg">
          {scheduleValidation}
        </p>
      )}
      <p className="text-description-fg">{LABELS.hostRunningNote}</p>
      {props.scheduleOnOtherHost && <p>{LABELS.otherHostNote}</p>}
      {props.scheduleLastMissedAt !== undefined && (
        <p className="text-description-fg">{LABELS.missedRunNote}</p>
      )}
      <footer className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onClose}>
          {LABELS.cancel}
        </button>
        {schedule && (
          <button
            type="button"
            onClick={() => {
              remove();
              onClose();
            }}
          >
            {LABELS.remove}
          </button>
        )}
        <button
          type="button"
          disabled={typeof scheduleValidation === "string"}
          onClick={() => {
            save();
            onClose();
          }}
        >
          {LABELS.save}
        </button>
      </footer>
    </section>,
    document.body
  );
}
