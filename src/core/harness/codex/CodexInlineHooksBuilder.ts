import * as crypto from "crypto";
import { normalizeCodexHookMatcher } from "../shared/CodexHookUtils";

export type CodexHooksSection = Record<string, unknown[]>;

export type CodexHookStateEntry = {
  enabled?: boolean;
  trusted_hash?: string;
};

/** The synthetic config.toml source Codex assigns to session -c overrides. */
export const CODEX_INLINE_HOOK_SOURCE_PATH =
  process.platform === "win32"
    ? String.raw`C:\<session-flags>\config.toml`
    : "/<session-flags>/config.toml";

export type CodexInlineHooksArgs = {
  hookArgs: string[];
  trustArgs: string[];
};

/**
 * Render ctrlyoke-owned hooks as Codex session config overrides and trust them
 * using the indices in the inline hook source's own array space.
 */
export function buildCodexInlineHooks(
  hooks: CodexHooksSection
): CodexInlineHooksArgs {
  const trustState: Record<string, CodexHookStateEntry> = {};
  const hookArgs: string[] = [];

  for (const event of Object.keys(hooks).sort(compareByteOrder)) {
    const groups = hooks[event];
    hookArgs.push("-c", `hooks.${event}=${toInlineTomlValue(groups)}`);

    groups.forEach((group, groupIndex) => {
      const matcher = normalizeCodexHookMatcher(
        event,
        getHookGroupMatcher(group)
      );
      getHookHandlers(group).forEach((handler, handlerIndex) => {
        const commandHook = parseCodexCommandHook(handler);
        if (!commandHook) {
          return;
        }

        trustState[
          buildCodexHookKey(
            CODEX_INLINE_HOOK_SOURCE_PATH,
            event,
            groupIndex,
            handlerIndex
          )
        ] = {
          trusted_hash: computeCodexTrustedHash(
            event,
            matcher,
            commandHook.command,
            commandHook.timeout,
            commandHook.statusMessage
          ),
        };
      });
    });
  }

  return {
    hookArgs,
    trustArgs: serializeCodexInlineTrustOverride(trustState),
  };
}

export function computeCodexTrustedHash(
  event: string,
  matcher: string | undefined,
  command: string,
  timeout: number,
  statusMessage?: string
): string {
  const identity: Record<string, unknown> = {
    event_name: getCodexEventKeyLabel(event),
    hooks: [
      {
        async: false,
        command,
        timeout,
        type: "command",
        ...(statusMessage !== undefined ? { statusMessage } : {}),
      },
    ],
    ...(matcher !== undefined ? { matcher } : {}),
  };

  const serialized = JSON.stringify(canonicalizeJson(identity));
  const hex = crypto
    .createHash("sha256")
    .update(serialized, "utf8")
    .digest("hex");
  return `sha256:${hex}`;
}

/** Canonicalize JSON using the byte ordering used by Codex's Rust serializer. */
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort(compareByteOrder)
    .reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = canonicalizeJson(record[key]);
      return sorted;
    }, {});
}

export function toInlineTomlValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "0";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => toInlineTomlValue(item)).join(", ")}]`;
  }

  if (!value || typeof value !== "object") {
    return "{}";
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)} = ${toInlineTomlValue(entryValue)}`
    )
    .join(", ");
  return `{ ${entries} }`;
}

export function buildCodexHookKey(
  keySource: string,
  event: string,
  groupIndex: number,
  handlerIndex: number
): string {
  return `${keySource}:${getCodexEventKeyLabel(event)}:${groupIndex}:${handlerIndex}`;
}

export function getCodexEventKeyLabel(event: string): string {
  switch (event) {
    case "PreToolUse":
      return "pre_tool_use";
    case "PermissionRequest":
      return "permission_request";
    case "PostToolUse":
      return "post_tool_use";
    case "PreCompact":
      return "pre_compact";
    case "PostCompact":
      return "post_compact";
    case "SessionStart":
      return "session_start";
    case "UserPromptSubmit":
      return "user_prompt_submit";
    case "Stop":
      return "stop";
    default:
      return event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  }
}

export function serializeCodexInlineTrustOverride(
  state: Record<string, CodexHookStateEntry>
): string[] {
  if (Object.keys(state).length === 0) {
    return [];
  }

  return ["-c", `hooks.state=${toInlineTomlValue(state)}`];
}

function compareByteOrder(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function getHookGroupMatcher(group: unknown): string | undefined {
  if (!group || Array.isArray(group) || typeof group !== "object") {
    return undefined;
  }

  const matcher = (group as Record<string, unknown>).matcher;
  return typeof matcher === "string" ? matcher : undefined;
}

function getHookHandlers(group: unknown): unknown[] {
  if (!group || Array.isArray(group) || typeof group !== "object") {
    return [];
  }

  const handlers = (group as Record<string, unknown>).hooks;
  return Array.isArray(handlers) ? handlers : [];
}

function parseCodexCommandHook(
  handler: unknown
): { command: string; timeout: number; statusMessage?: string } | null {
  if (!handler || Array.isArray(handler) || typeof handler !== "object") {
    return null;
  }

  const parsed = handler as Record<string, unknown>;
  if (parsed.type !== "command" || typeof parsed.command !== "string") {
    return null;
  }

  const timeoutSource =
    typeof parsed.timeout === "number"
      ? parsed.timeout
      : typeof parsed.timeoutSec === "number"
        ? parsed.timeoutSec
        : undefined;
  const timeout =
    timeoutSource === undefined ? 600 : Math.max(1, Math.trunc(timeoutSource));

  const statusMessage =
    typeof parsed.statusMessage === "string"
      ? parsed.statusMessage
      : typeof parsed.status_message === "string"
        ? parsed.status_message
        : undefined;

  return {
    command: parsed.command,
    timeout,
    statusMessage,
  };
}
