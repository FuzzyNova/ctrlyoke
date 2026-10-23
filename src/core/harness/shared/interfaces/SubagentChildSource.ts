import type {
  CliEvent,
  SubagentAttribution,
} from "../../../../types/CliOutputTypes";
import type { ProviderModelUsage } from "../../../../types/CliOutputTypes";

export interface SubagentRecordUsage extends ProviderModelUsage {
  model: string;
  /** Stable source-local identity used to avoid counting a reread record twice. */
  recordId: string;
  reasoningOutputTokens?: number;
}

export interface SubagentReadResult<TRecord> {
  records: TRecord[];
  nextOffset: number;
  complete?: boolean;
}

/** Typed provider-owned child source, registered only after its parent link is known. */
export interface SubagentChildSource<TRecord> {
  key: string;
  attribution: SubagentAttribution;
  read(fromOffset: number): Promise<SubagentReadResult<TRecord>>;
  map(record: TRecord): CliEvent[];
  usage?(record: TRecord): SubagentRecordUsage | undefined;
  isComplete(record: TRecord): boolean;
}
