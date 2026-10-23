import type {
  ProviderModelUsage,
  ToolCall,
  UniversalCliOutput,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  TOKEN_TOTAL_CONFIDENCE,
} from "../../../types/DashboardConstants";
import { SUBAGENT_SPAWN_UPDATE_TOOL_NAME } from "./SubagentSourceFollower";
import type { SubagentDrainResult } from "./SubagentSourceFollower";

/** Merge child events and per-model usage into the parser's final output. */
export function mergeSubagentOutput(
  output: UniversalCliOutput,
  drain: SubagentDrainResult
): UniversalCliOutput {
  const mergedEvents = [...output.events];
  const appendedEvents = drain.events.filter((event) => {
    if (event.type !== CLI_EVENT_TYPES.TOOL_CALL) return true;
    const update = event.data as ToolCall;
    if (
      update.name !== SUBAGENT_SPAWN_UPDATE_TOOL_NAME ||
      !update.id ||
      !update.subagentSpawn
    ) {
      return true;
    }
    const spawnIndex = mergedEvents.findIndex((candidate) => {
      if (candidate.type !== CLI_EVENT_TYPES.TOOL_CALL) return false;
      const spawn = candidate.data as ToolCall;
      return spawn.id === update.id && spawn.subagentSpawn !== undefined;
    });
    if (spawnIndex < 0) return true;
    const spawnEvent = mergedEvents[spawnIndex];
    if (spawnEvent.type !== CLI_EVENT_TYPES.TOOL_CALL) return true;
    const spawn = spawnEvent.data as ToolCall;
    mergedEvents[spawnIndex] = {
      ...spawnEvent,
      data: {
        ...spawn,
        subagentSpawn: {
          ...spawn.subagentSpawn,
          ...update.subagentSpawn,
        },
      },
    };
    return false;
  });
  const events = [...mergedEvents, ...appendedEvents].sort(
    (left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0)
  );
  const modelUsage: Record<string, ProviderModelUsage> = {
    ...(output.metadata.modelUsage ?? output.metadata.usage?.modelUsage ?? {}),
  };
  const priorUsage = output.metadata.usage;
  const hasUsage = Object.keys(drain.usageByModel).length > 0;
  let modelUsageIsComplete = true;
  if (hasUsage && Object.keys(modelUsage).length === 0) {
    if (output.metadata.model) {
      modelUsage[output.metadata.model] = {
        inputTokens: priorUsage?.inputTokens,
        outputTokens: priorUsage?.outputTokens,
        cacheReadInputTokens: priorUsage?.cachedInputTokens,
        cacheCreationInputTokens: priorUsage?.cacheCreatedTokens,
        cacheCreationLongTtlInputTokens: priorUsage?.cacheCreatedLongTtlTokens,
        reasoningOutputTokens: priorUsage?.reasoningOutputTokens,
      };
    } else {
      modelUsageIsComplete = false;
    }
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreatedTokens = 0;
  let cacheCreatedLongTtlTokens = 0;
  let reasoningOutputTokens = 0;
  for (const [modelName, usage] of Object.entries(drain.usageByModel)) {
    const total = (modelUsage[modelName] ??= {});
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cacheReadInputTokens",
      "cacheCreationInputTokens",
      "cacheCreationLongTtlInputTokens",
      "reasoningOutputTokens",
    ] as const) {
      const value = usage[field] ?? 0;
      total[field] = (total[field] ?? 0) + value;
    }
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    cachedInputTokens += usage.cacheReadInputTokens ?? 0;
    cacheCreatedTokens += usage.cacheCreationInputTokens ?? 0;
    cacheCreatedLongTtlTokens += usage.cacheCreationLongTtlInputTokens ?? 0;
    reasoningOutputTokens += usage.reasoningOutputTokens ?? 0;
  }
  const completeModelUsage = modelUsageIsComplete ? modelUsage : undefined;
  return {
    ...output,
    events,
    metadata: {
      ...output.metadata,
      ...(completeModelUsage && Object.keys(completeModelUsage).length
        ? { modelUsage: completeModelUsage }
        : {}),
      ...(hasUsage || drain.partial
        ? {
            usage: {
              ...priorUsage,
              inputTokens: (priorUsage?.inputTokens ?? 0) + inputTokens,
              outputTokens: (priorUsage?.outputTokens ?? 0) + outputTokens,
              totalTokens:
                (priorUsage?.totalTokens ??
                  (priorUsage?.inputTokens ?? 0) +
                    (priorUsage?.outputTokens ?? 0)) +
                inputTokens +
                outputTokens,
              cachedInputTokens:
                (priorUsage?.cachedInputTokens ?? 0) + cachedInputTokens,
              cacheCreatedTokens:
                (priorUsage?.cacheCreatedTokens ?? 0) + cacheCreatedTokens,
              cacheCreatedLongTtlTokens:
                (priorUsage?.cacheCreatedLongTtlTokens ?? 0) +
                cacheCreatedLongTtlTokens,
              reasoningOutputTokens:
                (priorUsage?.reasoningOutputTokens ?? 0) +
                reasoningOutputTokens,
              ...(completeModelUsage ? { modelUsage: completeModelUsage } : {}),
              ...(drain.partial
                ? { totalConfidence: TOKEN_TOTAL_CONFIDENCE.PARTIAL }
                : !modelUsageIsComplete
                  ? { totalConfidence: TOKEN_TOTAL_CONFIDENCE.PARTIAL }
                  : {}),
            },
          }
        : {}),
    },
  };
}
