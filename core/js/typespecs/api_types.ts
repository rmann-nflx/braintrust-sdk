// Type definitions for operating on the api database.

import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
extendZodWithOpenApi(z);

import { experimentSchema, datasetSchema, projectSchema } from "./app_types";
import {
  datetimeStringSchema,
  getEventObjectArticle,
  getEventObjectType,
  getEventObjectDescription,
  ObjectType,
} from "./common_types";
import { customTypes } from "./custom_types";
import { capitalize } from "../src/util";

import {
  TRANSACTION_ID_FIELD,
  OBJECT_DELETE_FIELD,
  IS_MERGE_FIELD,
  MERGE_PATHS_FIELD,
  PARENT_ID_FIELD,
  VALID_SOURCES,
} from "../src/db_fields";

import { SpanTypeAttribute } from "../src/span_types";
import { promptDataSchema } from "./prompt";

export const auditSourcesSchema = z.enum(VALID_SOURCES);

function generateBaseEventOpSchema(objectType: ObjectType) {
  const eventDescription = getEventObjectDescription(objectType);
  return z.object({
    id: z
      .string()
      .describe(
        `A unique identifier for the ${eventDescription} event. If you don't provide one, BrainTrust will generate one for you`
      ),
    [TRANSACTION_ID_FIELD]: z
      .string()
      .describe(
        `The transaction id of an event is unique to the network operation that processed the event insertion. Transaction ids are monotonically increasing over time and can be used to retrieve a versioned snapshot of the ${eventDescription} (see the \`version\` parameter)`
      ),
    created: datetimeStringSchema
      .nullish()
      .describe(`The timestamp the ${eventDescription} event was created`),
    input: customTypes.any,
    output: customTypes.any,
    expected: customTypes.any,
    tags: z.array(z.string()).nullish().describe("A list of tags to log"),
    scores: z.record(z.number().min(0).max(1).nullish()).nullish(),
    metadata: z
      .record(customTypes.any)
      .nullish()
      .describe(
        "A dictionary with additional data about the test example, model outputs, or just about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any JSON-serializable type, but its keys must be strings"
      ),
    metrics: z
      .object({
        start: z
          .number()
          .nullish()
          .describe(
            `A unix timestamp recording when the section of code which produced the ${eventDescription} event started`
          ),
        end: z
          .number()
          .nullish()
          .describe(
            `A unix timestamp recording when the section of code which produced the ${eventDescription} event finished`
          ),
      })
      // We are permissive of non-numerical metrics here because not all
      // versions of the SDK have validated that metrics are entirely numerical.
      // There are also old logged metrics which contain the `caller_*`
      // information. We could potentially stricten this by adding some
      // backfills to the chalice backend.
      .catchall(customTypes.any)
      .nullish()
      .describe(
        `Metrics are numerical measurements tracking the execution of the code that produced the ${eventDescription} event. Use "start" and "end" to track the time span over which the ${eventDescription} event was produced`
      ),
    context: z
      .object({
        caller_functionname: z
          .string()
          .nullish()
          .describe(
            `The function in code which created the ${eventDescription} event`
          ),
        caller_filename: z
          .string()
          .nullish()
          .describe(
            `Name of the file in code where the ${eventDescription} event was created`
          ),
        caller_lineno: z
          .number()
          .int()
          .nullish()
          .describe(
            `Line of code where the ${eventDescription} event was created`
          ),
      })
      .catchall(customTypes.any)
      .nullish()
      .describe(
        `Context is additional information about the code that produced the ${eventDescription} event. It is essentially the textual counterpart to \`metrics\`. Use the \`caller_*\` attributes to track the location in code which produced the ${eventDescription} event`
      ),
    span_id: z
      .string()
      .describe(
        `A unique identifier used to link different ${eventDescription} events together as part of a full trace. See the [tracing guide](https://www.braintrustdata.com/docs/guides/tracing) for full details on tracing`
      ),
    span_parents: z
      .string()
      .array()
      .nullish()
      .describe(
        `An array of the parent \`span_ids\` of this ${eventDescription} event. This should be empty for the root span of a trace, and should most often contain just one parent element for subspans`
      ),
    root_span_id: z
      .string()
      .describe(
        `The \`span_id\` of the root of the trace this ${eventDescription} event belongs to`
      ),
    span_attributes: z
      .object({
        name: z
          .string()
          .nullish()
          .describe("Name of the span, for display purposes only"),
        type: z
          .nativeEnum(SpanTypeAttribute)
          .nullish()
          .describe("Type of the span, for display purposes only"),
      })
      .catchall(customTypes.any)
      .nullish()
      .describe(
        "Human-identifying attributes of the span, such as name, type, etc."
      ),
    [OBJECT_DELETE_FIELD]: z
      .boolean()
      .nullish()
      .describe(
        `Pass \`${OBJECT_DELETE_FIELD}=true\` to mark the ${eventDescription} event deleted. Deleted events will not show up in subsequent fetches for this ${eventDescription}`
      ),
  });
}

