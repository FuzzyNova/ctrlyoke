import * as assert from "assert";
import { suite, test } from "mocha";
import {
  attachStreamTextDecoder,
  type StreamTextDecoderByteStream,
} from "../../utils/StreamTextDecoder";

class TestByteStream implements StreamTextDecoderByteStream {
  private listener?: (data: Buffer) => void;

  on(event: "data", listener: (data: Buffer) => void): this {
    assert.strictEqual(event, "data");
    this.listener = listener;
    return this;
  }

  emitData(chunk: number[]): void {
    this.listener?.(Buffer.from(chunk));
  }
}

function decodeChunks(chunks: number[][]): {
  text: string;
  flushed: string;
} {
  const stream = new TestByteStream();
  const decoded: string[] = [];
  const flush = attachStreamTextDecoder(stream, (text) => {
    decoded.push(text);
  });

  for (const chunk of chunks) {
    stream.emitData(chunk);
  }

  return { text: decoded.join(""), flushed: flush() };
}

suite("StreamTextDecoder", () => {
  test("decodes a multi-byte character split across chunks once", () => {
    const result = decodeChunks([[0xc3], [0xa9]]);

    assert.strictEqual(result.text + result.flushed, "é");
    assert.strictEqual((result.text + result.flushed).match(/é/g)?.length, 1);
    assert.ok(!result.text.includes("\ufffd"));
    assert.ok(!result.flushed.includes("\ufffd"));
  });

  test("decodes an emoji split 1/3", () => {
    const result = decodeChunks([[0xf0], [0x9f, 0x98, 0x80]]);

    assert.strictEqual(result.text + result.flushed, "😀");
  });

  test("decodes an emoji split 3/1", () => {
    const result = decodeChunks([[0xf0, 0x9f, 0x98], [0x80]]);

    assert.strictEqual(result.text + result.flushed, "😀");
  });

  test("surfaces a trailing incomplete sequence through flush", () => {
    const result = decodeChunks([[0xe2, 0x82]]);

    assert.strictEqual(result.text, "");
    assert.strictEqual(result.flushed, "\ufffd");
  });

  test("passes ASCII input through byte-identically", () => {
    const result = decodeChunks([
      Array.from(Buffer.from("plain ASCII output\n", "ascii")).slice(0, 7),
      Array.from(Buffer.from("plain ASCII output\n", "ascii")).slice(7),
    ]);

    assert.strictEqual(result.text + result.flushed, "plain ASCII output\n");
  });
});
