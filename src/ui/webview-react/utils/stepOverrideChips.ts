import { resolveExecutionProperties } from "@root/types/ExecutionPropertyResolver";
import type { ResolvedProperties } from "@root/types/ExecutionPropertyTypes";
import {
  EXECUTION_MODES,
  MCP_SERVER_IDS,
  MCP_SKILL_NAMES,
  SESSION_ID_SENTINELS,
} from "@root/types/DashboardConstants";
import { PERMISSION_MODE_OPTIONS_META } from "@root/types/SchemaUiMetadata";
import type { PromptStep as CorePromptStep } from "@root/types/CtrlYokeTypes";
import type { PromptStep } from "@root/types/WebviewMessageTypes";
import type { GlobalSettings, WorkflowProperties } from "@store/settingsStore";
import type { WorkflowStep } from "@store/workflowStore";
import type { PromptOverride } from "../components/prompts/PromptStepDetails";
import { priorContextBadge } from "../components/shared/tabBadgeUtils";
import {
  createDefaults,
  toCorePromptStep,
  toCoreWorkflow,
} from "@utils/coreWorkflowAdapter";
import { schemaTitle } from "@utils/schemaPropertyLabels";
import { isScriptWorkflowStep } from "@utils/stepClipboard";

/** Visible length of a session ID in chips and banners. */
const SESSION_ID_PREVIEW_LENGTH = 8;

const MCP_SKILL_NAME_SET = new Set<string>(Object.values(MCP_SKILL_NAMES));

/** Shorten a session ID for display; the full ID belongs in a `title`. */
export function formatSessionIdPreview(sessionId: string): string {
  return sessionId.length > SESSION_ID_PREVIEW_LENGTH
    ? `${sessionId.slice(0, SESSION_ID_PREVIEW_LENGTH)}…`
    : sessionId;
}

/**
 * True when `sessionId` names one concrete harness session, not a step
 * number or the final-step sentinel that is re-resolved at run time.
 */
export function isConcreteSessionId(
  sessionId: string | number | undefined
): sessionId is string {
  return (
    typeof sessionId === "string" &&
    sessionId.trim() !== "" &&
    sessionId !== SESSION_ID_SENTINELS.FINAL_STEP &&
    !/^\d+$/.test(sessionId.trim())
  );
}

/** Key-order-independent serialization, with every "none" form collapsed. */
function comparableKey(value: unknown): string {
  let normalized = value;
  if (
    normalized === undefined ||
    normalized === "" ||
    (Array.isArray(normalized) && normalized.length === 0)
  ) {
    normalized = null;
  }
  return JSON.stringify(normalized, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b)
          )
        )
      : entry
  );
}

function basename(path: string): string {
  return path.replace(/.*[\\/]/, "");
}