function generateBaseEventFeedbackSchema(objectType: ObjectType) {
  const eventObjectType = getEventObjectType(objectType);
  const eventDescription = getEventObjectDescription(objectType);
  return z.object({
    id: z
      .string()
      .describe(
        `The id of the ${eventDescription} event to log feedback for. This is the row \`id\` returned by \`POST /v1/${eventObjectType}/{${objectType}_id}/insert\``
      ),
    scores: z
      .record(z.number().min(0).max(1).nullish())
      .nullish()
      .describe(
        `A dictionary of numeric values (between 0 and 1) to log. These scores will be merged into the existing scores for the ${eventDescription} event`
      ),
    expected: customTypes.any.describe(
      "The ground truth value (an arbitrary, JSON serializable object) that you'd compare to `output` to determine if your `output` value is correct or not"
    ),
    tags: z.array(z.string()).nullish().describe("A list of tags to log"),
    comment: z
      .string()
      .nullish()
      .describe(
        `An optional comment string to log about the ${eventDescription} event`
      ),
    metadata: z
      .record(customTypes.any)
      .nullish()
      .describe(
        "A dictionary with additional data about the feedback. If you have a `user_id`, you can log it here and access it in the Braintrust UI."
      ),
    source: auditSourcesSchema
      .nullish()
      .describe(
        'The source of the feedback. Must be one of "external" (default), "app", or "api"'
      ),
  });
}

// Section: fetching data objects.

// Pagination for fetching events within data objects.

export const fetchLimitSchema = z
  .number()
  .int()
  .nonnegative()
  .describe(
    [
      "limit the number of traces fetched",
      `Fetch queries may be paginated if the total result size is expected to be large (e.g. project_logs which accumulate over a long time). Note that fetch queries only support pagination in descending time order (from latest to earliest \`${TRANSACTION_ID_FIELD}\`. Furthermore, later pages may return rows which showed up in earlier pages, except with an earlier \`${TRANSACTION_ID_FIELD}\`. This happens because pagination occurs over the whole version history of the event log. You will most likely want to exclude any such duplicate, outdated rows (by \`id\`) from your combined result set.`,
      `The \`limit\` parameter controls the number of full traces to return. So you may end up with more individual rows than the specified limit if you are fetching events containing traces.`,
    ].join("\n\n")
  );

const fetchPaginationCursorDescription = [
  "Together, `max_xact_id` and `max_root_span_id` form a pagination cursor",
  `Since a paginated fetch query returns results in order from latest to earliest, the cursor for the next page can be found as the row with the minimum (earliest) value of the tuple \`(${TRANSACTION_ID_FIELD}, root_span_id)\`. See the documentation of \`limit\` for an overview of paginating fetch queries.`,
].join("\n\n");

export const maxXactIdSchema = z
  .string()
  .describe(fetchPaginationCursorDescription);

export const maxRootSpanIdSchema = z
  .string()
  .describe(fetchPaginationCursorDescription);

export const versionSchema = z
  .string()
  .describe(
    [
      "Retrieve a snapshot of events from a past time",
      "The version id is essentially a filter on the latest event transaction id. You can use the `max_xact_id` returned by a past fetch as the version to reproduce that exact fetch.",
    ].join("\n\n")
  );

const pathTypeFilterSchema = z
  .object({
    type: z
      .literal("path_lookup")
      .describe("Denotes the type of filter as a path-lookup filter"),
    path: z
      .string()
      .array()
      .describe(
        'List of fields describing the path to the value to be checked against. For instance, if you wish to filter on the value of `c` in `{"input": {"a": {"b": {"c": "hello"}}}}`, pass `path=["input", "a", "b", "c"]`'
      ),
    value: customTypes.any.describe(
      'The value to compare equality-wise against the event value at the specified `path`. The value must be a "primitive", that is, any JSON-serializable object except for objects and arrays. For instance, if you wish to filter on the value of "input.a.b.c" in the object `{"input": {"a": {"b": {"c": "hello"}}}}`, pass `value="hello"`'
    ),
  })
  .describe(
    'A path-lookup filter describes an equality comparison against a specific sub-field in the event row. For instance, if you wish to filter on the value of `c` in `{"input": {"a": {"b": {"c": "hello"}}}}`, pass `path=["input", "a", "b", "c"]` and `value="hello"`'
  )
  .openapi("PathLookupFilter");

