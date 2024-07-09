import { callEventSchema } from "@braintrust/core/typespecs";
import {
  createParser,
  EventSourceParser,
  ParsedEvent,
  ReconnectInterval,
} from "eventsource-parser";

/**
 * A chunk of data from a Braintrust stream. Each chunk type matches
 * an SSE event type.
 */
export type BraintrustStreamChunk =
  | {
      type: "text_delta";
      data: string;
    }
  | {
      type: "json_delta";
      data: string;
    };

/**
 * A Braintrust stream. This is a wrapper around a ReadableStream of `BraintrustStreamChunk`,
 * with some utility methods to make them easy to log and convert into various formats.
 */
export class BraintrustStream {
  private stream: ReadableStream<BraintrustStreamChunk>;
  private memoizedFinalValue: Promise<unknown> | undefined;

  constructor(baseStream: ReadableStream<Uint8Array>);
  constructor(stream: ReadableStream<string>);
  constructor(stream: ReadableStream<BraintrustStreamChunk>);
  constructor(
    baseStream:
      | ReadableStream<Uint8Array>
      | ReadableStream<string>
      | ReadableStream<BraintrustStreamChunk>,
  ) {
    this.stream = baseStream.pipeThrough(btStreamParser());
  }

  /**
   * Copy the stream. This returns a new stream that shares the same underlying
   * stream (via `tee`). Since streams are consumed in Javascript, use `copy()` if you
   * need to use the stream multiple times.
   *
   * @returns A new stream that you can independently consume.
   */
  public copy(): BraintrustStream {
    // Once a stream is tee'd, it is essentially consumed, so we need to replace our own
    // copy of it.
    const [newStream, copyStream] = this.stream.tee();
    this.stream = copyStream;
    return new BraintrustStream(newStream);
  }

  /**
   * Get the underlying ReadableStream.
   *
   * @returns The underlying ReadableStream<BraintrustStreamChunk>.
   */
  public toReadableStream(): ReadableStream<BraintrustStreamChunk> {
    return this.stream;
  }

  /**
   * Get the final value of the stream. This will return a promise that resolves
   * when the stream is closed, and contains the final value of the stream. Multiple
   * calls to `finalValue()` will return the same promise, so it is safe to call
   * this multiple times.
   *
   * This function consumes the stream, so if you need to use the stream multiple
   * times, you should call `copy()` first.
   *
   * @returns A promise that resolves with the final value of the stream or `undefined` if the stream is empty.
   */
  public finalValue(): Promise<unknown> {
    if (this.memoizedFinalValue) {
      return this.memoizedFinalValue;
    }
    this.memoizedFinalValue = new Promise((resolve, reject) => {
      const stream = this.stream
        .pipeThrough(createFinalValuePassThroughStream(resolve))
        .pipeTo(devNullWritableStream());
    });
    return this.memoizedFinalValue;
  }
}

function btStreamParser() {
  const decoder = new TextDecoder();
  let parser: EventSourceParser;
  return new TransformStream<
    Uint8Array | string | BraintrustStreamChunk,
    BraintrustStreamChunk
  >({
    async start(controller) {
      parser = createParser((event: ParsedEvent | ReconnectInterval) => {
        if (event.type === "reconnect-interval") {
          return;
        }
        const parsed = callEventSchema.safeParse(event);
        if (!parsed.success) {
          throw new Error(`Failed to parse event: ${parsed.error}`);
        }
        switch (event.event) {
          case "text_delta":
            controller.enqueue({
              type: "text_delta",
              data: JSON.parse(event.data),
            });
            break;
          case "json_delta":
            controller.enqueue({
              type: "json_delta",
              data: event.data,
            });
            break;
          case "done":
            // Do nothing
            break;
        }
      });
    },
    async transform(chunk, controller) {
      if (chunk instanceof Uint8Array) {
        parser.feed(decoder.decode(chunk));
      } else if (typeof chunk === "string") {
        parser.feed(chunk);
      } else {
        controller.enqueue(chunk);
      }
    },
    async flush(controller) {
      controller.terminate();
    },
  });
}

/**
 * Create a stream that passes through the final value of the stream. This is
 * used to implement `BraintrustStream.finalValue()`.
 *
 * @param onFinal A function to call with the final value of the stream.
 * @returns A new stream that passes through the final value of the stream.
 */
export function createFinalValuePassThroughStream<
  T extends BraintrustStreamChunk | string | Uint8Array,
>(
  onFinal: (result: unknown) => void,
): TransformStream<T, BraintrustStreamChunk> {
  const decoder = new TextDecoder();
  const textChunks: string[] = [];
  const jsonChunks: string[] = [];

  const transformStream = new TransformStream<T, BraintrustStreamChunk>({
    transform(chunk, controller) {
      if (typeof chunk === "string") {
        textChunks.push(chunk);
      } else if (chunk instanceof Uint8Array) {
        textChunks.push(decoder.decode(chunk));
      } else {
        const chunkType = chunk.type;
        switch (chunkType) {
          case "text_delta":
            textChunks.push(chunk.data);
            break;
          case "json_delta":
            jsonChunks.push(chunk.data);
            break;
          default:
            const _type: never = chunkType;
            throw new Error(`Unknown chunk type ${_type}`);
        }
        controller.enqueue(chunk);
      }
    },
    flush(controller) {
      if (jsonChunks.length > 0) {
        // If we received both text and json deltas in the same stream, we
        // only return the json delta
        onFinal(JSON.parse(jsonChunks.join("")));
      } else if (textChunks.length > 0) {
        onFinal(textChunks.join(""));
      } else {
        onFinal(undefined);
      }

      controller.terminate();
    },
  });

  return transformStream;
}

export function devNullWritableStream(): WritableStream {
  return new WritableStream({
    write(chunk) {},
    close() {},
    abort(reason) {},
    start(controller) {},
  });
}
