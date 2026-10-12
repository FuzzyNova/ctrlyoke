import type { FontSizeLimits } from "@root/types/CtrlYokeSettings";
import { clamp } from "@utils/number";
import { Icon } from "../shared/Icon";

interface Props {
  value: number;
  limits: FontSizeLimits;
  onChange: (value: number) => void;
  /** Names the size in the buttons' accessible names, e.g. "terminal font size". */
  subject: string;
}

/** − / value / + control for a pixel font-size setting. */
export function FontSizeStepper({ value, limits, onChange, subject }: Props) {
  const setSize = (next: number) =>
    onChange(clamp(next, limits.min, limits.max));

  return (
    <div className="flex items-center">
      <button
        className="icon-btn py-0 px-1"
        title={`Decrease ${subject}`}
        aria-label={`Decrease ${subject}`}
        onClick={() => setSize(value - 1)}
        disabled={value <= limits.min}
        type="button"
      >
        <Icon name="remove" className="codicon-sm" />
      </button>
      <span className="text-xs text-description-fg tabular-nums w-[28px] text-center select-none">
        {value}
      </span>
      <button
        className="icon-btn py-0 px-1"
        title={`Increase ${subject}`}
        aria-label={`Increase ${subject}`}
        onClick={() => setSize(value + 1)}
        disabled={value >= limits.max}
        type="button"
      >
        <Icon name="add" className="codicon-sm" />
      </button>
    </div>
  );
}