const sqlTypeFilterSchema = z
  .object({
    type: z
      .literal("sql_filter")
      .describe("Denotes the type of filter as a sql-type filter"),
    expr: z
      .string()
      .describe(
        `A SQL expression in [duckDB syntax](https://duckdb.org/docs/sql/expressions/overview). For instance, if you wish to fuzzy-match the value of \`c\` in \`{"input": {"a": {"b": {"c": "hello"}}}}\`, pass \`expr="input->'a'->'b'->>'c' LIKE '%el%'"\`.`
      ),
  })
  .describe(
    `A sql-type filter describes a general filter over an individual row in [duckDB syntax](https://duckdb.org/docs/sql/expressions/overview). For instance, if you wish to fuzzy-match the value of \`c\` in \`{"input": {"a": {"b": {"c": "hello"}}}}\`, pass \`expr="input->'a'->'b'->>'c' LIKE '%el%'"\`.`
  )
  .openapi("SQLFilter");

export const allFetchFiltersSchema = z
  .union([pathTypeFilterSchema, sqlTypeFilterSchema])
  .array()
  .describe(
    "A list of filters on the events to fetch. Filters can either be specialized `path=value` expressions or general SQL expressions in [duckDB syntax](https://duckdb.org/docs/sql/expressions/overview). When possible, prefer path-lookup type filters over general SQL-type filters, as they are likely to activate indices in the DB and run faster"
  )
  .openapi("AllFetchEventsFilters");

export const fetchFiltersSchema = pathTypeFilterSchema
  .array()
  .describe(
    "A list of filters on the events to fetch. Currently, only path-lookup type filters are supported, but we may add more in the future"
  )
  .openapi("FetchEventsFilters");

export const fetchEventsRequestSchema = z
  .object({
    limit: fetchLimitSchema.nullish(),
    max_xact_id: maxXactIdSchema.nullish(),
    max_root_span_id: maxRootSpanIdSchema.nullish(),
    filters: fetchFiltersSchema.nullish(),
    version: versionSchema.nullish(),
  })
  .strict()
  .openapi("FetchEventsRequest");

function makeFetchEventsResponseSchema<T extends z.AnyZodObject>(
  objectType: ObjectType,
  eventSchema: T
) {
  const eventName = capitalize(getEventObjectType(objectType), "_").replace(
    "_",
    ""
  );
  return z
    .object({
      events: eventSchema.array().describe("A list of fetched events"),
    })
    .strict()
    .openapi(`Fetch${eventName}EventsResponse`);
}

const experimentEventBaseSchema = generateBaseEventOpSchema("experiment");
const experimentEventSchema = z
  .object({
    id: experimentEventBaseSchema.shape.id,
    dataset_record_id: z
      .string()
      .nullish()
      .describe(
        "If the experiment is associated to a dataset, this is the event-level dataset id this experiment event is tied to"
      ),
    [TRANSACTION_ID_FIELD]:
      experimentEventBaseSchema.shape[TRANSACTION_ID_FIELD],
    created: experimentEventBaseSchema.shape.created,
    project_id: experimentSchema.shape.project_id,
    experiment_id: experimentSchema.shape.id,
    input: experimentEventBaseSchema.shape.input.describe(
      "The arguments that uniquely define a test case (an arbitrary, JSON serializable object). Later on, Braintrust will use the `input` to know whether two test cases are the same between experiments, so they should not contain experiment-specific state. A simple rule of thumb is that if you run the same experiment twice, the `input` should be identical"
    ),
    output: experimentEventBaseSchema.shape.output.describe(
      "The output of your application, including post-processing (an arbitrary, JSON serializable object), that allows you to determine whether the result is correct or not. For example, in an app that generates SQL queries, the `output` should be the _result_ of the SQL query generated by the model, not the query itself, because there may be multiple valid queries that answer a single question"
    ),
    expected: experimentEventBaseSchema.shape.expected.describe(
      "The ground truth value (an arbitrary, JSON serializable object) that you'd compare to `output` to determine if your `output` value is correct or not. Braintrust currently does not compare `output` to `expected` for you, since there are so many different ways to do that correctly. Instead, these values are just used to help you navigate your experiments while digging into analyses. However, we may later use these values to re-score outputs or fine-tune your models"
    ),
    scores: experimentEventBaseSchema.shape.scores.describe(
      "A dictionary of numeric values (between 0 and 1) to log. The scores should give you a variety of signals that help you determine how accurate the outputs are compared to what you expect and diagnose failures. For example, a summarization app might have one score that tells you how accurate the summary is, and another that measures the word similarity between the generated and grouth truth summary. The word similarity score could help you determine whether the summarization was covering similar concepts or not. You can use these scores to help you sort, filter, and compare experiments"
    ),
    metadata: experimentEventBaseSchema.shape.metadata,
    tags: experimentEventBaseSchema.shape.tags,
    metrics: experimentEventBaseSchema.shape.metrics,
    context: experimentEventBaseSchema.shape.context,
    span_id: experimentEventBaseSchema.shape.span_id,
    span_parents: experimentEventBaseSchema.shape.span_parents,
    root_span_id: experimentEventBaseSchema.shape.root_span_id,
    span_attributes: experimentEventBaseSchema.shape.span_attributes,
  })
  .strict()
  .openapi("ExperimentEvent");

