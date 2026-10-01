import * as crypto from "crypto";
import { normalizeCodexHookMatcher } from "../shared/CodexHookUtils";
import { Log } from "../../../utils/Log";
import { quoteTomlBasicString } from "../shared/InlineToml";
import {
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_HANDLER_TYPES,
} from "./CodexProtocolConstants";

export type CodexHooksSection = Record<string, unknown[]>;

export type CodexHookStateEntry = {
  enabled?: boolean;
  trusted_hash?: string;
};

/**
 * The defensive portion of CreateProcess's command-line budget reserved for
 * inline hooks. The remaining Windows command-line space is shared with MCP
 * overrides, --add-dir entries, and the prompt itself.
 */
export const CODEX_INLINE_HOOK_COMMAND_LINE_BUDGET = 16_000;

/**
 * Return the synthetic config.toml source Codex assigns to session -c
 * overrides. The POSIX spelling is derived from Codex's `synthetic_layer_path`
 * source, but has not yet been confirmed on a Mac or Linux box. The trust-key
 * count assertion below makes an incorrect POSIX source observable.
 */
export function getCodexInlineHookSourcePath(
  platform: NodeJS.Platform = process.platform
): string {
  return platform === "win32"
    ? String.raw`C:\<session-flags>\config.toml`
    : "/<session-flags>/config.toml";
}

/** The synthetic config.toml source for the current platform. */
export const CODEX_INLINE_HOOK_SOURCE_PATH = getCodexInlineHookSourcePath();

export type CodexInlineHooksArgs = {
  hookArgs: string[];
  trustArgs: string[];
};

export type CodexInlineHooksBuildOptions = {
  /** Injectable for platform-specific tests; production defaults to the host. */
  platform?: NodeJS.Platform;
  /** Injectable for deterministic budget tests; production uses the guard above. */
  maxCommandLineLength?: number;
};

/**
 * Render ctrlyoke-owned hooks as Codex session config overrides and trust them
 * using the indices in the inline hook source's own array space.
 */
export function buildCodexInlineHooks(
  hooks: CodexHooksSection,
  options: CodexInlineHooksBuildOptions = {}
): CodexInlineHooksArgs {
  const trustState: Record<string, CodexHookStateEntry> = {};
  const hookArgs: string[] = [];
  let emittedHandlerCount = 0;
  const keySource = getCodexInlineHookSourcePath(options.platform);

  for (const event of Object.keys(hooks).sort(compareByteOrder)) {
    const groups = hooks[event];
    hookArgs.push("-c", `hooks.${event}=${toInlineTomlValue(groups)}`);

    groups.forEach((group, groupIndex) => {
      const matcher = normalizeCodexHookMatcher(
        event,
        getHookGroupMatcher(group)
      );
      getHookHandlers(group).forEach((handler, handlerIndex) => {
        emittedHandlerCount++;
        const commandHook = parseCodexCommandHook(handler);
        if (!commandHook) {
          return;
        }

        trustState[
          buildCodexHookKey(keySource, event, groupIndex, handlerIndex)
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

  const trustKeyCount = Object.keys(trustState).length;
  if (trustKeyCount !== emittedHandlerCount) {
    const message =
      `Codex inline hook trust state mismatch: emitted ${emittedHandlerCount} ` +
      `handlers but computed ${trustKeyCount} trust keys. ` +
      "Check the emitted hook shape and Codex event mapping before spawning.";
    Log.error(message);
    throw new Error(message);
  }

  const result = {
    hookArgs,
    trustArgs: serializeCodexInlineTrustOverride(trustState),
  };

  Log.trace(
    `[CodexInlineHooksBuilder] Codex inline hook trust keys (${trustKeyCount}): ${JSON.stringify(Object.keys(trustState))}`
  );

  const commandLineLength = Buffer.byteLength(
    [...result.hookArgs, ...result.trustArgs].join(" "),
    "utf8"
  );
  const maxCommandLineLength =
    options.maxCommandLineLength ?? CODEX_INLINE_HOOK_COMMAND_LINE_BUDGET;
  if (commandLineLength > maxCommandLineLength) {
    const message =
      `Codex inline hook arguments require ${commandLineLength} bytes, exceeding ` +
      `the ${maxCommandLineLength}-byte safety budget. Reduce the number or ` +
      "length of Codex hooks before retrying.";
    Log.error(message);
    throw new Error(message);
  }

  return result;
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
    return quoteTomlBasicString(value);
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

  // Byte order, not localeCompare: TOML key order does not change the parsed
  // value, but locale-dependent emission would make the rendered args differ
  // between machines and defeat argument-level test fixtures.
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareByteOrder(left, right))
    .map(
      ([key, entryValue]) =>
        `${quoteTomlBasicString(key)} = ${toInlineTomlValue(entryValue)}`
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
    case CODEX_HOOK_EVENTS.PRE_TOOL_USE:
      return "pre_tool_use";
    case CODEX_HOOK_EVENTS.PERMISSION_REQUEST:
      return "permission_request";
    case CODEX_HOOK_EVENTS.POST_TOOL_USE:
      return "post_tool_use";
    case CODEX_HOOK_EVENTS.PRE_COMPACT:
      return "pre_compact";
    case CODEX_HOOK_EVENTS.POST_COMPACT:
      return "post_compact";
    case CODEX_HOOK_EVENTS.SESSION_START:
      return "session_start";
    case CODEX_HOOK_EVENTS.USER_PROMPT_SUBMIT:
      return "user_prompt_submit";
    case CODEX_HOOK_EVENTS.STOP:
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
  if (
    parsed.type !== CODEX_HOOK_HANDLER_TYPES.COMMAND ||
    typeof parsed.command !== "string"
  ) {
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
