import abc
import time
from typing import Any, Callable, Dict, List, Optional

from .logger import Span, start_span
from .span_types import SpanTypeAttribute
from .util import merge_dicts

X_LEGACY_CACHED_HEADER = "x-cached"
X_CACHED_HEADER = "x-bt-cached"


class NamedWrapper:
    def __init__(self, wrapped: Any):
        self.__wrapped = wrapped

    def __getattr__(self, name: str) -> Any:
        return getattr(self.__wrapped, name)


def log_headers(response: Any, span: Span):
    cached_value = response.headers.get(X_CACHED_HEADER) or response.headers.get(X_LEGACY_CACHED_HEADER)

    if cached_value:
        span.log(
            metrics={
                "cached": 1 if cached_value.lower() in ["true", "hit"] else 0,
            }
        )


class ChatCompletionWrapper:
    def __init__(self, create_fn: Optional[Callable[..., Any]], acreate_fn: Optional[Callable[..., Any]]):
        self.create_fn = create_fn
        self.acreate_fn = acreate_fn

    def create(self, *args: Any, **kwargs: Any) -> Any:
        params = self._parse_params(kwargs)
        stream = kwargs.get("stream", False)

        span = start_span(
            **merge_dicts(dict(name="Chat Completion", span_attributes={"type": SpanTypeAttribute.LLM}), params)
        )
        should_end = True

        try:
            start = time.time()
            create_response = self.create_fn(*args, **kwargs)
            if hasattr(create_response, "parse"):
                raw_response = create_response.parse()
                log_headers(create_response, span)
            else:
                raw_response = create_response
            if stream:

                def gen():
                    try:
                        first = True
                        all_results = []
                        for item in raw_response:
                            if first:
                                span.log(
                                    metrics={
                                        "time_to_first_token": time.time() - start,
                                    }
                                )
                                first = False
                            all_results.append(item if isinstance(item, dict) else item.dict())
                            yield item

                        span.log(**self._postprocess_streaming_results(all_results))
                    finally:
                        span.end()

                should_end = False
                return gen()
            else:
                log_response = raw_response if isinstance(raw_response, dict) else raw_response.dict()
                metrics = _parse_metrics_from_usage(log_response.get("usage", {}))
                metrics["time_to_first_token"] = time.time() - start
                span.log(
                    metrics=metrics,
                    output=log_response["choices"],
                )
                return raw_response
        finally:
            if should_end:
                span.end()

    async def acreate(self, *args: Any, **kwargs: Any) -> Any:
        params = self._parse_params(kwargs)
        stream = kwargs.get("stream", False)

        span = start_span(
            **merge_dicts(dict(name="Chat Completion", span_attributes={"type": SpanTypeAttribute.LLM}), params)
        )
        should_end = True

        try:
            start = time.time()
            create_response = await self.acreate_fn(*args, **kwargs)

            if hasattr(create_response, "parse"):
                raw_response = create_response.parse()
                log_headers(create_response, span)
            else:
                raw_response = create_response

            if stream:

                async def gen():
                    try:
                        first = True
                        all_results = []
                        async for item in raw_response:
                            if first:
                                span.log(
                                    metrics={
                                        "time_to_first_token": time.time() - start,
                                    }
                                )
                                first = False
                            all_results.append(item if isinstance(item, dict) else item.dict())
                            yield item

                        span.log(**self._postprocess_streaming_results(all_results))
                    finally:
                        span.end()

                should_end = False
                return gen()
            else:
                log_response = raw_response if isinstance(raw_response, dict) else raw_response.dict()
                metrics = _parse_metrics_from_usage(log_response.get("usage"))
                metrics["time_to_first_token"] = time.time() - start
                span.log(
                    metrics=metrics,
                    output=log_response["choices"],
                )
                return raw_response
        finally:
            if should_end:
                span.end()

    @classmethod
    def _parse_params(cls, params: Dict[str, Any]) -> Dict[str, Any]:
        # First, destructively remove span_info
        ret = params.pop("span_info", {})

        # Then, copy the rest of the params
        params = {**params}
        messages = params.pop("messages", None)
        return merge_dicts(
            ret,
            {
                "input": messages,
                "metadata": params,
            },
        )

    @classmethod
    def _postprocess_streaming_results(cls, all_results: List[Dict[str, Any]]) -> Dict[str, Any]:
        role = None
        content = None
        tool_calls = None
        finish_reason = None
        metrics = {}
        for result in all_results:
            if "usage" in result and result["usage"] is not None:
                metrics = _parse_metrics_from_usage(result["usage"])
            choices = result["choices"]
            if not choices:
                continue
            delta = choices[0]["delta"]
            if not delta:
                continue

            if role is None and delta.get("role") is not None:
                role = delta.get("role")

            if delta.get("finish_reason") is not None:
                finish_reason = delta.get("finish_reason")

            if delta.get("content") is not None:
                content = (content or "") + delta.get("content")
            if delta.get("tool_calls") is not None:
                if tool_calls is None:
                    tool_calls = [
                        {
                            "id": delta["tool_calls"][0]["id"],
                            "type": delta["tool_calls"][0]["type"],
                            "function": delta["tool_calls"][0]["function"],
                        }
                    ]
                else:
                    tool_calls[0]["function"]["arguments"] += delta["tool_calls"][0]["function"]["arguments"]

        return {
            "metrics": metrics,
            "output": [
                {
                    "index": 0,
                    "message": {
                        "role": role,
                        "content": content,
                        "tool_calls": tool_calls,
                    },
                    "logprobs": None,
                    "finish_reason": finish_reason,
                }
            ],
        }