const datasetEventBaseSchema = generateBaseEventOpSchema("dataset");
const datasetEventSchema = z
  .object({
    id: datasetEventBaseSchema.shape.id,
    [TRANSACTION_ID_FIELD]: datasetEventBaseSchema.shape[TRANSACTION_ID_FIELD],
    created: datasetEventBaseSchema.shape.created,
    project_id: datasetSchema.shape.project_id,
    dataset_id: datasetSchema.shape.id,
    input: datasetEventBaseSchema.shape.input.describe(
      "The argument that uniquely define an input case (an arbitrary, JSON serializable object)"
    ),
    expected: datasetEventBaseSchema.shape.expected.describe(
      "The output of your application, including post-processing (an arbitrary, JSON serializable object)"
    ),
    metadata: datasetEventBaseSchema.shape.metadata,
    tags: datasetEventBaseSchema.shape.tags,
    span_id: datasetEventBaseSchema.shape.span_id,
    root_span_id: datasetEventBaseSchema.shape.root_span_id,
  })
  .strict()
  .openapi("DatasetEvent");

const projectLogsEventBaseSchema = generateBaseEventOpSchema("project");
const projectLogsEventSchema = z
  .object({
    id: projectLogsEventBaseSchema.shape.id,
    [TRANSACTION_ID_FIELD]:
      projectLogsEventBaseSchema.shape[TRANSACTION_ID_FIELD],
    created: projectLogsEventBaseSchema.shape.created,
    org_id: projectSchema.shape.org_id,
    project_id: projectSchema.shape.id,
    log_id: z
      .literal("g")
      .describe("A literal 'g' which identifies the log as a project log"),
    input: projectLogsEventBaseSchema.shape.input.describe(
      "The arguments that uniquely define a user input(an arbitrary, JSON serializable object)."
    ),
    output: projectLogsEventBaseSchema.shape.output.describe(
      "The output of your application, including post-processing (an arbitrary, JSON serializable object), that allows you to determine whether the result is correct or not. For example, in an app that generates SQL queries, the `output` should be the _result_ of the SQL query generated by the model, not the query itself, because there may be multiple valid queries that answer a single question."
    ),
    expected: projectLogsEventBaseSchema.shape.expected.describe(
      "The ground truth value (an arbitrary, JSON serializable object) that you'd compare to `output` to determine if your `output` value is correct or not. Braintrust currently does not compare `output` to `expected` for you, since there are so many different ways to do that correctly. Instead, these values are just used to help you navigate while digging into analyses. However, we may later use these values to re-score outputs or fine-tune your models."
    ),
    scores: projectLogsEventBaseSchema.shape.scores.describe(
      "A dictionary of numeric values (between 0 and 1) to log. The scores should give you a variety of signals that help you determine how accurate the outputs are compared to what you expect and diagnose failures. For example, a summarization app might have one score that tells you how accurate the summary is, and another that measures the word similarity between the generated and grouth truth summary. The word similarity score could help you determine whether the summarization was covering similar concepts or not. You can use these scores to help you sort, filter, and compare logs."
    ),
    metadata: projectLogsEventBaseSchema.shape.metadata,
    tags: projectLogsEventBaseSchema.shape.tags,
    metrics: projectLogsEventBaseSchema.shape.metrics,
    context: projectLogsEventBaseSchema.shape.context,
    span_id: projectLogsEventBaseSchema.shape.span_id,
    span_parents: projectLogsEventBaseSchema.shape.span_parents,
    root_span_id: projectLogsEventBaseSchema.shape.root_span_id,
    span_attributes: projectLogsEventBaseSchema.shape.span_attributes,
  })
  .strict()
  .openapi("ProjectLogsEvent");

