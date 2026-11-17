import type {
  ApprovalDecision,
  HeadlessApprovalPolicy,
  HeadlessControlObservationKind,
  HeadlessSteerDelivery,
} from "../../../types/DashboardConstants";
import type {
  HeadlessApprovalRequestContext,
  HeadlessApprovalResolution,
} from "../../../types/WorkflowContextTypes";

/** Serialized transport writer supplied once the child stdin is available. */
export interface ControlWriter {
  write(text: string): Promise<void>;
  end(): Promise<void>;
}

export type ControlObservation =
  | {
      kind: Extract<HeadlessControlObservationKind, "approval-request">;
      requestId: string;
      toolName: string;
      input: unknown;
    }
  | {
      kind: Extract<HeadlessControlObservationKind, "model-question">;
      requestId: string;
    }
  | {
      kind: Extract<HeadlessControlObservationKind, "turn-end">;
      interrupted?: boolean;
    };

export type ControlObservationHandler = (
  observations: readonly ControlObservation[]
) => void;

/** Provider-specific spawn adjustments for a control protocol. */
export interface HeadlessControlSpawnShape {
  args?: readonly string[];
  /** Use `args` as the complete spawn argument list instead of appending them. */
  replaceArgs?: true;
  env?: NodeJS.ProcessEnv;
}

export interface HeadlessControlChannelOptions {
  approvalPolicy: HeadlessApprovalPolicy;
  approvalTimeoutMs: number;
  useApprovalControl: boolean;
  context?: HeadlessControlChannelContext;
}

export interface HeadlessControlChannelContext {
  sessionId?: string;
  imageFilePaths?: readonly string[];
  launchArgs?: readonly string[];
  workspaceRoot?: string;
  onSessionId?: (sessionId: string) => void;
}

export interface HeadlessApprovalExecutionContext extends HeadlessControlChannelOptions {
  requestApproval?: (
    request: HeadlessApprovalRequestContext,
    signal: AbortSignal
  ) => Promise<HeadlessApprovalResolution>;
}

/** Provider-owned protocol over a headless process's stdin/stdout. */
export interface IHeadlessControlChannel {
  readonly spawnShape: HeadlessControlSpawnShape;
  readonly steerDelivery: HeadlessSteerDelivery;
  /** False when the protocol is used for turn delivery/approvals but not steering. */
  readonly supportsSteering?: boolean;
  /** Keep stdin open after a turn while the provider reports pending background work. */
  readonly holdOpenForBackgroundWork?: boolean;
  /** Defer log-tail startup until `start()` has resolved a control session ID. */
  readonly startLogTailAfterChannelStart?: boolean;
  start(
    writer: ControlWriter,
    onObservations?: ControlObservationHandler
  ): Promise<void>;
  sendUserMessage(text: string): Promise<void>;
  observe(record: unknown): ControlObservation[];
  /** Optional protocol-owned stdout framing for transports such as ACP JSONL. */
  observeStdoutChunk?(chunk: string): ControlObservation[];
  /** Flush protocol-owned stdout framing after the child exits. */
  flushStdout?(): ControlObservation[];
  answerApproval(
    requestId: string,
    decision: ApprovalDecision,
    message?: string
  ): Promise<void>;
  interrupt?(): Promise<void>;
  close(): void;
}
