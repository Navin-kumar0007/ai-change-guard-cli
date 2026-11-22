"""Tests for acg_recorder. Run: python -m unittest packages/recorder/python/test_acg_recorder.py (needs httpx)."""

import asyncio
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None

import acg_recorder

ANSWER = {"choices": [{"message": {"role": "assistant", "content": '{"topic":"refund"}'}}]}
CHAT = {"model": "gpt-4o", "messages": [{"role": "user", "content": "Summarize: I need a refund"}]}


def handler(request):
    try:
        body = json.loads(request.content)
    except ValueError:
        body = {}
    if isinstance(body, dict) and body.get("stream"):
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=b"data: {}\n\n")
    return httpx.Response(200, json=ANSWER)


@unittest.skipIf(httpx is None, "httpx is not installed")
class RecorderTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.file = os.path.join(self.dir.name, "calls.jsonl")
        self.stop = None
        os.environ.pop("ACG_RECORD", None)

    def tearDown(self):
        if self.stop:
            self.stop()
        os.environ.pop("ACG_RECORD", None)
        self.dir.cleanup()

    def lines(self):
        if not os.path.exists(self.file):
            return []
        with open(self.file, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def client(self):
        return httpx.Client(transport=httpx.MockTransport(handler))

    def test_records_bodies_but_never_headers_or_query(self):
        self.stop = acg_recorder.record(self.file)
        with self.client() as c:
            r = c.post(
                "https://api.openai.com/v1/chat/completions?key=SECRET",
                headers={"Authorization": "Bearer sk-secret-key"},
                json=CHAT,
            )
            self.assertEqual(r.json(), ANSWER)  # the app still gets its answer
        (entry,) = self.lines()
        self.assertEqual(entry["url"], "https://api.openai.com/v1/chat/completions")
        self.assertEqual(entry["model"], "gpt-4o")
        self.assertEqual(entry["status"], 200)
        self.assertEqual(entry["request"], CHAT)
        self.assertEqual(entry["response"], ANSWER)
        self.assertTrue(entry["recorded_at"].endswith("Z"))
        with open(self.file, encoding="utf-8") as f:
            raw = f.read()
        self.assertNotIn("sk-secret-key", raw)
        self.assertNotIn("SECRET", raw)

    def test_gemini_model_from_path_and_other_hosts_ignored(self):
        self.stop = acg_recorder.record(self.file)
        with self.client() as c:
            c.post("https://example.com/api", json=CHAT)
            c.get("https://api.openai.com/v1/models")
            c.post(
                "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
                json={"contents": [{"role": "user", "parts": [{"text": "hi"}]}]},
            )
        (entry,) = self.lines()
        self.assertEqual(entry["model"], "gemini-2.0-flash")

    def test_streamed_call_records_prompt_only(self):
        self.stop = acg_recorder.record(self.file)
        with self.client() as c:
            with c.stream("POST", "https://api.openai.com/v1/chat/completions", json={**CHAT, "stream": True}) as r:
                self.assertEqual(r.read(), b"data: {}\n\n")
        (entry,) = self.lines()
        self.assertIsNone(entry["response"])
        self.assertTrue(entry["request"]["stream"])

    def test_async_client(self):
        self.stop = acg_recorder.record(self.file)

        async def go():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
                await c.post("https://api.anthropic.com/v1/messages", json={"model": "claude-x", "messages": [{"role": "user", "content": "hi"}]})

        asyncio.run(go())
        self.assertEqual(self.lines()[0]["model"], "claude-x")

    def test_never_breaks_the_app(self):
        def boom(entry):
            raise RuntimeError("boom")

        self.stop = acg_recorder.record(self.file, redact=boom)
        with self.client() as c:
            self.assertEqual(c.post("https://api.openai.com/v1/chat/completions", json=CHAT).status_code, 200)
            self.assertEqual(c.post("https://api.openai.com/v1/chat/completions", content=b"not json").status_code, 200)
        self.assertEqual(self.lines(), [])

    def test_rejected_calls_are_left_out(self):
        self.stop = acg_recorder.record(self.file)
        t = httpx.MockTransport(lambda r: httpx.Response(429, json={"error": "rate limited"}))
        with httpx.Client(transport=t) as c:
            self.assertEqual(c.post("https://api.openai.com/v1/chat/completions", json=CHAT).status_code, 429)
        self.assertEqual(self.lines(), [])

    def test_size_warning_goes_to_stderr_not_stdout(self):
        import contextlib
        import io

        out, err = io.StringIO(), io.StringIO()
        self.stop = acg_recorder.record(self.file, max_bytes=10)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), self.client() as c:
            c.post("https://api.openai.com/v1/chat/completions", json=CHAT)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("size limit", err.getvalue())

    def test_off_switch_size_limit_and_stop(self):
        os.environ["ACG_RECORD"] = "0"
        original = httpx.Client.send
        acg_recorder.record(self.file)
        self.assertIs(httpx.Client.send, original)
        os.environ.pop("ACG_RECORD")

        self.stop = acg_recorder.record(self.file, max_bytes=600)
        self.assertIs(acg_recorder.record(self.file), self.stop)  # second call: same recorder
        with self.client() as c:
            for _ in range(5):
                c.post("https://api.openai.com/v1/chat/completions", json=CHAT)
        self.assertEqual(len(self.lines()), 1)
        self.stop()
        self.stop = None
        self.assertIs(httpx.Client.send, original)


if __name__ == "__main__":
    unittest.main()