const promptEventBaseSchema = generateBaseEventOpSchema("prompt");
export const promptEventSchema = z
  .object({
    id: promptEventBaseSchema.shape.id,
    [TRANSACTION_ID_FIELD]: promptEventBaseSchema.shape[TRANSACTION_ID_FIELD],
    created: promptEventBaseSchema.shape.created,
    org_id: projectSchema.shape.org_id,
    project_id: projectSchema.shape.id,
    log_id: z
      .literal("p")
      .describe("A literal 'p' which identifies the log as a prompt entry"),
    name: z.string().describe("The name of the prompt"),
    slug: z.string().describe("The slug of the prompt"),
    description: z.string().describe("The description of the prompt"),
    prompt_data: promptDataSchema.describe("The prompt and its parameters"),
    tags: promptEventBaseSchema.shape.tags,
  })
  .strict()
  .openapi("PromptEvent");

// Section: inserting data objects.

// Merge system control fields.

const isMergeDescription = [
  "The `_is_merge` field controls how the row is merged with any existing row with the same id in the DB. By default (or when set to `false`), the existing row is completely replaced by the new row. When set to `true`, the new row is deep-merged into the existing row",
  'For example, say there is an existing row in the DB `{"id": "foo", "input": {"a": 5, "b": 10}}`. If we merge a new row as `{"_is_merge": true, "id": "foo", "input": {"b": 11, "c": 20}}`, the new row will be `{"id": "foo", "input": {"a": 5, "b": 11, "c": 20}}`. If we replace the new row as `{"id": "foo", "input": {"b": 11, "c": 20}}`, the new row will be `{"id": "foo", "input": {"b": 11, "c": 20}}`',
].join("\n\n");

const mergeEventSchema = z.object({
  [IS_MERGE_FIELD]: customTypes.literalTrue.describe(isMergeDescription),
  [MERGE_PATHS_FIELD]: z
    .string()
    .array()
    .array()
    .nullish()
    .describe(
      [
        "The `_merge_paths` field allows controlling the depth of the merge. It can only be specified alongside `_is_merge=true`. `_merge_paths` is a list of paths, where each path is a list of field names. The deep merge will not descend below any of the specified merge paths.",
        'For example, say there is an existing row in the DB `{"id": "foo", "input": {"a": {"b": 10}, "c": {"d": 20}}, "output": {"a": 20}}`. If we merge a new row as `{"_is_merge": true, "_merge_paths": [["input", "a"], ["output"]], "input": {"a": {"q": 30}, "c": {"e": 30}, "bar": "baz"}, "output": {"d": 40}}`, the new row will be `{"id": "foo": "input": {"a": {"q": 30}, "c": {"d": 20, "e": 30}, "bar": "baz"}, "output": {"d": 40}}`. In this case, due to the merge paths, we have replaced `input.a` and `output`, but have still deep-merged `input` and `input.c`.',
      ].join("\n\n")
    ),
});

const replacementEventSchema = z.object({
  [IS_MERGE_FIELD]: customTypes.literalFalse
    .nullish()
    .describe(isMergeDescription),
  [PARENT_ID_FIELD]: z
    .string()
    .nullish()
    .describe(
      [
        "Use the `_parent_id` field to create this row as a subspan of an existing row. It cannot be specified alongside `_is_merge=true`. Tracking hierarchical relationships are important for tracing (see the [guide](https://www.braintrustdata.com/docs/guides/tracing) for full details).",
        'For example, say we have logged a row `{"id": "abc", "input": "foo", "output": "bar", "expected": "boo", "scores": {"correctness": 0.33}}`. We can create a sub-span of the parent row by logging `{"_parent_id": "abc", "id": "llm_call", "input": {"prompt": "What comes after foo?"}, "output": "bar", "metrics": {"tokens": 1}}`. In the webapp, only the root span row `"abc"` will show up in the summary view. You can view the full trace hierarchy (in this case, the `"llm_call"` row) by clicking on the "abc" row.',
      ].join("\n\n")
    ),
});

function makeInsertEventSchemas<T extends z.AnyZodObject>(
  objectType: ObjectType,
  insertSchema: T
) {
  const eventDescription = getEventObjectDescription(objectType);
  const article = getEventObjectArticle(objectType);
  const eventSchemaName = capitalize(
    getEventObjectType(objectType),
    "_"
  ).replace("_", "");
  const replaceVariantSchema = insertSchema
    .merge(replacementEventSchema)
    .strict()
    .openapi(`Insert${eventSchemaName}EventReplace`);
  const mergeVariantSchema = insertSchema
    .merge(mergeEventSchema)
    .strict()
    .openapi(`Insert${eventSchemaName}EventMerge`);
  const eventSchema = z
    .union([replaceVariantSchema, mergeVariantSchema])
    .describe(`${capitalize(article)} ${eventDescription} event`)
    .openapi(`Insert${eventSchemaName}Event`);
  const requestSchema = z
    .object({
      events: eventSchema
        .array()
        .describe(`A list of ${eventDescription} events to insert`),
    })
    .strict()
    .openapi(`Insert${eventSchemaName}EventRequest`);
  return { eventSchema, requestSchema };
}

