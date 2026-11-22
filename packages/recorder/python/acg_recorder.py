"""Record your app's real AI calls for AI Change Guard.

Three lines, before your app makes AI calls:

    from acg_recorder import record
    record()            # writes ./ai-calls.jsonl

Then turn the file into a golden set:

    ai-change-guard import ai-calls.jsonl --out golden.jsonl

It wraps httpx (used by the OpenAI, Anthropic and Google Gen AI Python SDKs) and saves the JSON
request and response bodies of calls to known AI APIs. It never saves headers (where API keys
live) or the URL query (Gemini can carry ?key=), it never changes what your app sends or
receives, and a recorder error never reaches your code. Set ACG_RECORD=0 to turn it off.
"""

from __future__ import annotations

import datetime
import json
import os
import random
import re
import sys
import threading
from typing import Any, Callable, Iterable, Optional
from urllib.parse import urlsplit

__all__ = ["record"]

AI_HOSTS = {
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "openrouter.ai",
    "api.groq.com",
    "api.mistral.ai",
    "api.together.xyz",
    "api.deepseek.com",
}
AI_HOST_SUFFIXES = (".openai.azure.com", "-aiplatform.googleapis.com")
_MODEL_IN_PATH = re.compile(r"/models/([^/:]+)")

_lock = threading.Lock()
_active: Optional[Callable[[], None]] = None


def record(
    path: str = "ai-calls.jsonl",
    sample: float = 1.0,
    max_bytes: int = 20 * 1024 * 1024,
    hosts: Iterable[str] = (),
    redact: Optional[Callable[[dict], Optional[dict]]] = None,
) -> Callable[[], None]:
    """Start recording. Returns a function that stops it."""
    global _active
    if os.environ.get("ACG_RECORD") == "0":
        return lambda: None
    try:
        import httpx
    except ImportError:
        return lambda: None
    if _active is not None:
        return _active

    file = os.path.abspath(path)
    sample = min(1.0, max(0.0, sample))
    extra = {h.lower() for h in hosts}
    size = os.path.getsize(file) if os.path.exists(file) else 0
    state = {"size": size, "full": size >= max_bytes, "stopped": False}

    def is_ai_host(host: str) -> bool:
        return host in AI_HOSTS or host in extra or host.endswith(AI_HOST_SUFFIXES)

    def write(entry: dict) -> None:
        if state["full"]:
            return
        kept = redact(entry) if redact else entry
        if not kept:
            return
        data = (json.dumps(kept, ensure_ascii=False) + "\n").encode("utf-8")
        with _lock:
            if state["size"] + len(data) > max_bytes:
                if not state["full"]:
                    # stderr, never stdout: stdout may be your app's protocol (MCP servers, pipes).
                    print(f"[ai-change-guard] {file} reached its size limit; recording stopped.", file=sys.stderr)
                state["full"] = True
                return
            os.makedirs(os.path.dirname(file), exist_ok=True)
            with open(file, "ab") as f:
                f.write(data)
            state["size"] += len(data)

    def capture(request: Any, response: Any, streamed_call: bool) -> None:
        try:
            if state["stopped"] or request.method.upper() != "POST" or not is_ai_host(request.url.host.lower()):
                return
            # Calls the provider rejected (4xx/5xx) are not recorded: they would only become broken tests.
            if not response.is_success:
                return
            if random.random() >= sample:
                return
            try:
                body = json.loads(request.content)
            except Exception:
                return
            parts = urlsplit(str(request.url))
            url = f"{parts.scheme}://{parts.netloc.rpartition('@')[2]}{parts.path}"
            streamed = (
                streamed_call
                or "event-stream" in response.headers.get("content-type", "")
                or (isinstance(body, dict) and body.get("stream") is True)
                or ":stream" in parts.path
                or "alt=sse" in parts.query
            )
            answer = None
            if not streamed:
                try:
                    answer = json.loads(response.content)
                except Exception:
                    answer = None
            entry = {
                "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
                "url": url,
                "status": response.status_code,
                "request": body,
                "response": answer,
            }
            model = body.get("model") if isinstance(body, dict) else None
            if not isinstance(model, str):
                match = _MODEL_IN_PATH.search(parts.path)
                model = match.group(1) if match else None
            if model:
                entry["model"] = model
            write(entry)
        except Exception:
            pass  # Never let recording break the app.

    original_send = httpx.Client.send
    original_async_send = httpx.AsyncClient.send

    def send(self, request, *args, **kwargs):  # type: ignore[no-untyped-def]
        response = original_send(self, request, *args, **kwargs)
        capture(request, response, bool(kwargs.get("stream", False)))
        return response

    async def async_send(self, request, *args, **kwargs):  # type: ignore[no-untyped-def]
        response = await original_async_send(self, request, *args, **kwargs)
        capture(request, response, bool(kwargs.get("stream", False)))
        return response

    httpx.Client.send = send  # type: ignore[method-assign]
    httpx.AsyncClient.send = async_send  # type: ignore[method-assign]

    def stop() -> None:
        global _active
        state["stopped"] = True
        if httpx.Client.send is send:
            httpx.Client.send = original_send  # type: ignore[method-assign]
        if httpx.AsyncClient.send is async_send:
            httpx.AsyncClient.send = original_async_send  # type: ignore[method-assign]
        _active = None

    _active = stop
    return stop
