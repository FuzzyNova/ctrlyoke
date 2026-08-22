import { useEffect, useRef, useState } from "react";
import { Button } from "@components/shared/Button";
import { LocalTextInput } from "@components/shared/LocalInputs";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import {
  DEFAULT_STATUS_LINE_FORMAT,
  formatBrandedStatusLine,
  parseAnsiStatusLine,
  STATUS_LINE_COLOR_IDS,
  STATUS_LINE_COLOR_SWATCHES,
  STATUS_LINE_FIELD_IDS,
  STATUS_LINE_FIELD_REGISTRY,
  STATUS_LINE_FORMAT_PROVIDERS,
  type StatusLineColorId,
  type StatusLineFieldId,
  type StatusLineSegment,
  type StatusLineFormatProvider,
  type UsagePercentDirection,
} from "@root/utils/StatuslineFormat";
import type { HarnessUsageSnapshot } from "@root/types/UsageTypes";

const MAX_LITERAL_LENGTH = 64;
const STATUS_LINE_FIELD_LIST: readonly StatusLineFieldId[] = Object.values(
  STATUS_LINE_FIELD_IDS
);
const STATUS_LINE_COLOR_LIST = Object.keys(
  STATUS_LINE_COLOR_IDS
) as StatusLineColorId[];

interface Props {
  format: StatusLineSegment[];
  onCommit: (format: StatusLineSegment[]) => void;
  provider?: StatusLineFormatProvider;
  snapshot?: HarnessUsageSnapshot;
  percentDirection?: UsagePercentDirection;
}

function cloneDefaultFormat(): StatusLineSegment[] {
  return DEFAULT_STATUS_LINE_FORMAT.map(
    (segment): StatusLineSegment => ({ ...segment })
  );
}

function fieldLabel(field: StatusLineFieldId): string {
  return STATUS_LINE_FIELD_REGISTRY[field].label;
}

function colorLabel(color: StatusLineColorId): string {
  return color === "default"
    ? "Default"
    : `${color.slice(0, 1).toUpperCase()}${color.slice(1)}`;
}

/** Render a formatted statusline's ANSI color codes as colored spans instead of raw escape bytes. */
function renderStatusLinePreview(statusLine: string) {
  if (!statusLine) return "—";
  return parseAnsiStatusLine(statusLine).map((chunk, index) => (
    <span
      key={index}
      style={
        chunk.color
          ? { color: STATUS_LINE_COLOR_SWATCHES[chunk.color] }
          : undefined
      }
    >
      {chunk.text}
    </span>
  ));
}

function previewPayload(
  provider: StatusLineFormatProvider,
  snapshot: HarnessUsageSnapshot | undefined
): Record<string, unknown> {
  const representativePayload =
    provider === STATUS_LINE_FORMAT_PROVIDERS.CLAUDE
      ? {
          model: { id: "claude-sonnet-4.5" },
          context_window: {
            total_input_tokens: 68_000,
            total_output_tokens: 12_000,
            context_window_size: 200_000,
          },
          rate_limits: {
            five_hour: { used_percentage: 24 },
            seven_day: { used_percentage: 41 },
          },
          version: "preview",
          cwd: "/workspace/project",
          session_id: "preview-session",
        }
      : {
          model: { id: "gemini-2.5-pro" },
          context_window: {
            total_input_tokens: 68_000,
            total_output_tokens: 12_000,
            context_window_size: 200_000,
          },
          quota: {
            "3p-weekly": { remaining_fraction: 0.76 },
            "gemini-weekly": { remaining_fraction: 0.59 },
          },
          version: "preview",
          cwd: "/workspace/project",
          session_id: "preview-session",
        };

  if (!snapshot) {
    return representativePayload;
  }

  const windows = snapshot.quota.windows;
  if (provider === STATUS_LINE_FORMAT_PROVIDERS.CLAUDE) {
    return {
      ...representativePayload,
      model: { id: "cached model" },
      rate_limits: Object.fromEntries(
        windows
          .slice(0, 2)
          .map((window, index) => [
            index === 0 ? "five_hour" : "seven_day",
            { used_percentage: window.percentUsed ?? 0 },
          ])
      ),
    };
  }
  return {
    ...representativePayload,
    model: { id: "cached model" },
    quota: Object.fromEntries(
      windows.map((window) => [
        window.id,
        { remaining_fraction: 1 - (window.percentUsed ?? 0) / 100 },
      ])
    ),
  };
}