class ResponseWrapper:
    def __init__(self, create_fn: Optional[Callable[..., Any]], acreate_fn: Optional[Callable[..., Any]]):
        self.create_fn = create_fn
        self.acreate_fn = acreate_fn

    def create(self, *args: Any, **kwargs: Any) -> Any:
        params = self._parse_params(kwargs)
        stream = kwargs.get("stream", False)

        span = start_span(
            **merge_dicts(dict(name="Response", span_attributes={"type": SpanTypeAttribute.LLM}), params)
        )
        should_end = True

        try:
            start = time.time()
            create_response = self.create_fn(*args, **kwargs)
            if hasattr(create_response, "parse"):
                raw_response = create_response.parse()
                log_headers(create_response, span)
            else:
                raw_response = create_response
            if stream:

                def gen():
                    try:
                        first = True
                        all_results = []
                        for item in raw_response:
                            if first:
                                span.log(
                                    metrics={
                                        "time_to_first_token": time.time() - start,
                                    }
                                )
                                first = False
                            all_results.append(item)
                            yield item

                        span.log(**self._postprocess_streaming_results(all_results))
                    finally:
                        span.end()

                should_end = False
                return gen()
            else:
                log_response = raw_response if isinstance(raw_response, dict) else raw_response.dict()
                metrics = _parse_metrics_from_usage(log_response.get("usage"))
                metrics["time_to_first_token"] = time.time() - start
                span.log(
                    metrics=metrics,
                    output=log_response["output"],
                )
                return raw_response
        finally:
            if should_end:
                span.end()

    async def acreate(self, *args: Any, **kwargs: Any) -> Any:
        params = self._parse_params(kwargs)
        stream = kwargs.get("stream", False)

        span = start_span(
            **merge_dicts(dict(name="Response", span_attributes={"type": SpanTypeAttribute.LLM}), params)
        )
        should_end = True

        try:
            start = time.time()
            create_response = await self.acreate_fn(*args, **kwargs)
            if hasattr(create_response, "parse"):
                raw_response = create_response.parse()
                log_headers(create_response, span)
            else:
                raw_response = create_response
            if stream:

                async def gen():
                    try:
                        first = True
                        all_results = []
                        async for item in raw_response:
                            if first:
                                span.log(
                                    metrics={
                                        "time_to_first_token": time.time() - start,
                                    }
                                )
                                first = False
                            all_results.append(item)
                            yield item

                        span.log(**self._postprocess_streaming_results(all_results))
                    finally:
                        span.end()

                should_end = False
                return gen()
            else:
                log_response = raw_response if isinstance(raw_response, dict) else raw_response.dict()
                span.log(
                    metrics={
                        "time_to_first_token": time.time() - start,
                        "tokens": log_response["usage"]["total_tokens"],
                        "prompt_tokens": log_response["usage"]["input_tokens"],
                        "completion_tokens": log_response["usage"]["output_tokens"],
                    },
                    output=log_response["output"],
                )
                return raw_response
        finally:
            if should_end:
                span.end()

    @classmethod
    def _parse_params(cls, params: Dict[str, Any]) -> Dict[str, Any]:
        # First, destructively remove span_info
        ret = params.pop("span_info", {})

        # Then, copy the rest of the params
        params = {**params}
        input = params.pop("input", None)
        return merge_dicts(
            ret,
            {
                "input": input,
                "metadata": params,
            },
        )

    @classmethod
    def _postprocess_streaming_results(cls, all_results: List[Any]) -> Dict[str, Any]:
        role = None
        content = None
        tool_calls = None
        finish_reason = None
        metrics = {}
        output = []
        for result in all_results:
            if hasattr(result, "usage"):
                metrics = {
                    "tokens": result.usage.total_tokens,
                    "prompt_tokens": result.usage.input_tokens,
                    "completion_tokens": result.usage.output_tokens,
                }

            if result.type == "response.output_item.added":
                output.append({"id": result.item.id, "type": result.item.type})
                continue

            if not hasattr(result, "output_index"):
                continue

            output_index = result.output_index
            current_output = output[output_index]
            if result.type == "response.output_item.done":
                current_output["status"] = result.item.status
                continue

            if result.type == "response.output_item.delta":
                current_output["delta"] = result.delta
                continue

            if hasattr(result, "content_index"):
                if "content" not in current_output:
                    current_output["content"] = []
                content_index = result.content_index
                if content_index == len(current_output["content"]):
                    current_output["content"].append({})
                current_content = current_output["content"][content_index]
                if hasattr(result, "delta") and result.delta:
                    current_content["text"] = (current_content.get("text") or "") + result.delta

                if result.type == "response.output_text.annotation.added":
                    annotation_index = result.annotation_index
                    if "annotations" not in current_content:
                        current_content["annotations"] = []
                    if annotation_index == len(current_content["annotations"]):
                        current_content["annotations"].append({})
                    current_content["annotations"][annotation_index] = result.annotation.dict()

        return {
            "metrics": metrics,
            "output": output,
        }


