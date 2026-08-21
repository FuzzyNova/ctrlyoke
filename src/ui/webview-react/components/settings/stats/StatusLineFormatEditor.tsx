import { useEffect, useState } from "react";
import { Button } from "@components/shared/Button";
import { LocalTextInput } from "@components/shared/LocalInputs";
import {
  DEFAULT_STATUS_LINE_FORMAT,
  STATUS_LINE_FIELD_IDS,
  STATUS_LINE_FIELD_REGISTRY,
  type StatusLineFieldId,
  type StatusLineSegment,
} from "@root/utils/StatuslineFormat";

const MAX_LITERAL_LENGTH = 64;
const STATUS_LINE_FIELD_LIST: readonly StatusLineFieldId[] = Object.values(
  STATUS_LINE_FIELD_IDS
);

interface Props {
  format: StatusLineSegment[];
  onCommit: (format: StatusLineSegment[]) => void;
}

function cloneDefaultFormat(): StatusLineSegment[] {
  return DEFAULT_STATUS_LINE_FORMAT.map(
    (segment): StatusLineSegment => ({ ...segment })
  );
}

function fieldLabel(field: StatusLineFieldId): string {
  return STATUS_LINE_FIELD_REGISTRY[field].label;
}

export function StatusLineFormatEditor({ format, onCommit }: Props) {
  const [draftFormat, setDraftFormat] = useState(format);

  useEffect(() => {
    setDraftFormat(format);
  }, [format]);

  const commit = (nextFormat: StatusLineSegment[]) => {
    setDraftFormat(nextFormat);
    onCommit(nextFormat);
  };

  const moveSegment = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= draftFormat.length) {
      return;
    }

    const nextFormat = [...draftFormat];
    [nextFormat[index], nextFormat[nextIndex]] = [
      nextFormat[nextIndex],
      nextFormat[index],
    ];
    commit(nextFormat);
  };

  const excludeField = (index: number) => {
    commit(draftFormat.filter((_, segmentIndex) => segmentIndex !== index));
  };

  const includeField = (field: StatusLineFieldId) => {
    commit([...draftFormat, { type: "field", field }]);
  };

  const updateLiteral = (index: number, text: string) => {
    const nextFormat = draftFormat.map((segment, segmentIndex) =>
      segmentIndex === index && segment.type === "literal"
        ? { ...segment, text: text.slice(0, MAX_LITERAL_LENGTH) }
        : segment
    );
    commit(nextFormat);
  };

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
      </div>

      <div className="space-y-1" aria-label="Status line format segments">
        {draftFormat.map((segment, index) => (
          <div
            key={`statusline-segment-${index}`}
            className="flex items-center gap-2 rounded border border-input-border bg-input-bg px-2 py-1"
          >
            <span className="text-xs text-description-fg w-5 shrink-0 text-center">
              {index + 1}
            </span>
            {segment.type === "field" ? (
              <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked
                  onChange={() => excludeField(index)}
                  aria-label={`Include ${fieldLabel(segment.field)}`}
                  className="w-3.5 h-3.5 accent-focus-border cursor-pointer shrink-0"
                />
                <span className="truncate">{fieldLabel(segment.field)}</span>
              </label>
            ) : (
              <LocalTextInput
                value={segment.text.slice(0, MAX_LITERAL_LENGTH)}
                onCommit={(text) => updateLiteral(index, text)}
                maxLength={MAX_LITERAL_LENGTH}
                aria-label={`Custom text segment ${index + 1}`}
                placeholder="Custom text"
                className="min-w-0 flex-1 bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border font-mono"
              />
            )}
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => moveSegment(index, -1)}
                disabled={index === 0}
                aria-label={`Move segment ${index + 1} up`}
                title="Move up"
                className="px-1.5"
              >
                Up
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => moveSegment(index, 1)}
                disabled={index === draftFormat.length - 1}
                aria-label={`Move segment ${index + 1} down`}
                title="Move down"
                className="px-1.5"
              >
                Down
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() =>
            commit([...draftFormat, { type: "literal", text: "" }])
          }
        >
          Add custom text
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => commit(cloneDefaultFormat())}
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
