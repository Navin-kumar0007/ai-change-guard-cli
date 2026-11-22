import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importPrompts } from "../../replay/src/importer.js";
import { record, type Recorder } from "../src/index.js";

const realFetch = globalThis.fetch;
let dir: string;
let recorder: Recorder | undefined;
let fakeFetch: typeof fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acg-rec-"));
  // A fake network: answers every call with JSON, or a stream for stream requests.
  fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string" && init.body.includes('"stream":true')) {
      return new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: '{"topic":"refund"}' } }] });
  }) as typeof fetch;
  globalThis.fetch = fakeFetch;
});

afterEach(async () => {
  recorder?.stop();
  recorder = undefined;
  globalThis.fetch = realFetch;
  delete process.env.ACG_RECORD;
  await rm(dir, { recursive: true, force: true });
});

const lines = async (file: string) =>
  (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const chat = (extra: object = {}) => JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Summarize: I need a refund" }], ...extra });
const post = (url: string, body: string) => fetch(url, { method: "POST", body });
const OPENAI = "https://api.openai.com/v1/chat/completions";

describe("record", () => {
  it("writes the request and answer of an AI call, never its headers or query", async () => {
    const file = join(dir, "calls.jsonl");
    recorder = record({ file });
    const res = await fetch(`${OPENAI}?api-version=1&key=SECRET`, {
      method: "POST",
      headers: { Authorization: "Bearer sk-secret-key", "content-type": "application/json" },
      body: chat(),
    });
    // The app still gets the full answer.
    expect(await res.json()).toEqual({ choices: [{ message: { role: "assistant", content: '{"topic":"refund"}' } }] });
    await recorder.flush();

    const [entry] = await lines(file);
    expect(entry).toMatchObject({
      url: OPENAI,
      model: "gpt-4o",
      status: 200,
      request: { model: "gpt-4o", messages: [{ role: "user", content: "Summarize: I need a refund" }] },
      response: { choices: [{ message: { content: '{"topic":"refund"}' } }] },
    });
    expect(entry.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("sk-secret-key");
    expect(raw).not.toContain("SECRET");
  });

  it("turns into a golden set with ai-change-guard import", async () => {
    const file = join(dir, "calls.jsonl");
    recorder = record({ file });
    await post(OPENAI, chat());
    await recorder.flush();
    expect(importPrompts(await readFile(file, "utf8")).items).toEqual([
      { id: "log-1", messages: [{ role: "user", content: "Summarize: I need a refund" }], expect: { json: true } },
    ]);
  });

  it("reads the model from a Gemini URL and the body of a Request object", async () => {
    const file = join(dir, "calls.jsonl");
    recorder = record({ file });
    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    await fetch(new Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent", { method: "POST", body }));
    await recorder.flush();
    expect((await lines(file))[0]).toMatchObject({ model: "gemini-2.0-flash", request: { contents: [{ parts: [{ text: "hi" }] }] } });
  });

  it("records only the prompt of a streamed call, and leaves the stream to the app", async () => {
    const file = join(dir, "calls.jsonl");
    recorder = record({ file });
    const res = await post(OPENAI, chat({ stream: true }));
    expect(await res.text()).toBe("data: {}\n\n");
    await recorder.flush();
    expect((await lines(file))[0]).toMatchObject({ request: { stream: true }, response: null });
  });

  it("ignores other hosts and GET calls, but records extra hosts you name", async () => {
    const file = join(dir, "calls.jsonl");
    recorder = record({ file, hosts: ["llm.internal.example"] });
    await post("https://example.com/api", chat());
    await fetch("https://api.openai.com/v1/models");
    await post("https://llm.internal.example/v1/chat/completions", chat());
    await recorder.flush();
    expect((await lines(file)).map((l) => l.url)).toEqual(["https://llm.internal.example/v1/chat/completions"]);
  });

  it("never breaks the app: a failing redact hook or a non-JSON body is skipped", async () => {
    const file = join(dir, "calls.jsonl");
    recorder = record({
      file,
      redact: () => {
        throw new Error("boom");
      },
    });
    expect((await post(OPENAI, chat())).status).toBe(200);
    expect((await post(OPENAI, "not json")).status).toBe(200);
    await recorder.flush();
    expect(await lines(file)).toEqual([]);
  });

  it("lets you redact or drop a call", async () => {
    const file = join(dir, "calls.jsonl");
    recorder = record({
      file,
      redact: (e) => (JSON.stringify(e.request).includes("refund") ? { ...e, request: { model: "gpt-4o", messages: [{ role: "user", content: "[removed]" }] } } : null),
    });
    await post(OPENAI, chat());
    await post(OPENAI, JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "drop me" }] }));
    await recorder.flush();
    expect((await lines(file)).map((l) => l.request.messages[0].content)).toEqual(["[removed]"]);
  });

  it("stops at the size limit, never wraps fetch twice, puts fetch back, and is off with ACG_RECORD=0", async () => {
    const file = join(dir, "calls.jsonl");
    recorder = record({ file, maxBytes: 600 });
    const wrapped = globalThis.fetch;
    record({ file }); // a second record() is a no-op
    expect(globalThis.fetch).toBe(wrapped);
    for (let i = 0; i < 5; i++) await post(OPENAI, chat());
    await recorder.flush();
    expect(await lines(file)).toHaveLength(1);
    recorder.stop();
    expect(globalThis.fetch).toBe(fakeFetch);

    process.env.ACG_RECORD = "0";
    const off = join(dir, "off.jsonl");
    recorder = record({ file: off });
    expect(globalThis.fetch).toBe(fakeFetch);
    await post(OPENAI, chat());
    expect(await lines(off)).toEqual([]);
  });

  it("leaves out calls the provider rejected", async () => {
    globalThis.fetch = (async () => Response.json({ error: { message: "bad request" } }, { status: 400 })) as typeof fetch;
    const file = join(dir, "calls.jsonl");
    recorder = record({ file });
    expect((await post(OPENAI, chat())).status).toBe(400);
    await recorder.flush();
    expect(await lines(file)).toEqual([]);
  });

  it("stops recording for clients that kept the wrapped fetch", async () => {
    const file = join(dir, "calls.jsonl");
    recorder = record({ file });
    const kept = globalThis.fetch;
    recorder.stop();
    await kept(OPENAI, { method: "POST", body: chat() });
    await recorder.flush();
    expect(await lines(file)).toEqual([]);
  });

  it("never turns an aborted Request into an unhandled rejection", async () => {
    globalThis.fetch = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as typeof fetch;
    const file = join(dir, "calls.jsonl");
    recorder = record({ file });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const controller = new AbortController();
      const request = new Request(OPENAI, { method: "POST", body: chat(), signal: controller.signal });
      controller.abort();
      await expect(fetch(request)).rejects.toThrow(/aborted/);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