export const insertEventsResponseSchema = z
  .object({
    row_ids: z
      .string()
      .array()
      .describe(
        "The ids of all rows that were inserted, aligning one-to-one with the rows provided as input"
      ),
  })
  .strict()
  .openapi("InsertEventsResponse");

const {
  eventSchema: insertExperimentEventSchema,
  requestSchema: insertExperimentEventsRequestSchema,
} = makeInsertEventSchemas(
  "experiment",
  z
    .object({
      input: experimentEventSchema.shape.input,
      output: experimentEventSchema.shape.output,
      expected: experimentEventSchema.shape.expected,
      scores: experimentEventSchema.shape.scores,
      metadata: experimentEventSchema.shape.metadata,
      tags: experimentEventSchema.shape.tags,
      metrics: experimentEventSchema.shape.metrics,
      context: experimentEventSchema.shape.context,
      span_attributes: experimentEventSchema.shape.span_attributes,
      id: experimentEventSchema.shape.id.nullish(),
      dataset_record_id: experimentEventSchema.shape.dataset_record_id,
      [OBJECT_DELETE_FIELD]:
        experimentEventBaseSchema.shape[OBJECT_DELETE_FIELD],
    })
    .strict()
);

const {
  eventSchema: insertDatasetEventSchema,
  requestSchema: insertDatasetEventsRequestSchema,
} = makeInsertEventSchemas(
  "dataset",
  z
    .object({
      input: datasetEventSchema.shape.input,
      expected: datasetEventSchema.shape.expected,
      metadata: datasetEventSchema.shape.metadata,
      tags: datasetEventSchema.shape.tags,
      id: datasetEventSchema.shape.id.nullish(),
      [OBJECT_DELETE_FIELD]: datasetEventBaseSchema.shape[OBJECT_DELETE_FIELD],
    })
    .strict()
);

const {
  eventSchema: insertProjectLogsEventSchema,
  requestSchema: insertProjectLogsEventsRequestSchema,
} = makeInsertEventSchemas(
  "project",
  z
    .object({
      input: projectLogsEventSchema.shape.input,
      output: projectLogsEventSchema.shape.output,
      expected: projectLogsEventSchema.shape.expected,
      scores: projectLogsEventSchema.shape.scores,
      metadata: projectLogsEventSchema.shape.metadata,
      tags: projectLogsEventSchema.shape.tags,
      metrics: projectLogsEventSchema.shape.metrics,
      context: projectLogsEventSchema.shape.context,
      span_attributes: projectLogsEventSchema.shape.span_attributes,
      id: projectLogsEventSchema.shape.id.nullish(),
      [OBJECT_DELETE_FIELD]:
        projectLogsEventBaseSchema.shape[OBJECT_DELETE_FIELD],
    })
    .strict()
);

// Section: logging feedback.

function makeFeedbackRequestSchema<T extends z.AnyZodObject>(
  objectType: ObjectType,
  feedbackSchema: T
) {
  const eventDescription = getEventObjectDescription(objectType);
  const eventSchemaName = capitalize(
    getEventObjectType(objectType),
    "_"
  ).replace("_", "");
  return z
    .object({
      feedback: feedbackSchema
        .array()
        .describe(`A list of ${eventDescription} feedback items`),
    })
    .strict()
    .openapi(`Feedback${eventSchemaName}EventRequest`);
}

const feedbackExperimentRequestBaseSchema =
  generateBaseEventFeedbackSchema("experiment");
const feedbackExperimentItemSchema = z
  .object({
    id: feedbackExperimentRequestBaseSchema.shape.id,
    scores: feedbackExperimentRequestBaseSchema.shape.scores,
    expected: feedbackExperimentRequestBaseSchema.shape.expected,
    comment: feedbackExperimentRequestBaseSchema.shape.comment,
    metadata: feedbackExperimentRequestBaseSchema.shape.metadata,
    source: feedbackExperimentRequestBaseSchema.shape.source,
  })
  .strict()
  .openapi("FeedbackExperimentItem");
const feedbackExperimentRequestSchema = makeFeedbackRequestSchema(
  "experiment",
  feedbackExperimentItemSchema
);

const feedbackDatasetRequestBaseSchema =
  generateBaseEventFeedbackSchema("dataset");
