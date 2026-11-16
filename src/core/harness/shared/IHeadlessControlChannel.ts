import type {
  ApprovalDecision,
  HeadlessControlObservationKind,
  HeadlessSteerDelivery,
} from "../../../types/DashboardConstants";

/** Serialized transport writer supplied once the child stdin is available. */
export interface ControlWriter {
  write(text: string): Promise<void>;
  end(): Promise<void>;
}

export type ControlObservation =
  | {
      kind: Extract<HeadlessControlObservationKind, "approval-request">;
      requestId: string;
    }
  | {
      kind: Extract<HeadlessControlObservationKind, "turn-end">;
    };

/** Provider-specific spawn adjustments for a control protocol. */
export interface HeadlessControlSpawnShape {
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/** Provider-owned protocol over a headless process's stdin/stdout. */
export interface IHeadlessControlChannel {
  readonly spawnShape: HeadlessControlSpawnShape;
  readonly steerDelivery: HeadlessSteerDelivery;
  start(writer: ControlWriter): Promise<void>;
  sendUserMessage(text: string): Promise<void>;
  observe(record: unknown): ControlObservation[];
  answerApproval(
    requestId: string,
    decision: ApprovalDecision,
    message?: string
  ): Promise<void>;
  close(): void;
}