class BaseWrapper(abc.ABC):
    def __init__(self, create_fn: Optional[Callable[..., Any]], acreate_fn: Optional[Callable[..., Any]], name: str):
        self._create_fn = create_fn
        self._acreate_fn = acreate_fn
        self._name = name

    @abc.abstractmethod
    def process_output(self, response: Dict[str, Any], span: Span):
        """Process the API response and log relevant information to the span."""
        pass

    def create(self, *args: Any, **kwargs: Any) -> Any:
        params = self._parse_params(kwargs)

        with start_span(
            **merge_dicts(dict(name=self._name, span_attributes={"type": SpanTypeAttribute.LLM}), params)
        ) as span:
            create_response = self._create_fn(*args, **kwargs)

            if hasattr(create_response, "parse"):
                raw_response = create_response.parse()
                log_headers(create_response, span)
            else:
                raw_response = create_response

            log_response = raw_response if isinstance(raw_response, dict) else raw_response.dict()
            self.process_output(log_response, span)
            return raw_response

    async def acreate(self, *args: Any, **kwargs: Any) -> Any:
        params = self._parse_params(kwargs)

        with start_span(
            **merge_dicts(dict(name=self._name, span_attributes={"type": SpanTypeAttribute.LLM}), params)
        ) as span:
            create_response = await self._acreate_fn(*args, **kwargs)
            if hasattr(create_response, "parse"):
                raw_response = create_response.parse()
                log_headers(create_response, span)
            else:
                raw_response = create_response
            log_response = raw_response if isinstance(raw_response, dict) else raw_response.dict()
            self.process_output(log_response, span)
            return raw_response

    @classmethod
    def _parse_params(cls, params: Dict[str, Any]) -> Dict[str, Any]:
        # First, destructively remove span_info
        ret = params.pop("span_info", {})

        params = {**params}
        input = params.pop("input", None)

        return merge_dicts(
            ret,
            {
                "input": input,
                "metadata": params,
            },
        )