const feedbackDatasetItemSchema = z
  .object({
    id: feedbackDatasetRequestBaseSchema.shape.id,
    comment: feedbackDatasetRequestBaseSchema.shape.comment,
    metadata: feedbackDatasetRequestBaseSchema.shape.metadata,
    source: feedbackDatasetRequestBaseSchema.shape.source,
  })
  .strict()
  .openapi("FeedbackDatasetItem");
const feedbackDatasetRequestSchema = makeFeedbackRequestSchema(
  "dataset",
  feedbackDatasetItemSchema
);

const feedbackProjectLogsRequestBaseSchema =
  generateBaseEventFeedbackSchema("project");
const feedbackProjectLogsItemSchema = z
  .object({
    id: feedbackProjectLogsRequestBaseSchema.shape.id,
    scores: feedbackProjectLogsRequestBaseSchema.shape.scores,
    expected: feedbackProjectLogsRequestBaseSchema.shape.expected,
    comment: feedbackProjectLogsRequestBaseSchema.shape.comment,
    metadata: feedbackProjectLogsRequestBaseSchema.shape.metadata,
    source: feedbackProjectLogsRequestBaseSchema.shape.source,
  })
  .strict()
  .openapi("FeedbackProjectLogsItem");
const feedbackProjectLogsRequestSchema = makeFeedbackRequestSchema(
  "project",
  feedbackProjectLogsItemSchema
);

const feedbackPromptRequestBaseSchema =
  generateBaseEventFeedbackSchema("prompt");
const feedbackPromptItemSchema = z
  .object({
    id: feedbackPromptRequestBaseSchema.shape.id,
    comment: feedbackPromptRequestBaseSchema.shape.comment,
    metadata: feedbackPromptRequestBaseSchema.shape.metadata,
    source: feedbackPromptRequestBaseSchema.shape.source,
  })
  .strict()
  .openapi("FeedbackPromptItem");
const feedbackPromptRequestSchema = makeFeedbackRequestSchema(
  "prompt",
  feedbackPromptItemSchema
);

// Section: exported schemas, grouped by object type.

export const eventObjectSchemas = {
  experiment: {
    fetchResponse: makeFetchEventsResponseSchema(
      "experiment",
      experimentEventSchema
    ),
    insertEvent: insertExperimentEventSchema,
    insertRequest: insertExperimentEventsRequestSchema,
    feedbackItem: feedbackExperimentItemSchema,
    feedbackRequest: feedbackExperimentRequestSchema,
  },
  dataset: {
    fetchResponse: makeFetchEventsResponseSchema("dataset", datasetEventSchema),
    insertEvent: insertDatasetEventSchema,
    insertRequest: insertDatasetEventsRequestSchema,
    feedbackItem: feedbackDatasetItemSchema,
    feedbackRequest: feedbackDatasetRequestSchema,
  },
  project_logs: {
    fetchResponse: makeFetchEventsResponseSchema(
      "project",
      projectLogsEventSchema
    ),
    insertEvent: insertProjectLogsEventSchema,
    insertRequest: insertProjectLogsEventsRequestSchema,
    feedbackItem: feedbackProjectLogsItemSchema,
    feedbackRequest: feedbackProjectLogsRequestSchema,
  },
  prompt: {
    fetchResponse: undefined,
    insertEvent: undefined,
    insertRequest: undefined,
    feedbackItem: feedbackPromptItemSchema,
    feedbackRequest: feedbackPromptRequestSchema,
  },
} as const;

// Section: Cross-object operation schemas.

function makeCrossObjectIndividualRequestSchema(objectType: ObjectType) {
  const eventObjectType = getEventObjectType(objectType);
  const eventDescription = getEventObjectDescription(objectType);
  const eventObjectSchema = eventObjectSchemas[eventObjectType];
  const insertObject = z
    .object({
      ...(eventObjectSchema.insertEvent
        ? {
            events: eventObjectSchema.insertEvent
              .array()
              .nullish()
              .describe(`A list of ${eventDescription} events to insert`),
          }
        : {}),
      feedback: eventObjectSchema.feedbackItem
        .array()
        .nullish()
        .describe(`A list of ${eventDescription} feedback items`),
    })
    .strict();
  return z
    .record(z.string().uuid(), insertObject)
    .nullish()
    .describe(
      `A mapping from ${objectType} id to a set of log events and feedback items to insert`
    );
}

function makeCrossObjectIndividualResponseSchema(objectType: ObjectType) {
  return z
    .record(z.string().uuid(), insertEventsResponseSchema)
    .nullish()
    .describe(
      `A mapping from ${objectType} id to row ids for inserted \`events\``
    );
}

