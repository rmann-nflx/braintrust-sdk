// Type definitions for operating on the api database.

import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
extendZodWithOpenApi(z);

import { experimentSchema, datasetSchema, projectSchema } from "./app_types";
import {
  datetimeStringSchema,
  getEventObjectType,
  getEventObjectDescription,
  ObjectType,
} from "./common_types";
import { customTypes } from "./custom_types";
import { capitalize } from "../util";

import {
  TRANSACTION_ID_FIELD,
  OBJECT_DELETE_FIELD,
  IS_MERGE_FIELD,
  MERGE_PATHS_FIELD,
  PARENT_ID_FIELD,
  VALID_SOURCES,
} from "../db_fields";

import { SpanTypeAttribute } from "../span_types";

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
      .bigint()
      .describe(
        `The transaction id of an event is unique to the network operation that processed the event insertion. Transaction ids are monotonically increasing over time and can be used to retrieve a versioned snapshot of the ${eventDescription} (see the \`version\` parameter)`
      ),
    created: datetimeStringSchema
      .nullish()
      .describe(`The timestamp the ${eventDescription} event was created`),
    input: customTypes.any,
    output: customTypes.any,
    expected: customTypes.any,
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

export const maxXactIdSchema = z
  .bigint()
  .describe(
    [
      "Pagination cursor transaction ID, combined with `max_root_span_id`",
      `Given a previous fetch with a list of rows, you can determine \`max_xact_id\` as the maximum of the \`${TRANSACTION_ID_FIELD}\` field over all rows. See the documentation for \`limit\` for an overview of paginating fetch queries.`,
    ].join("\n\n")
  );

export const maxRootSpanIdSchema = z
  .string()
  .describe(
    [
      "Pagination cursor transaction root span ID, combined with `max_xact_id`",
      `Given a previous fetch with a list of rows, you can determine \`max_root_span_id\` as the maximum of the \`root_span_id\` field over all rows. See the documentation for \`limit\` for an overview of paginating fetch queries.`,
    ].join("\n\n")
  );

export const versionSchema = z
  .bigint()
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
    output: datasetEventBaseSchema.shape.output.describe(
      "The output of your application, including post-processing (an arbitrary, JSON serializable object)"
    ),
    metadata: datasetEventBaseSchema.shape.metadata,
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
    metrics: projectLogsEventBaseSchema.shape.metrics,
    context: projectLogsEventBaseSchema.shape.context,
    span_id: projectLogsEventBaseSchema.shape.span_id,
    span_parents: projectLogsEventBaseSchema.shape.span_parents,
    root_span_id: projectLogsEventBaseSchema.shape.root_span_id,
    span_attributes: projectLogsEventBaseSchema.shape.span_attributes,
  })
  .strict()
  .openapi("ProjectLogsEvent");

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

function makeInsertEventsRequestSchema<T extends z.AnyZodObject>(
  objectType: ObjectType,
  insertSchema: T
) {
  const eventDescription = getEventObjectDescription(objectType);
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
  const unionSchema = z.union([replaceVariantSchema, mergeVariantSchema]);
  return z
    .object({
      events: unionSchema
        .array()
        .describe(`A list of ${eventDescription} events to insert`),
    })
    .strict()
    .openapi(`Insert${eventSchemaName}EventRequest`);
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

const insertExperimentEventsRequestSchema = makeInsertEventsRequestSchema(
  "experiment",
  z
    .object({
      input: experimentEventSchema.shape.input,
      output: experimentEventSchema.shape.output,
      expected: experimentEventSchema.shape.expected,
      scores: experimentEventSchema.shape.scores,
      metadata: experimentEventSchema.shape.metadata,
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

const insertDatasetEventsRequestSchema = makeInsertEventsRequestSchema(
  "dataset",
  z
    .object({
      input: datasetEventSchema.shape.input,
      output: datasetEventSchema.shape.output,
      metadata: datasetEventSchema.shape.metadata,
      id: datasetEventSchema.shape.id.nullish(),
      [OBJECT_DELETE_FIELD]: datasetEventBaseSchema.shape[OBJECT_DELETE_FIELD],
    })
    .strict()
);

const insertProjectLogsEventRequestSchema = makeInsertEventsRequestSchema(
  "project",
  z
    .object({
      input: projectLogsEventSchema.shape.input,
      output: projectLogsEventSchema.shape.output,
      expected: projectLogsEventSchema.shape.expected,
      scores: projectLogsEventSchema.shape.scores,
      metadata: projectLogsEventSchema.shape.metadata,
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

function makeFeedbackEventsRequestSchema<T extends z.AnyZodObject>(
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

const feedbackEventsExperimentRequestBaseSchema =
  generateBaseEventFeedbackSchema("experiment");
const feedbackEventsExperimentRequestSchema = makeFeedbackEventsRequestSchema(
  "experiment",
  z
    .object({
      id: feedbackEventsExperimentRequestBaseSchema.shape.id,
      scores: feedbackEventsExperimentRequestBaseSchema.shape.scores,
      expected: feedbackEventsExperimentRequestBaseSchema.shape.expected,
      comment: feedbackEventsExperimentRequestBaseSchema.shape.comment,
      metadata: feedbackEventsExperimentRequestBaseSchema.shape.metadata,
      source: feedbackEventsExperimentRequestBaseSchema.shape.source,
    })
    .strict()
);

const feedbackEventsDatasetRequestBaseSchema =
  generateBaseEventFeedbackSchema("dataset");
const feedbackEventsDatasetRequestSchema = makeFeedbackEventsRequestSchema(
  "dataset",
  z
    .object({
      id: feedbackEventsDatasetRequestBaseSchema.shape.id,
      comment: feedbackEventsDatasetRequestBaseSchema.shape.comment,
      metadata: feedbackEventsDatasetRequestBaseSchema.shape.metadata,
      source: feedbackEventsDatasetRequestBaseSchema.shape.source,
    })
    .strict()
);

const feedbackEventsProjectLogsRequestBaseSchema =
  generateBaseEventFeedbackSchema("project");
const feedbackEventsProjectLogsRequestSchema = makeFeedbackEventsRequestSchema(
  "project",
  z
    .object({
      id: feedbackEventsProjectLogsRequestBaseSchema.shape.id,
      scores: feedbackEventsProjectLogsRequestBaseSchema.shape.scores,
      expected: feedbackEventsProjectLogsRequestBaseSchema.shape.expected,
      comment: feedbackEventsProjectLogsRequestBaseSchema.shape.comment,
      metadata: feedbackEventsProjectLogsRequestBaseSchema.shape.metadata,
      source: feedbackEventsProjectLogsRequestBaseSchema.shape.source,
    })
    .strict()
);

// Section: exported schemas, grouped by object type.

export const eventObjectSchemas = {
  experiment: {
    fetchResponse: makeFetchEventsResponseSchema(
      "experiment",
      experimentEventSchema
    ),
    insertRequest: insertExperimentEventsRequestSchema,
    feedbackRequest: feedbackEventsExperimentRequestSchema,
  },
  dataset: {
    fetchResponse: makeFetchEventsResponseSchema("dataset", datasetEventSchema),
    insertRequest: insertDatasetEventsRequestSchema,
    feedbackRequest: feedbackEventsDatasetRequestSchema,
  },
  project_logs: {
    fetchResponse: makeFetchEventsResponseSchema(
      "project",
      projectLogsEventSchema
    ),
    insertRequest: insertProjectLogsEventRequestSchema,
    feedbackRequest: feedbackEventsProjectLogsRequestSchema,
  },
} as const;