class EmbeddingWrapper(BaseWrapper):
    def __init__(self, create_fn: Optional[Callable[..., Any]], acreate_fn: Optional[Callable[..., Any]]):
        super().__init__(create_fn, acreate_fn, "Embedding")

    def process_output(self, response: Dict[str, Any], span: Span):
        span.log(
            metrics={
                "tokens": response["usage"]["total_tokens"],
                "prompt_tokens": response["usage"]["prompt_tokens"],
            },
            # TODO: Add a flag to control whether to log the full embedding vector,
            # possibly w/ JSON compression.
            output={"embedding_length": len(response["data"][0]["embedding"])},
        )


class ModerationWrapper(BaseWrapper):
    def __init__(self, create_fn: Optional[Callable[..., Any]], acreate_fn: Optional[Callable[..., Any]]):
        super().__init__(create_fn, acreate_fn, "Moderation")

    def process_output(self, response: Any, span: Span):
        span.log(
            output=response["results"],
        )


class ChatCompletionV0Wrapper(NamedWrapper):
    def __init__(self, chat: Any):
        self.__chat = chat
        super().__init__(chat)

    def create(self, *args: Any, **kwargs: Any) -> Any:
        return ChatCompletionWrapper(self.__chat.create, self.__chat.acreate).create(*args, **kwargs)

    async def acreate(self, *args: Any, **kwargs: Any) -> Any:
        return await ChatCompletionWrapper(self.__chat.create, self.__chat.acreate).acreate(*args, **kwargs)


class EmbeddingV0Wrapper(NamedWrapper):
    def __init__(self, embedding: Any):
        self.__embedding = embedding
        super().__init__(embedding)

    def create(self, *args: Any, **kwargs: Any) -> Any:
        return EmbeddingWrapper(self.__embedding.create, self.__embedding.acreate).create(*args, **kwargs)

    async def acreate(self, *args: Any, **kwargs: Any) -> Any:
        return await ChatCompletionWrapper(self.__embedding.create, self.__embedding.acreate).acreate(*args, **kwargs)


class ModerationV0Wrapper(NamedWrapper):
    def __init__(self, moderation: Any):
        self.__moderation = moderation
        super().__init__(moderation)

    def create(self, *args: Any, **kwargs: Any) -> Any:
        return ModerationWrapper(self.__moderation.create, self.__moderation.acreate).create(*args, **kwargs)

    async def acreate(self, *args: Any, **kwargs: Any) -> Any:
        return await ModerationWrapper(self.__moderation.create, self.__moderation.acreate).acreate(*args, **kwargs)


# This wraps 0.*.* versions of the openai module, eg https://github.com/openai/openai-python/tree/v0.28.1
class OpenAIV0Wrapper(NamedWrapper):
    def __init__(self, openai: Any):
        super().__init__(openai)
        self.ChatCompletion = ChatCompletionV0Wrapper(openai.ChatCompletion)
        self.Embedding = EmbeddingV0Wrapper(openai.Embedding)
        self.Moderation = ModerationV0Wrapper(openai.Moderation)