type SegmentRowProps = {
  id: string;
  index: number;
  segment: StatusLineSegment;
  onUpdateLiteral: (index: number, text: string) => void;
  onUpdateFieldLabel: (index: number, label: string) => void;
  onUpdateColor: (index: number, color: StatusLineColorId) => void;
  onRemove: (index: number) => void;
};

function SortableSegmentRow({
  id,
  index,
  segment,
  onUpdateLiteral,
  onUpdateFieldLabel,
  onUpdateColor,
  onRemove,
}: SegmentRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style = {
    // Restrict to vertical axis only — prevent horizontal drift during drag
    transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 rounded border border-input-border bg-input-bg px-2 py-1"
    >
      <span
        className="flex shrink-0 cursor-grab active:cursor-grabbing items-center justify-center text-description-fg hover:text-foreground"
        {...listeners}
        {...attributes}
        aria-label={`Drag to reorder segment ${index + 1}`}
      >
        <i className="codicon codicon-grabber text-xs" />
      </span>
      <span className="text-xs text-description-fg w-5 shrink-0 text-center">
        {index + 1}
      </span>
      {segment.type === "field" ? (
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm text-foreground">
          <span
            className="truncate"
            title={STATUS_LINE_FIELD_REGISTRY[segment.field].description}
          >
            {fieldLabel(segment.field)}
          </span>
          {STATUS_LINE_FIELD_REGISTRY[segment.field].labelSlot && (
            <LocalTextInput
              value={segment.label ?? ""}
              onCommit={(label) => onUpdateFieldLabel(index, label)}
              maxLength={MAX_LITERAL_LENGTH}
              aria-label={`Custom label for ${fieldLabel(segment.field)}`}
              placeholder="Default label"
              className="min-w-0 w-32 bg-input-bg border border-input-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-focus-border"
            />
          )}
        </div>
      ) : (
        <LocalTextInput
          value={segment.text.slice(0, MAX_LITERAL_LENGTH)}
          onCommit={(text) => onUpdateLiteral(index, text)}
          maxLength={MAX_LITERAL_LENGTH}
          aria-label={`Custom text segment ${index + 1}`}
          placeholder="Custom text"
          className="min-w-0 flex-1 bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border font-mono"
        />
      )}
      <div
        className="flex shrink-0 items-center gap-0.5"
        role="group"
        aria-label={`Color for segment ${index + 1}`}
      >
        {STATUS_LINE_COLOR_LIST.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onUpdateColor(index, color)}
            aria-label={`${colorLabel(color)} color for segment ${index + 1}`}
            aria-pressed={(segment.color ?? "default") === color}
            title={colorLabel(color)}
            className={`h-4 w-4 rounded-full border ${
              (segment.color ?? "default") === color
                ? "border-focus-border ring-1 ring-focus-border"
                : "border-input-border"
            }`}
            style={{ backgroundColor: STATUS_LINE_COLOR_SWATCHES[color] }}
          />
        ))}
      </div>
      <Button
        type="button"
        variant="danger"
        size="sm"
        onClick={() => onRemove(index)}
        aria-label={`Remove segment ${index + 1}`}
        title="Remove segment"
        className="shrink-0 px-1.5"
      >
        <i className="codicon codicon-trash" aria-hidden="true" />
      </Button>
    </div>
  );
}

