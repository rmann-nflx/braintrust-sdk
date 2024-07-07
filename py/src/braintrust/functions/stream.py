"""
This module provides classes and functions for handling Braintrust streams.

A Braintrust stream is a wrapper around a generator of `BraintrustStreamChunk`,
with utility methods to make them easy to log and convert into various formats.
"""

import dataclasses
import json
from itertools import tee
from typing import Generator, List, Literal, Union

from sseclient import SSEClient


@dataclasses.dataclass
class BraintrustTextChunk:
    """
    A chunk of text data from a Braintrust stream.
    """

    data: str
    type: Literal["text_delta"] = "text_delta"


@dataclasses.dataclass
class BraintrustJsonChunk:
    """
    A chunk of JSON data from a Braintrust stream.
    """

    data: str
    type: Literal["json_delta"] = "json_delta"


BraintrustStreamChunk = Union[BraintrustTextChunk, BraintrustJsonChunk]


class BraintrustStream:
    """
    A Braintrust stream. This is a wrapper around a generator of `BraintrustStreamChunk`,
    with utility methods to make them easy to log and convert into various formats.
    """

    def __init__(self, base_stream: Union[SSEClient, List[BraintrustStreamChunk]]):
        """
        Initialize a BraintrustStream.

        Args:
            base_stream: Either an SSEClient or a list of BraintrustStreamChunks.
        """
        if isinstance(base_stream, SSEClient):
            self.stream = self._parse_sse_stream(base_stream)
        else:
            self.stream = base_stream
        self._memoized_final_value = None

    def _parse_sse_stream(self, sse_client: SSEClient) -> Generator[BraintrustStreamChunk, None, None]:
        """
        Parse an SSE stream into BraintrustStreamChunks.

        Args:
            sse_client: The SSEClient to parse.

        Yields:
            BraintrustStreamChunk: Parsed chunks from the SSE stream.
        """
        for event in sse_client.events():
            if event.event == "text_delta":
                yield BraintrustTextChunk(data=json.loads(event.data))
            elif event.event == "json_delta":
                yield BraintrustJsonChunk(data=event.data)

    def copy(self):
        """
        Copy the stream. This returns a new stream that shares the same underlying
        generator (via `tee`). Since generators are consumed in Python, use `copy()` if you
        need to use the stream multiple times.

        Returns:
            BraintrustStream: A new stream that you can independently consume.
        """
        current_stream = self.stream
        self.stream, new_stream = tee(current_stream)
        return BraintrustStream(new_stream)

    def final_value(self):
        """
        Get the final value of the stream. This will return the final value of the stream
        when it is fully consumed. Multiple calls to `final_value()` will return the same value,
        so it is safe to call this multiple times.

        This function consumes the stream, so if you need to use the stream multiple
        times, you should call `copy()` first.

        Returns:
            The final value of the stream.
        """
        if self._memoized_final_value is None:
            self._memoized_final_value = parse_stream(self)
        return self._memoized_final_value

    def __iter__(self):
        """
        Iterate over the stream chunks.

        Yields:
            BraintrustStreamChunk: The next chunk in the stream.
        """
        yield from self.stream


def parse_stream(stream: BraintrustStream):
    """
    Parse a BraintrustStream into its final value.

    Args:
        stream: The BraintrustStream to parse.

    Returns:
        The final value of the stream.
    """
    text_chunks = []
    json_chunks = []

    for chunk in stream:
        if isinstance(chunk, BraintrustTextChunk):
            text_chunks.append(chunk.data)
        elif isinstance(chunk, BraintrustJsonChunk):
            json_chunks.append(chunk.data)

    if json_chunks:
        return json.loads("".join(json_chunks))
    elif text_chunks:
        return "".join(text_chunks)
    else:
        return None