class CompletionsV1Wrapper(NamedWrapper):
    def __init__(self, completions: Any):
        self.__completions = completions
        super().__init__(completions)

    def create(self, *args: Any, **kwargs: Any) -> Any:
        return ChatCompletionWrapper(self.__completions.with_raw_response.create, None).create(*args, **kwargs)


class EmbeddingV1Wrapper(NamedWrapper):
    def __init__(self, embedding: Any):
        self.__embedding = embedding
        super().__init__(embedding)

    def create(self, *args: Any, **kwargs: Any) -> Any:
        return EmbeddingWrapper(self.__embedding.with_raw_response.create, None).create(*args, **kwargs)


class ModerationV1Wrapper(NamedWrapper):
    def __init__(self, moderation: Any):
        self.__moderation = moderation
        super().__init__(moderation)

    def create(self, *args: Any, **kwargs: Any) -> Any:
        return ModerationWrapper(self.__moderation.with_raw_response.create, None).create(*args, **kwargs)


class AsyncCompletionsV1Wrapper(NamedWrapper):
    def __init__(self, completions: Any):
        self.__completions = completions
        super().__init__(completions)

    async def create(self, *args: Any, **kwargs: Any) -> Any:
        return await ChatCompletionWrapper(None, self.__completions.with_raw_response.create).acreate(*args, **kwargs)


class AsyncEmbeddingV1Wrapper(NamedWrapper):
    def __init__(self, embedding: Any):
        self.__embedding = embedding
        super().__init__(embedding)

    async def create(self, *args: Any, **kwargs: Any) -> Any:
        return await EmbeddingWrapper(None, self.__embedding.with_raw_response.create).acreate(*args, **kwargs)


class AsyncModerationV1Wrapper(NamedWrapper):
    def __init__(self, moderation: Any):
        self.__moderation = moderation
        super().__init__(moderation)

    async def create(self, *args: Any, **kwargs: Any) -> Any:
        return await ModerationWrapper(None, self.__moderation.with_raw_response.create).acreate(*args, **kwargs)


class ChatV1Wrapper(NamedWrapper):
    def __init__(self, chat: Any):
        super().__init__(chat)

        import openai

        if type(chat.completions) == openai.resources.chat.completions.AsyncCompletions:
            self.completions = AsyncCompletionsV1Wrapper(chat.completions)
        else:
            self.completions = CompletionsV1Wrapper(chat.completions)


class ResponsesV1Wrapper(NamedWrapper):
    def __init__(self, responses: Any):
        self.__responses = responses
        super().__init__(responses)

    def create(self, *args: Any, **kwargs: Any) -> Any:
        return ResponseWrapper(self.__responses.with_raw_response.create, None).create(*args, **kwargs)


class AsyncResponsesV1Wrapper(NamedWrapper):
    def __init__(self, responses: Any):
        self.__responses = responses
        super().__init__(responses)

    async def create(self, *args: Any, **kwargs: Any) -> Any:
        return await ResponseWrapper(None, self.__responses.with_raw_response.create).acreate(*args, **kwargs)


class BetaCompletionsV1Wrapper(NamedWrapper):
    def __init__(self, completions: Any):
        self.__completions = completions
        super().__init__(completions)

    def parse(self, *args: Any, **kwargs: Any) -> Any:
        return ChatCompletionWrapper(self.__completions.parse, None).create(*args, **kwargs)


class AsyncBetaCompletionsV1Wrapper(NamedWrapper):
    def __init__(self, completions: Any):
        self.__completions = completions
        super().__init__(completions)

    async def parse(self, *args: Any, **kwargs: Any) -> Any:
        return await ChatCompletionWrapper(None, self.__completions.parse).acreate(*args, **kwargs)


