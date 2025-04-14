import {
  test,
  assert,
  beforeEach,
  afterEach,
  describe,
  expect,
  vi,
} from "vitest";
import { configureNode } from "../node";
import OpenAI from "openai";
import { _exportsForTestingOnly, initLogger } from "../logger";
import { wrapOpenAI } from "../exports-node";
import { getCurrentUnixTimestamp } from "../util";
import { parseMetricsFromUsage } from "./oai_responses";

// use the cheapest model for tests
const TEST_MODEL = "gpt-4o-mini";

try {
  configureNode();
} catch (e) {
  // FIXME[matt] have a better of way of initializing brainstrust state once per process.
}

test("openai is installed", () => {
  assert.ok(OpenAI);
});

describe("openai client unit tests", () => {
  let oai: OpenAI;
  let client: OpenAI;
  let backgroundLogger: any;
  let logger: any;

  // fake login before we test. once is enough.
  _exportsForTestingOnly.simulateLoginForTests();

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    oai = new OpenAI();
    client = wrapOpenAI(oai);
    logger = initLogger({
      projectName: "openai.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("openai.chat.completions.streaming", async (context) => {
    assert.lengthOf(await backgroundLogger.drain(), 0);

    const start = getCurrentUnixTimestamp();
    const stream = await client.chat.completions.create({
      messages: [
        {
          role: "user",
          content: "Hello! Can you tell me a joke?",
        },
      ],
      model: TEST_MODEL,
      stream: true,
    });

    let ttft = -1.0;
    for await (const event of stream) {
      if (ttft < 0) {
        ttft = getCurrentUnixTimestamp() - start;
      }
      assert.ok(event);
    }
    const end = getCurrentUnixTimestamp();

    const spans = await backgroundLogger.drain();
    assert.lengthOf(spans, 1);
    const span = spans[0] as any;
    assert.equal(span.span_attributes.name, "Chat Completion");
    assert.equal(span.span_attributes.type, "llm");
    const m = span.metrics;
    assert.isTrue(start <= m.start && m.start < m.end && m.end <= end);
    assert.isTrue(ttft >= m.time_to_first_token);
    // NOTE: no metrics on streaming responses in chat.completions.
  });

  test("openai.chat.completions", async (context) => {
    assert.lengthOf(await backgroundLogger.drain(), 0);

    const start = getCurrentUnixTimestamp();
    const result = await client.chat.completions.create({
      messages: [
        {
          role: "user",
          content: "Hello! Can you tell me a joke?",
        },
      ],
      model: TEST_MODEL,
      max_tokens: 100,
    });
    const end = getCurrentUnixTimestamp();
    assert.ok(result);

    const spans = await backgroundLogger.drain();
    assert.lengthOf(spans, 1);
    const span = spans[0] as any;
    assert.ok(span);
    assert.equal(span.span_attributes.type, "llm");
    assert.equal(span.metadata.model, TEST_MODEL);
    const m = span.metrics;
    assert.isTrue(start <= m.start && m.start < m.end && m.end <= end);
    assert.isTrue(m.tokens > 0);
    assert.isTrue(m.prompt_tokens > 0);
    assert.isTrue(m.time_to_first_token > 0);
    assert.isTrue(m.prompt_cached_tokens >= 0);
    assert.isTrue(m.completion_reasoning_tokens >= 0);
  });

  test("openai.responses.stream", async (context) => {
    if (!oai.responses) {
      context.skip();
    }
    assert.lengthOf(await backgroundLogger.drain(), 0);

    const onEvent = vi.fn();
    const onDelta = vi.fn();
    const onIteration = vi.fn();

    const start = getCurrentUnixTimestamp();
    const stream = await client.responses
      .stream({
        model: TEST_MODEL,
        input: "What is 6x6?",
      })
      .on("event", onEvent)
      .on("response.output_text.delta", onDelta);

    for await (const event of stream) {
      onIteration(event);
      assert.ok(event);
    }
    const end = getCurrentUnixTimestamp();

    // make sure we don't break the API.
    expect(onEvent).toHaveBeenCalled();
    expect(onDelta).toHaveBeenCalled();
    expect(onIteration).toHaveBeenCalled();
    const result = await stream.finalResponse();
    expect(result.output[0].content[0].text).toContain("36");

    const spans = await backgroundLogger.drain();
    assert.lengthOf(spans, 1);
    const span = spans[0] as any;
    assert.equal(span.span_attributes.name, "openai.responses.create");
    assert.equal(span.span_attributes.type, "llm");
    assert.equal(span.input[0].content, "What is 6x6?");
    assert.equal(span.metadata.model, TEST_MODEL);
    expect(span.output).toContain("36");

    const m = span.metrics;
    assert.isTrue(start <= m.start && m.start < m.end && m.end <= end);
    assert.isTrue(m.tokens > 0);
    assert.isTrue(m.prompt_tokens > 0);
    assert.isTrue(m.time_to_first_token > 0);
    assert.isTrue(m.prompt_cached_tokens >= 0);
    assert.isTrue(m.completion_reasoning_tokens >= 0);
  });

  test("openai.responses.create(stream=true)", async (context) => {
    if (!oai.responses) {
      context.skip();
    }

    assert.lengthOf(await backgroundLogger.drain(), 0);

    const start = getCurrentUnixTimestamp();
    const stream = await client.responses.create({
      model: TEST_MODEL,
      input: "Read me a few lines of Sonnet 18",
      instructions: "the whole poem, strip punctuation",
      stream: true,
      temperature: 0.5,
    });

    assert.ok(stream);

    for await (const event of stream) {
      assert.ok(event);
      continue;
    }
    const end = getCurrentUnixTimestamp();

    const spans = await backgroundLogger.drain();
    assert.lengthOf(spans, 1);
    const span = spans[0] as any;
    assert.equal(span.span_attributes.name, "openai.responses.create");
    assert.equal(span.span_attributes.type, "llm");
    const input = span.input as any[];
    assert.lengthOf(input, 2);
    assert.equal(input[0].content, "Read me a few lines of Sonnet 18");
    assert.equal(input[0].role, "user");
    assert.equal(input[1].content, "the whole poem, strip punctuation");
    assert.equal(input[1].role, "system");
    assert.equal(span.metadata.model, TEST_MODEL);
    assert.equal(span.metadata.temperature, 0.5);
    // This line takes the output text, converts it to lowercase, and removes all characters
    // except letters, numbers and whitespace using a regex
    assert.isString(span.output);
    const output = span.output.toLowerCase().replace(/[^\w\s]/g, "");

    expect(output).toContain("shall i compare thee");
    const m = span.metrics;
    assert.isTrue(m.tokens > 0);
    assert.isTrue(m.prompt_tokens > 0);
    assert.isTrue(start <= m.start && m.start < m.end && m.end <= end);
    assert.isTrue(m.time_to_first_token > 0);
  });

  test("openai.responses.create(stream=false)", async (context) => {
    if (!oai.responses) {
      context.skip();
    }

    assert.lengthOf(await backgroundLogger.drain(), 0);

    const start = getCurrentUnixTimestamp();
    const response = await client.responses.create({
      model: TEST_MODEL,
      input: "What is the capital of France?",
    });
    const end = getCurrentUnixTimestamp();

    assert.ok(response);
    expect(response.output_text).toContain("Paris");

    const spans = await backgroundLogger.drain();
    assert.lengthOf(spans, 1);
    const span = spans[0] as any;
    assert.equal(span.span_attributes.name, "openai.responses.create");
    assert.equal(span.span_attributes.type, "llm");
    assert.equal(span.input[0].content, "What is the capital of France?");
    assert.equal(span.metadata.model, TEST_MODEL);
    expect(span.output).toContain("Paris");
    const m = span.metrics;
    assert.isTrue(m.tokens > 0);
    assert.isTrue(m.prompt_tokens > 0);
    assert.isTrue(start <= m.start && m.start < m.end && m.end <= end);
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });
});

test("parseMetricsFromUsage", () => {
  const usage = {
    input_tokens: 14,
    output_tokens: 8,
    input_tokens_details: { cached_tokens: 0, brand_new_token: 12 },
  };
  const metrics = parseMetricsFromUsage(usage);
  assert.equal(metrics.prompt_tokens, 14);
  assert.equal(metrics.prompt_cached_tokens, 0);
  assert.equal(metrics.prompt_brand_new_token, 12);
  assert.equal(metrics.completion_tokens, 8);
  // test a bunch of error conditions
  var totallyBadInputs = [
    null,
    undefined,
    "not an object",
    {},
    { input_tokens: "not a number" },
    { input_tokens_details: "not an object" },
    { input_tokens_details: {} },
    { input_tokens_details: { cached_tokens: "not a number" } },
    { input_tokens_details: { cached_tokens: null } },
    { input_tokens_details: { cached_tokens: undefined } },
  ];
  for (const input of totallyBadInputs) {
    assert.deepEqual(parseMetricsFromUsage(input), {});
  }
});
