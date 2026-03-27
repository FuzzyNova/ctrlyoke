import React from "react";
import { HARNESS_IDS, type HarnessId } from "../../types/messages";

// Raw SVG imports — inlined at build time, no CSP issues
import claudeRaw from "@icons/harnesses/claude.svg?raw";
import copilotChatRaw from "@icons/harnesses/copilot-chat.svg?raw";
import copilotRaw from "@icons/harnesses/copilot-cli.svg?raw";
import geminiRaw from "@icons/harnesses/gemini.svg?raw";
import openaiRaw from "@icons/harnesses/codex.svg?raw";
import opencodeRaw from "@icons/harnesses/opencode.svg?raw";
import qwenRaw from "@icons/harnesses/qwen.svg?raw";

// Icons designed for dark backgrounds (white fills).
// The CSS class "harness-icon-adaptive" applies filter:invert(1) on light VS Code themes.
const ADAPTIVE_HARNESSES = new Set<HarnessId>([
  HARNESS_IDS.COPILOT_CHAT,
  HARNESS_IDS.CODEX_CLI,
  HARNESS_IDS.OPENCODE_CLI,
]);

const SVG_MAP: Record<HarnessId, string> = {
  [HARNESS_IDS.CLAUDE_CLI]: claudeRaw,
  [HARNESS_IDS.COPILOT_CHAT]: copilotChatRaw,
  [HARNESS_IDS.COPILOT_CLI]: copilotRaw,
  [HARNESS_IDS.GEMINI_CLI]: geminiRaw,
  [HARNESS_IDS.CODEX_CLI]: openaiRaw,
  [HARNESS_IDS.OPENCODE_CLI]: opencodeRaw,
  [HARNESS_IDS.QWEN_CLI]: qwenRaw,
};

// Pre-compute base64 data URIs once at module load.
// Using <img src="data:..."> gives each SVG an isolated rendering context,
// which is required for SVGs that use <mask> or <filter> elements — those
// fail to render correctly when inserted inline via dangerouslySetInnerHTML.
const toDataUri = (svg: string) =>
  `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;

const DATA_URI_MAP = Object.fromEntries(
  (Object.entries(SVG_MAP) as [HarnessId, string][]).map(([id, svg]) => [
    id,
    toDataUri(svg),
  ])
) as Record<HarnessId, string>;

interface HarnessIconProps {
  harnessId: HarnessId;
  /** Size in px. Default: 16 */
  size?: number;
  /** Dim the icon with reduced opacity (e.g. when using workflow/global default) */
  dimmed?: boolean;
  className?: string;
}

export const HarnessIcon: React.FC<HarnessIconProps> = ({
  harnessId,
  size = 16,
  dimmed = false,
  className = "",
}) => {
  const src = DATA_URI_MAP[harnessId];
  if (!src) return null;

  return (
    <img
      src={src}
      alt=""
      className={`inline-block flex-shrink-0 transition-opacity ${
        ADAPTIVE_HARNESSES.has(harnessId) ? "harness-icon-adaptive" : ""
      } ${dimmed ? "opacity-40" : "opacity-100"} ${className}`}
      style={{ width: size, height: size }}
    />
  );
};