function shorten(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.substring(0, maxLength)}…` : text;
}

function executionModeChip(
  mode: NonNullable<WorkflowStep["executionMode"]>
): PromptOverride {
  const interactive = mode === EXECUTION_MODES.INTERACTIVE;
  return {
    label: interactive ? "Interactive" : "Headless",
    title: `executionMode: ${mode}`,
    icon: interactive ? "debug-console" : "terminal",
  };
}

function mcpServersChip(
  mcpServers: NonNullable<PromptStep["mcpServers"]> | null
): PromptOverride {
  if (mcpServers === null) {
    return { label: "MCP: none", title: "MCP servers explicitly disabled" };
  }
  const count = mcpServers.length;
  if (count === 0) {
    return { label: "MCP: 0", title: "MCP servers explicitly set to empty" };
  }
  const serverIds = mcpServers.map((server) =>
    typeof server === "string" ? server : (server.id ?? "custom")
  );
  const hasCtrlYoke = serverIds.includes(MCP_SERVER_IDS.CTRLYOKE);
  if (hasCtrlYoke && count === 1) {
    return { label: "MCP[ctrlyoke]", title: "MCP: ctrlyoke" };
  }
  return {
    label: hasCtrlYoke ? `MCP[ctrlyoke]+${count - 1}` : `MCP: ${count}`,
    title: serverIds.join(", "),
  };
}

function conditionChip(
  prefix: "ec" | "pc",
  field: "endCondition" | "preCondition",
  condition: PromptStep["endCondition"] | PromptStep["preCondition"]
): PromptOverride | undefined {
  if (condition === null) return { label: `${prefix}: disabled` };
  if (!condition?.script) return undefined;
  return {
    label: `${prefix}: ${shorten(basename(condition.script), 30)}`,
    title: `${field}: ${condition.script}`,
  };
}

interface ChipFieldConfig {
  /** The chip for the step's explicit value, or undefined when it renders none. */
  chip: (step: PromptStep) => PromptOverride | undefined;
  /** Adjusts a resolved value before comparing authored against inherited. */
  normalize?: (value: unknown) => unknown;
  /** The `↩ <id>` chip replaces this chip when a concrete session is pinned. */
  replacedBySessionChip?: boolean;
}

/**
 * Step-level fields that render an override chip, in display order. Harness
 * and model are shown in the step's harness/model row instead.
 */
const CHIP_FIELDS = {
  executionMode: {
    chip: (step) => step.executionMode && executionModeChip(step.executionMode),
  },
  agent: {
    chip: (step) =>
      step.agent === null
        ? { label: "agent: none", title: "agent explicitly disabled" }
        : step.agent
          ? {
              label: `agent: ${basename(step.agent)}`,
              title: `agent: ${step.agent}`,
            }
          : undefined,
  },
  skills: {
    chip: (step) =>
      step.skills === null
        ? { label: "skills: none", title: "skills explicitly disabled" }
        : step.skills && step.skills.length > 0
          ? {
              label: `skills: ${step.skills.length}`,
              title: step.skills.join(", "),
            }
          : undefined,
    // Built-in ctrlyoke MCP skills are injected from `mcpServers`, which has
    // its own chip; they never make the skill list itself differ.
    normalize: (value) =>
      Array.isArray(value)
        ? value.filter((skill: string) => !MCP_SKILL_NAME_SET.has(skill))
        : value,
  },
  mcpServers: {
    chip: (step) =>
      step.mcpServers === undefined
        ? undefined
        : mcpServersChip(step.mcpServers),
  },
  hooks: {
    chip: (step) =>
      step.hooks === null
        ? { label: "hooks: none" }
        : step.hooks && step.hooks.length > 0
          ? { label: `hooks: ${step.hooks.length}` }
          : undefined,
  },
  resumeSession: {
    chip: (step) =>
      step.resumeSession === undefined
        ? undefined
        : { label: step.resumeSession ? "resume" : "no resume" },
    replacedBySessionChip: true,
  },
  priorContext: {
    chip: (step) =>
      step.priorContext === undefined
        ? undefined
        : priorContextBadge(step.priorContext),
  },
  endCondition: {
    chip: (step) => conditionChip("ec", "endCondition", step.endCondition),
  },
  preCondition: {
    chip: (step) => conditionChip("pc", "preCondition", step.preCondition),
  },
  additionalArgs: {
    chip: (step) =>
      step.additionalArgs === null
        ? { label: "args: none", title: "additionalArgs explicitly disabled" }
        : step.additionalArgs !== undefined
          ? {
              label: `args: ${shorten(step.additionalArgs, 20)}`,
              title: `additionalArgs: ${step.additionalArgs}`,
            }
          : undefined,
  },
  toolPermissions: {
    chip: (step) => {
      if (step.toolPermissions === null) {
        return {
          label: "perms: none",
          title: schemaTitle("toolPermissions", null),
        };
      }
      if (!step.toolPermissions?.mode) return undefined;
      return {
        label: `perms: ${PERMISSION_MODE_OPTIONS_META[step.toolPermissions.mode]?.short ?? step.toolPermissions.mode}`,
        title: schemaTitle("toolPermissions.mode", step.toolPermissions.mode),
      };
    },
  },
} satisfies Partial<
  Record<keyof PromptStep & keyof ResolvedProperties, ChipFieldConfig>
>;

type ChipField = keyof typeof CHIP_FIELDS;

const CHIP_FIELD_NAMES = Object.keys(CHIP_FIELDS) as ChipField[];

/**
 * Fields reset to inherit when computing the inherited baseline. `sessionId`
 * has no chip of its own but must inherit along with `resumeSession`.
 */
const INHERITED_FIELD_NAMES: readonly (keyof CorePromptStep)[] = [
  ...CHIP_FIELD_NAMES,
  "sessionId",
];

/**
 * Build the override chips shown on a step row.
 *
 * A chip appears only when the step's explicit value changes what actually
 * runs: the step is resolved once as authored and once with every chip field
 * inherited, and a field whose two resolved values match gets no chip. That
 * keeps a reply (which pins every property) from rendering a wall of chips
 * that all restate the inherited values. Because the comparison uses the
 * current workflow and global settings, a pinned value's chip reappears as
 * soon as those settings move away from it.
 *
 * A step that resumes one concrete session gets a single `↩ <id>` chip in
 * place of `resume`; its tooltip lists the pinned values whose chips were
 * hidden because they currently match the inherited ones.
 */
export function buildStepOverrideChips(
  step: WorkflowStep,
  workflowProperties: WorkflowProperties,
  globalSettings: GlobalSettings
): PromptOverride[] {
  if (isScriptWorkflowStep(step)) {
    return step.executionMode ? [executionModeChip(step.executionMode)] : [];
  }

  const workflow = toCoreWorkflow([], null, workflowProperties);
  const context = {
    defaults: createDefaults(globalSettings),
    hostCanProvidePty: true,
  };
  const authoredStep = toCorePromptStep(step);
  const inheritedStep = { ...authoredStep };
  for (const field of INHERITED_FIELD_NAMES) delete inheritedStep[field];
  const authored = resolveExecutionProperties(
    authoredStep,
    workflow,
    context
  ).properties;
  const inherited = resolveExecutionProperties(
    inheritedStep,
    workflow,
    context
  ).properties;

  const sessionId =
    step.resumeSession === true && isConcreteSessionId(step.sessionId)
      ? step.sessionId
      : undefined;

  const chips: PromptOverride[] = [];
  const pinned: string[] = [];
  for (const field of CHIP_FIELD_NAMES) {
    const config: ChipFieldConfig = CHIP_FIELDS[field];
    if (sessionId && config.replacedBySessionChip) continue;
    const chip = config.chip(step);
    if (!chip) continue;
    const normalize = config.normalize ?? ((value: unknown) => value);
    if (
      comparableKey(normalize(authored[field])) ===
      comparableKey(normalize(inherited[field]))
    ) {
      pinned.push(chip.label);
    } else {
      chips.push(chip);
    }
  }

  if (sessionId) {
    const titleLines = [`Resumes session ${sessionId}`];
    if (pinned.length > 0) {
      titleLines.push(`Pinned, same as inherited: ${pinned.join(", ")}`);
    }
    chips.unshift({
      label: formatSessionIdPreview(sessionId),
      title: titleLines.join("\n"),
      icon: "reply",
    });
  }
  return chips;
}
