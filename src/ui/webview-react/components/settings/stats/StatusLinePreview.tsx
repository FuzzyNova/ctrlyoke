import {
  CLAUDE_RATE_LIMIT_WINDOWS,
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
  let representativePayload: Record<string, unknown>;
  switch (provider) {
    case STATUS_LINE_FORMAT_PROVIDERS.CLAUDE:
      representativePayload = {
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
      };
      break;
    case STATUS_LINE_FORMAT_PROVIDERS.ANTIGRAVITY:
      representativePayload = {
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
      break;
    case STATUS_LINE_FORMAT_PROVIDERS.COPILOT:
      representativePayload = {
        cwd: "C:\\dev\\ctrlyoke",
        session_id: "fadbffd9-fb8e-4a6d-9048-2fcbbd09858b",
        session_name: "Implement Pong Response",
        transcript_path:
          "C:\\Users\\natha\\.copilot\\session-state\\<session_id>",
        model: { id: "gpt-5.6-luna", display_name: "gpt-5.6-luna · high" },
        workspace: { current_dir: "C:\\dev\\ctrlyoke" },
        username: null,
        remote: { connected: false },
        version: "1.0.80",
        cost: {
          total_api_duration_ms: 2070,
          total_lines_added: 0,
          total_lines_removed: 0,
          total_duration_ms: 12246,
          total_premium_requests: 0,
        },
        context_window: {
          total_input_tokens: 25953,
          total_output_tokens: 17,
          total_cache_read_tokens: 0,
          total_cache_write_tokens: 25950,
          total_reasoning_tokens: 10,
          total_tokens: 25970,
          context_window_size: 1050000,
          used_percentage: 0,
          remaining_percentage: 100,
          remaining_tokens: 1050000,
          last_call_input_tokens: 0,
          last_call_output_tokens: 0,
          current_context_tokens: 26159,
          displayed_context_limit: 328000,
          current_context_used_percentage: 8,
          current_usage: {
            input_tokens: 25953,
            output_tokens: 17,
            cache_creation_input_tokens: 25950,
            cache_read_input_tokens: 0,
          },
        },
        ai_used: { total_nano_aiu: 650850000, formatted: "0.65" },
        allow_all_enabled: false,
      };
      break;
    case STATUS_LINE_FORMAT_PROVIDERS.QWEN:
      representativePayload = {
        session_id: "43a8bb4c-f013-447e-9e23-c70e071fc16e",
        version: "0.21.15",
        model: { display_name: "[ModelStudio Standard] qwen3.5-plus" },
        context_window: {
          context_window_size: 1000000,
          used_percentage: 4.3,
          remaining_percentage: 95.7,
          current_usage: 42735,
          total_input_tokens: 77327,
          total_output_tokens: 691,
        },
        workspace: {
          current_dir: "C:\\dev\\ctrlyoke.worktrees\\small-feature",
        },
        git: { branch: "small-feature" },
        metrics: {
          models: {
            "qwen3.5-plus": {
              api: {
                total_requests: 4,
                total_errors: 0,
                total_latency_ms: 20189,
              },
              tokens: {
                prompt: 77327,
                completion: 691,
                total: 78018,
                cached: 16634,
                thoughts: 433,
              },
            },
          },
          files: { total_lines_added: 0, total_lines_removed: 0 },
        },
      };
      break;
  }

  if (!snapshot) {
    return representativePayload;
  }

  const windows = snapshot.quota.windows;
  if (provider === STATUS_LINE_FORMAT_PROVIDERS.CLAUDE) {
    return {
      ...representativePayload,
      model: { id: "cached model" },
      rate_limits: Object.fromEntries(
        windows.flatMap((window) => {
          const definition = CLAUDE_RATE_LIMIT_WINDOWS.find(
            (candidate) => candidate.id === window.id
          );
          return definition
            ? [[definition.key, { used_percentage: window.percentUsed ?? 0 }]]
            : [];
        })
      ),
    };
  }
  if (provider === STATUS_LINE_FORMAT_PROVIDERS.COPILOT) {
    return {
      ...representativePayload,
      model: { id: "cached model", display_name: "cached model" },
    };
  }
  if (provider === STATUS_LINE_FORMAT_PROVIDERS.QWEN) {
    return {
      ...representativePayload,
      model: { display_name: "cached model" },
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
    <div className="rounded-sm border border-input-border bg-input-bg px-2 py-1.5">
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
