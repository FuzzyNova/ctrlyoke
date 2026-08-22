import {
  formatBrandedStatusLine,
  parseAnsiStatusLine,
  STATUS_LINE_COLOR_SWATCHES,
  STATUS_LINE_FORMAT_PROVIDERS,
  type StatusLineFormatProvider,
  type StatusLineSegment,
  type UsagePercentDirection,
} from "@root/utils/StatuslineFormat";
import type { HarnessUsageSnapshot } from "@root/types/UsageTypes";

interface Props {
  format: StatusLineSegment[];
  provider?: StatusLineFormatProvider;
  snapshot?: HarnessUsageSnapshot;
  percentDirection?: UsagePercentDirection;
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

export function StatusLinePreview({
  format,
  provider = STATUS_LINE_FORMAT_PROVIDERS.CLAUDE,
  snapshot,
  percentDirection = "used",
}: Props) {
  return (
    <div className="rounded border border-input-border bg-input-bg px-2 py-1.5">
      <p className="text-xs text-description-fg">Live preview</p>
      <code className="mt-1 block break-all text-sm text-foreground">
        {renderStatusLinePreview(
          formatBrandedStatusLine(
            provider,
            previewPayload(provider, snapshot),
            format,
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
  );
}
