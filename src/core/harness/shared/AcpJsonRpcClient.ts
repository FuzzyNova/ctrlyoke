import { getErrorMessage } from "../../../utils/ErrorUtils";
import { isRecord } from "../../../utils/JsonTypeGuards";
import { Log } from "../../../utils/Log";
import { splitCompleteLines } from "../../../utils/TextLines";
import type { ControlWriter } from "./IHeadlessControlChannel";

export type AcpJsonRpcId = number | string;

export interface AcpJsonRpcMessage extends Record<string, unknown> {
  jsonrpc: "2.0";
  id?: AcpJsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface AcpJsonRpcRequest {
  id: AcpJsonRpcId;
  sent: Promise<void>;
  result: Promise<unknown>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

function idKey(id: unknown): string | undefined {
  if (typeof id === "string") return `string:${id}`;
  if (typeof id === "number" && Number.isFinite(id)) return `number:${id}`;
  return undefined;
}

function rpcError(error: unknown): Error {
  if (isRecord(error) && typeof error.message === "string") {
    return new Error(error.message);
  }
  return new Error("ACP returned an invalid JSON-RPC error");
}

/** JSONL-framed JSON-RPC transport shared by ACP harness channels. */
export class AcpJsonRpcClient {
  private writer?: ControlWriter;
  private nextId = 1;
  private inputRemainder = "";
  private closed = false;
  private readonly pending = new Map<string, PendingRequest>();

  start(writer: ControlWriter): void {
    if (this.writer) {
      throw new Error("ACP JSON-RPC client has already started");
    }
    this.writer = writer;
    this.closed = false;
  }

  request(method: string, params: unknown): AcpJsonRpcRequest {
    const id = this.nextId++;
    const key = idKey(id)!;
    let resolveResult!: (result: unknown) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<unknown>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    result.catch(() => undefined);
    this.pending.set(key, {
      resolve: resolveResult,
      reject: rejectResult,
    });

    const sent = this.writeMessage({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }).catch((error: unknown) => {
      this.pending.delete(key);
      rejectResult(
        error instanceof Error ? error : new Error(getErrorMessage(error))
      );
      throw error;
    });
    return { id, sent, result };
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.writeMessage({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  async respond(id: AcpJsonRpcId, result: unknown): Promise<void> {
    await this.writeMessage({ jsonrpc: "2.0", id, result });
  }

  async respondError(
    id: AcpJsonRpcId,
    code: number,
    message: string
  ): Promise<void> {
    await this.writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
  }

  /** Feed stdout chunks and return every complete JSON-RPC message in order. */
  receiveChunk(chunk: string, flush = false): AcpJsonRpcMessage[] {
    if (this.closed) return [];
    const combined = this.inputRemainder + chunk;
    const split = splitCompleteLines(combined);
    this.inputRemainder = split.remainder;
    const lines = [...split.lines];
    if (flush && this.inputRemainder) {
      lines.push(this.inputRemainder);
      this.inputRemainder = "";
    }

    const messages: AcpJsonRpcMessage[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        Log.warn(
          `[AcpJsonRpcClient] Ignored malformed JSON-RPC line: ${getErrorMessage(error)}`
        );
        continue;
      }
      if (!isRecord(value) || value.jsonrpc !== "2.0") {
        Log.warn("[AcpJsonRpcClient] Ignored a message without JSON-RPC 2.0");
        continue;
      }

      const message = value as AcpJsonRpcMessage;
      const key = idKey(message.id);
      if (key && typeof message.method !== "string") {
        const pending = this.pending.get(key);
        if (!pending) {
          Log.warn("[AcpJsonRpcClient] Received a response for an unknown ID");
          continue;
        }
        this.pending.delete(key);
        if ("error" in message) pending.reject(rpcError(message.error));
        else if ("result" in message) pending.resolve(message.result);
        else
          pending.reject(new Error("ACP returned an empty JSON-RPC response"));
      }
      messages.push(message);
    }
    return messages;
  }

  close(error: Error = new Error("ACP JSON-RPC connection closed")): void {
    if (this.closed) return;
    this.closed = true;
    this.writer = undefined;
    this.inputRemainder = "";
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async writeMessage(message: Record<string, unknown>): Promise<void> {
    if (!this.writer || this.closed) {
      throw new Error("ACP JSON-RPC client is not connected");
    }
    await this.writer.write(`${JSON.stringify(message)}\n`);
  }
}