export function StatusLineFormatEditor({
  format,
  onCommit,
  provider = STATUS_LINE_FORMAT_PROVIDERS.CLAUDE,
  snapshot,
  percentDirection = "used",
}: Props) {
  const [draftFormat, setDraftFormat] = useState(format);
  const idCounterRef = useRef(0);
  const nextId = () => `statusline-segment-${idCounterRef.current++}`;
  const [segmentIds, setSegmentIds] = useState<string[]>(() =>
    format.map(() => nextId())
  );

  useEffect(() => {
    setDraftFormat(format);
    setSegmentIds(format.map(() => nextId()));
  }, [format]);

  const commit = (nextFormat: StatusLineSegment[]) => {
    setDraftFormat(nextFormat);
    onCommit(nextFormat);
  };

  const excludeField = (index: number) => {
    commit(draftFormat.filter((_, segmentIndex) => segmentIndex !== index));
    setSegmentIds((prev) => prev.filter((_, segmentIndex) => segmentIndex !== index));
  };

  const includeField = (field: StatusLineFieldId) => {
    commit([...draftFormat, { type: "field", field }]);
    setSegmentIds((prev) => [...prev, nextId()]);
  };

  const updateLiteral = (index: number, text: string) => {
    const nextFormat = draftFormat.map((segment, segmentIndex) =>
      segmentIndex === index && segment.type === "literal"
        ? { ...segment, text: text.slice(0, MAX_LITERAL_LENGTH) }
        : segment
    );
    commit(nextFormat);
  };

  const updateSegmentColor = (index: number, color: StatusLineColorId) => {
    const nextFormat = draftFormat.map((segment, segmentIndex) =>
      segmentIndex === index
        ? {
            ...segment,
            ...(color === "default" ? { color: undefined } : { color }),
          }
        : segment
    );
    commit(nextFormat);
  };

  const updateFieldLabel = (index: number, label: string) => {
    const nextFormat = draftFormat.map((segment, segmentIndex) =>
      segmentIndex === index && segment.type === "field"
        ? { ...segment, label: label.slice(0, MAX_LITERAL_LENGTH) }
        : segment
    );
    commit(nextFormat);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = segmentIds.indexOf(String(active.id));
    const newIndex = segmentIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;

    setSegmentIds((prev) => arrayMove(prev, oldIndex, newIndex));
    commit(arrayMove(draftFormat, oldIndex, newIndex));
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const includedFields = new Set(
    draftFormat.flatMap((segment) =>
      segment.type === "field" ? [segment.field] : []
    )
  );

  return (
    <section
      className="rounded border border-panel-border bg-panel-bg p-2 space-y-2"
      aria-label="Status line format"
    >
      <div>
        <h4 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Status line format
        </h4>
        <p className="text-xs text-description-fg mt-1">
          Choose the fields to show and arrange them in terminal order.
        </p>
        <p className="text-xs text-description-fg mt-1">
          An explicit color overrides a field&apos;s automatic coloring,
          including the context warning/danger bands.
        </p>
      </div>

      <div className="rounded border border-input-border bg-input-bg px-2 py-1.5">
        <p className="text-xs text-description-fg">Live preview</p>
        <code className="mt-1 block break-all text-sm text-foreground">
          {renderStatusLinePreview(
            formatBrandedStatusLine(
              provider,
              previewPayload(provider, snapshot),
              draftFormat,
              percentDirection,
              { branch: "feature/statusline" }
            )
          )}
        </code>
        <p className="mt-1 text-xs text-description-fg">
          Uses your Stats &amp; Usage percent-direction setting (
          {percentDirection}).
          {snapshot
            ? " Showing the latest cached usage snapshot."
            : " Showing a representative fixture until usage is cached."}
        </p>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={segmentIds}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-1" aria-label="Status line format segments">
            {draftFormat.map((segment, index) => (
              <SortableSegmentRow
                key={segmentIds[index]}
                id={segmentIds[index]}
                index={index}
                segment={segment}
                onUpdateLiteral={updateLiteral}
                onUpdateFieldLabel={updateFieldLabel}
                onUpdateColor={updateSegmentColor}
                onRemove={excludeField}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            commit([...draftFormat, { type: "literal", text: "" }]);
            setSegmentIds((prev) => [...prev, nextId()]);
          }}
        >
          Add custom text
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            const next = cloneDefaultFormat();
            commit(next);
            setSegmentIds(next.map(() => nextId()));
          }}
        >
          Reset to default
        </Button>
      </div>

      {STATUS_LINE_FIELD_LIST.some((field) => !includedFields.has(field)) && (
        <div className="border-t border-panel-border pt-2">
          <p className="text-xs text-description-fg mb-1">Available fields</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {STATUS_LINE_FIELD_LIST.filter(
              (field) => !includedFields.has(field)
            ).map((field) => (
              <label
                key={field}
                className="flex items-center gap-1.5 text-xs text-foreground cursor-pointer"
                title={STATUS_LINE_FIELD_REGISTRY[field].description}
              >
                <input
                  type="checkbox"
                  checked={false}
                  onChange={() => includeField(field)}
                  aria-label={`Include ${fieldLabel(field)}`}
                  className="w-3.5 h-3.5 accent-focus-border cursor-pointer shrink-0"
                />
                <span>{fieldLabel(field)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