class BetaChatV1Wrapper(NamedWrapper):
    def __init__(self, chat: Any):
        super().__init__(chat)

        import openai

        if type(chat.completions) == openai.resources.beta.chat.completions.AsyncCompletions:
            self.completions = AsyncBetaCompletionsV1Wrapper(chat.completions)
        else:
            self.completions = BetaCompletionsV1Wrapper(chat.completions)


class BetaV1Wrapper(NamedWrapper):
    def __init__(self, beta: Any):
        super().__init__(beta)
        if hasattr(beta, "chat"):
            self.chat = BetaChatV1Wrapper(beta.chat)


# This wraps 1.*.* versions of the openai module, eg https://github.com/openai/openai-python/tree/v1.1.0
class OpenAIV1Wrapper(NamedWrapper):
    def __init__(self, openai: Any):
        super().__init__(openai)
        import openai as oai

        self.chat = ChatV1Wrapper(openai.chat)

        if hasattr(openai, "beta"):
            self.beta = BetaV1Wrapper(openai.beta)

        if hasattr(openai, "responses"):
            if type(openai.responses) == oai.resources.responses.responses.AsyncResponses:
                self.responses = AsyncResponsesV1Wrapper(openai.responses)
            else:
                self.responses = ResponsesV1Wrapper(openai.responses)

        if type(openai.embeddings) == oai.resources.embeddings.AsyncEmbeddings:
            self.embeddings = AsyncEmbeddingV1Wrapper(openai.embeddings)
        else:
            self.embeddings = EmbeddingV1Wrapper(openai.embeddings)

        if type(openai.moderations) == oai.resources.moderations.AsyncModerations:
            self.moderations = AsyncModerationV1Wrapper(openai.moderations)
        else:
            self.moderations = ModerationV1Wrapper(openai.moderations)


def wrap_openai(openai: Any):
    """
    Wrap the openai module (pre v1) or OpenAI instance (post v1) to add tracing.
    If Braintrust is not configured, this is a no-op.

    :param openai: The openai module or OpenAI object
    """
    if hasattr(openai, "chat") and hasattr(openai.chat, "completions"):
        return OpenAIV1Wrapper(openai)
    else:
        return OpenAIV0Wrapper(openai)


# OpenAI's representation to Braintrust's representation
TOKEN_NAME_MAP = {
    # chat API
    "total_tokens": "tokens",
    "prompt_tokens": "prompt_tokens",
    "completion_tokens": "completion_tokens",
    # responses API
    "tokens": "tokens",
    "input_tokens": "prompt_tokens",
    "output_tokens": "completion_tokens",
}

TOKEN_PREFIX_MAP = {
    "input": "prompt",
    "output": "completion",
}


def _parse_metrics_from_usage(usage: Dict[str, Any]) -> Dict[str, Any]:
    # For simplicity, this function handles all the different APIs

    if not usage or not isinstance(usage, dict):
        return {}

    # example usage format:
    # { 'input_tokens': 14,
    # ' input_tokens_details': {'cached_tokens': 0},
    # ' output_tokens_details': {'reasoning_tokens': 0},
    # }
    # we remap names and change detail tokens to names like
    # input_cached_tokens.

    metrics = {}
    for oai_name, value in usage.items():
        if oai_name.endswith("_tokens_details"):
            # handle `_tokens_detail` dicts
            raw_prefix = oai_name[: -len("_tokens_details")]
            prefix = TOKEN_PREFIX_MAP.get(raw_prefix, raw_prefix)
            if not isinstance(value, dict):
                continue  # unexpected
            for k, v in value.items():
                if _is_numeric(v):
                    metrics[f"{prefix}_{k}"] = v
        elif _is_numeric(value):
            name = TOKEN_NAME_MAP.get(oai_name, oai_name)
            metrics[name] = value

    return metrics


def _is_numeric(v):
    return isinstance(v, (int, float, complex))
