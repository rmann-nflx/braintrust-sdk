import { test, expect, describe, beforeEach, afterEach, skip } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { wrapAnthropic } from "./anthropic";
import { TextBlock, Message } from "@anthropic-ai/sdk/resources/messages";
import { initLogger, _exportsForTestingOnly, Logger } from "../logger";
import { configureNode } from "../node";
import { debugLog, getCurrentUnixTimestamp } from "../util";

// use the cheapest model for tests
const TEST_MODEL = "claude-3-haiku-20240307";

try {
  configureNode();
} catch (e) {
  // FIXME[matt] have a better of way of initializing brainstrust state once per process.
}

test("anthropic is installed", () => {
  expect(Anthropic).toBeDefined();
});

describe("anthropic client unit tests", () => {
  let client: Anthropic;
  let backgroundLogger: any;
  let logger: Logger<false>;

  beforeEach(() => {
    client = wrapAnthropic(new Anthropic());
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    const metadata = {
      org_id: "test-org-id",
      project: {
        id: "test-id",
        name: "test-name",
        fullInfo: {},
      },
    };
    logger = initLogger({
      projectName: "anthropic.test.ts",
      orgProjectMetadata: metadata,
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("test client.messages.create with system text blocks", async (context) => {
    // FIXME[matt] handle system fields like this
    /*      {
        text: "do this!",
        type: "text",
      },
      {
        text: "do that!",
        type: "text",
      },
    ],
    */
    context.skip();
  });

  test("test client.message.create with stream=true", async () => {
    const startTime = getCurrentUnixTimestamp();
    const response = await client.messages.create({
      model: TEST_MODEL,
      messages: [
        {
          role: "user",
          content: "What is Shakespeare's sonnet 18?",
        },
      ],
      max_tokens: 1000,
      system:
        "No punctuation, newlines or non-alphanumeric characters. Just the poem.",
      temperature: 0.01,
      stream: true,
    });

    let ttft = 0;
    for await (const event of response) {
      if (ttft === 0) {
        ttft = getCurrentUnixTimestamp() - startTime;
      }
    }

    const endTime = getCurrentUnixTimestamp();

    // check that the background logger got the log
    const spans = await backgroundLogger.pop();
    expect(spans).toHaveLength(1);
    const span = spans[0] as any;
    //debugLog("got span", span);
    expect(span.input).toBeDefined();

    // clean up the output to make it easier to spot check
    const output = span.output
      .toLowerCase()
      .replace(/\n/g, " ")
      .replace(/'/g, "");
    // Validate we collected all the text, so check the first, line, the last line
    // and a few others too.
    expect(output).toContain("shall i compare thee to a summers day");
    expect(output).toContain("too hot the eye of heaven shines");
    expect(output).toContain("so long as men can breathe or eyes can see");
    expect(output).toContain("so long lives this and this gives life to thee");

    expect(span["span_attributes"].type).toBe("llm");
    expect(span["span_attributes"].name).toBe("anthropic.messages.create");
    const metrics = span.metrics;
    expect(metrics).toBeDefined();

    const pt = metrics["prompt_tokens"];
    const ct = metrics["completion_tokens"];
    const t = metrics["tokens"];

    expect(pt).toBeGreaterThan(0);
    expect(ct).toBeGreaterThan(0);
    expect(t).toEqual(pt + ct);
    expect(startTime < metrics.start).toBe(true);
    expect(metrics.start < metrics.end).toBe(true);
    expect(metrics.end <= endTime).toBe(true);
    expect(ttft).toBeGreaterThanOrEqual(metrics.time_to_first_token);
  });

  test("test client.messages.create basics", async () => {
    const startTime = getCurrentUnixTimestamp();
    const response: Message = await client.messages.create({
      model: TEST_MODEL,
      messages: [{ role: "user", content: "What's 4*4?" }],
      max_tokens: 100,
      system: "Return the result only.",
      temperature: 0.5,
    });
    expect(response).toBeDefined();

    //debugLog("response", response);
    const endTime = getCurrentUnixTimestamp();

    expect(response.content[0].type).toBe("text");
    const content = response.content[0] as TextBlock;
    expect(content.text).toContain("16");

    // check that the background logger got the log
    const spans = await backgroundLogger.pop();
    expect(spans).toHaveLength(1);
    const span = spans[0] as any;
    //debugLog("got span", span);
    expect(span["span_attributes"].type).toBe("llm");
    expect(span["span_attributes"].name).toBe("anthropic.messages.create");
    const metadata = span.metadata;
    expect(metadata?.model).toBe(TEST_MODEL);
    expect(metadata?.max_tokens).toBe(100);
    expect(metadata["stop_reason"]).toBe("end_turn");
    expect(metadata["temperature"]).toBe(0.5);
    expect(span?.input).toBeDefined();
    expect(span?.output).toBeDefined();
    const output = span.output[0].text;
    expect(output).toContain("16");
    const metrics = span.metrics;
    const usage = response.usage;
    const ccit = "cache_creation_input_tokens";
    const crit = "cache_read_input_tokens";
    expect(metrics).toBeDefined();
    expect(metrics["prompt_tokens"]).toBe(usage.input_tokens);
    expect(metrics["completion_tokens"]).toBe(usage.output_tokens);
    expect(metrics["tokens"]).toBe(usage.input_tokens + usage.output_tokens);
    expect(metrics[crit]).toBe(usage[crit]);
    expect(metrics[ccit]).toBe(usage[ccit]);
    expect(startTime <= metrics.start).toBe(true);
    expect(metrics.start < metrics.end).toBe(true);
    expect(metrics.end <= endTime).toBe(true);
  });
});