export const crossObjectInsertRequestSchema = z
  .object({
    experiment: makeCrossObjectIndividualRequestSchema("experiment"),
    dataset: makeCrossObjectIndividualRequestSchema("dataset"),
    project_logs: makeCrossObjectIndividualRequestSchema("project"),
    prompt: makeCrossObjectIndividualRequestSchema("prompt"),
  })
  .strict()
  .openapi("CrossObjectInsertRequest");

export const crossObjectInsertResponseSchema = z
  .object({
    experiment: makeCrossObjectIndividualResponseSchema("experiment"),
    dataset: makeCrossObjectIndividualResponseSchema("dataset"),
    project_logs: makeCrossObjectIndividualResponseSchema("project"),
    prompt: makeCrossObjectIndividualResponseSchema("prompt"),
  })
  .strict()
  .openapi("CrossObjectInsertResponse");

// Section: Summarization operations.

export const summarizeScoresParamSchema = z
  .boolean()
  .describe(
    "Whether to summarize the scores and metrics. If false (or omitted), only the metadata will be returned."
  );

export const comparisonExperimentIdParamSchema = z
  .string()
  .uuid()
  .describe(
    "The experiment to compare against, if summarizing scores and metrics. If omitted, will fall back to the `base_exp_id` stored in the experiment metadata, and then to the most recent experiment run in the same project. Must pass `summarize_scores=true` for this id to be used"
  );

export const summarizeDataParamSchema = z
  .boolean()
  .describe(
    "Whether to summarize the data. If false (or omitted), only the metadata will be returned."
  );

const summarizeExperimentResponseSchema = z
  .object({
    project_name: z
      .string()
      .describe("Name of the project that the experiment belongs to"),
    experiment_name: z.string().describe("Name of the experiment"),
    project_url: z
      .string()
      .url()
      .describe("URL to the project's page in the Braintrust app"),
    experiment_url: z
      .string()
      .url()
      .describe("URL to the experiment's page in the Braintrust app"),
    comparison_experiment_name: z
      .string()
      .nullish()
      .describe("The experiment which scores are baselined against"),
    scores: z
      .record(
        z
          .object({
            name: z.string().describe("Name of the score"),
            score: z
              .number()
              .min(0)
              .max(1)
              .describe("Average score across all examples"),
            diff: z
              .number()
              .min(-1)
              .max(1)
              .describe(
                "Difference in score between the current and comparison experiment"
              ),
            improvements: z
              .number()
              .int()
              .min(0)
              .describe("Number of improvements in the score"),
            regressions: z
              .number()
              .int()
              .min(0)
              .describe("Number of regressions in the score"),
          })
          .describe("Summary of a score's performance")
          .openapi("ScoreSummary")
      )
      .nullish()
      .describe("Summary of the experiment's scores"),
    metrics: z
      .record(
        z
          .object({
            name: z.string().describe("Name of the metric"),
            metric: z.number().describe("Average metric across all examples"),
            unit: z.string().describe("Unit label for the metric"),
            diff: z
              .number()
              .describe(
                "Difference in metric between the current and comparison experiment"
              ),
            improvements: z
              .number()
              .int()
              .min(0)
              .describe("Number of improvements in the metric"),
            regressions: z
              .number()
              .int()
              .min(0)
              .describe("Number of regressions in the metric"),
          })
          .describe("Summary of a metric's performance")
          .openapi("MetricSummary")
      )
      .nullish()
      .describe("Summary of the experiment's metrics"),
  })
  .strict()
  .describe("Summary of an experiment")
  .openapi("SummarizeExperimentResponse");

const summarizeDatasetResponseSchema = z
  .object({
    project_name: z
      .string()
      .describe("Name of the project that the dataset belongs to"),
    dataset_name: z.string().describe("Name of the dataset"),
    project_url: z
      .string()
      .url()
      .describe("URL to the project's page in the Braintrust app"),
    dataset_url: z
      .string()
      .url()
      .describe("URL to the dataset's page in the Braintrust app"),
    data_summary: z
      .object({
        total_records: z
          .number()
          .int()
          .min(0)
          .describe("Total number of records in the dataset"),
      })
      .nullish()
      .describe("Summary of a dataset's data")
      .openapi("DataSummary"),
  })
  .strict()
  .describe("Summary of a dataset")
  .openapi("SummarizeDatasetResponse");

export const objectTypeSummarizeResponseSchemas = {
  experiment: summarizeExperimentResponseSchema,
  dataset: summarizeDatasetResponseSchema,
  project: undefined,
  prompt: undefined,
} as const;
