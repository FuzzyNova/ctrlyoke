import { afterEach, describe, expect, it, vi } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  createPromptCompletionClient,
  type PromptCompletionClient,
  type PromptCompletionTransport,
} from "@utils/promptCompletion/createPromptCompletionClient";
import { MESSAGE_TYPES } from "../../../types/messages";

const { startCompletionMock } = vi.hoisted(() => ({
  startCompletionMock: vi.fn(),
}));

vi.mock("@codemirror/autocomplete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@codemirror/autocomplete")>()),
  startCompletion: startCompletionMock,
}));

class RecordingTransport implements PromptCompletionTransport {
  readonly sent: Array<{ trigger: string; prefix: string; seq: number }> = [];
  postMessage(message: unknown): void {
    this.sent.push(message as (typeof this.sent)[number]);
  }
}

function contextFor(doc: string): CompletionContext {
  return new CompletionContext(EditorState.create({ doc }), doc.length, false);
}

function respond(
  seq: number,
  labels: string[],
  options: { from?: number; partial?: boolean } = {}
): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: MESSAGE_TYPES.COMPLETIONS_RESPONSE,
        seq,
        from: options.from ?? 0,
        partial: options.partial,
        items: labels.map((label) => ({ label })),
      },
    })
  );
}

describe("PromptCompletionClient", () => {
  const clients: PromptCompletionClient[] = [];

  function makeClient(
    transport: RecordingTransport,
    getView: () => EditorView | null = () => null
  ): PromptCompletionClient {
    const client = createPromptCompletionClient({
      transport,
      getView,
      getSymbolIconCache: () => undefined,
      getIsMultiRootWorkspace: () => false,
    });
    clients.push(client);
    return client;
  }

  afterEach(() => {
    for (const client of clients.splice(0)) client.dispose();
    startCompletionMock.mockClear();
  });

  it("posts the trigger request and resolves the source with the response", async () => {
    const transport = new RecordingTransport();
    const client = makeClient(transport);

    const pending = client.customSource(contextFor("see @src"));
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ trigger: "@", prefix: "@src" });

    respond(transport.sent[0].seq, ["src/a.ts"], { from: 4 });
    const result = await pending;
    expect(result?.options.map((option) => option.label)).toEqual(["src/a.ts"]);
    // `from` skips the trigger character that stays in the document.
    expect(result?.from).toBe(5);
  });

  it("answers null without a round trip when no trigger precedes the cursor", () => {
    const transport = new RecordingTransport();
    const client = makeClient(transport);

    expect(client.customSource(contextFor("plain text"))).toBeNull();
    expect(transport.sent).toHaveLength(0);
  });

  it("serves the full result from cache after a partial response", async () => {
    const transport = new RecordingTransport();
    const client = makeClient(transport);

    const explicit = client.customSource(contextFor("#")) as Promise<unknown>;
    const { seq } = transport.sent[0];

    respond(seq, ["selection"], { partial: true });
    const partialResult = (await explicit) as { options: { label: string }[] };
    expect(partialResult.options.map((option) => option.label)).toEqual([
      "selection",
    ]);

    // The full response arrives after the promise settled: it is cached and
    // the next source call for the same trigger+query returns it synchronously.
    respond(seq, ["selection", "sym:a"]);
    const cached = client.customSource(contextFor("#")) as unknown as {
      options: { label: string }[];
    };
    expect(cached.options.map((option) => option.label)).toEqual([
      "selection",
      "sym:a",
    ]);
    expect(transport.sent).toHaveLength(1);
  });

  it("refreshes an open dropdown for later partials and the final response", async () => {
    const transport = new RecordingTransport();
    const view = {} as EditorView;
    const client = makeClient(transport, () => view);

    const pending = client.customSource(contextFor("@src")) as unknown as Promise<{
      options: readonly { label: string }[];
    }>;
    const { seq } = transport.sent[0];

    respond(seq, ["first.ts"], { partial: true });
    await expect(pending).resolves.toMatchObject({
      options: [{ label: "first.ts" }],
    });

    respond(seq, ["second.ts"], { partial: true });
    expect(startCompletionMock).toHaveBeenCalledTimes(1);
    expect(startCompletionMock).toHaveBeenCalledWith(view);
    const second = client.customSource(contextFor("@src")) as unknown as {
      options: readonly { label: string }[];
    };
    expect(second.options.map((option) => option.label)).toEqual([
      "second.ts",
    ]);

    respond(seq, ["final.ts"]);
    expect(startCompletionMock).toHaveBeenCalledTimes(2);
    const final = client.customSource(contextFor("@src")) as unknown as {
      options: readonly { label: string }[];
    };
    expect(final.options.map((option) => option.label)).toEqual(["final.ts"]);
  });

  it("cancels a source's previous request when a newer keystroke arrives", async () => {
    const transport = new RecordingTransport();
    const client = makeClient(transport);

    const first = client.customSource(contextFor("@s")) as Promise<unknown>;
    const second = client.customSource(contextFor("@sr")) as Promise<unknown>;
    expect(transport.sent).toHaveLength(2);

    await expect(first).resolves.toBeNull();
    // A late answer for the superseded request is discarded.
    respond(transport.sent[0].seq, ["stale partial"], { partial: true });
    respond(transport.sent[0].seq, ["stale"]);
    respond(transport.sent[1].seq, ["fresh"]);
    const result = (await second) as { options: { label: string }[] };
    expect(result.options.map((option) => option.label)).toEqual(["fresh"]);
  });

  it("keeps the custom and path sources' requests independent", async () => {
    const transport = new RecordingTransport();
    const client = makeClient(transport);

    const slash = new CompletionContext(
      EditorState.create({ doc: "/" }),
      1,
      true
    );
    client.customSource(slash);
    const explicitPath = client.pathSource(slash) as Promise<unknown>;
    expect(transport.sent.map((message) => message.trigger)).toEqual([
      "/",
      "path",
    ]);

    respond(transport.sent[0].seq, ["skill"]);
    respond(transport.sent[1].seq, ["docs/a.md"]);
    await expect(explicitPath).resolves.toMatchObject({
      options: [{ label: "docs/a.md" }],
    });
  });

  it("routes each response to the client that asked, across editors", async () => {
    const transportA = new RecordingTransport();
    const transportB = new RecordingTransport();
    const clientA = makeClient(transportA);
    const clientB = makeClient(transportB);

    const a = clientA.customSource(contextFor("@a")) as Promise<unknown>;
    const b = clientB.customSource(contextFor("@b")) as Promise<unknown>;
    expect(transportA.sent[0].seq).not.toBe(transportB.sent[0].seq);

    respond(transportB.sent[0].seq, ["for-b"]);
    respond(transportA.sent[0].seq, ["for-a"]);

    await expect(a).resolves.toMatchObject({ options: [{ label: "for-a" }] });
    await expect(b).resolves.toMatchObject({ options: [{ label: "for-b" }] });
  });

  it("cancels outstanding requests on dispose and ignores late responses", async () => {
    const transport = new RecordingTransport();
    const client = makeClient(transport);

    const pending = client.customSource(contextFor("@a")) as Promise<unknown>;
    client.dispose();
    await expect(pending).resolves.toBeNull();

    const spy = vi.spyOn(window, "removeEventListener");
    respond(transport.sent[0].seq, ["late"]);
    // Nothing is pending, so the window listener was already removed.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
