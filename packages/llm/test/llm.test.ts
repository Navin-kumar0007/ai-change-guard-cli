import { describe, expect, it, vi } from "vitest";
import {
  createClient,
  LlmError,
  looksLikeRefusal,
  parseModelRef,
  providerMessage,
  retryAfterMs,
  withRetry,
  type LlmClient,
} from "../src/index.js";

describe("rate-limit handling", () => {
  it("reads the wait time from a Retry-After header or Google's retryDelay", () => {
    expect(retryAfterMs("12", "")).toBe(12_000);
    const google = JSON.stringify({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }] } });
    expect(retryAfterMs(null, google)).toBe(37_000);
    expect(retryAfterMs(null, "not json")).toBeUndefined();
  });

  it("waits at least as long as the provider asks, capped at the maximum", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const client = withRetry(
      async () => {
        attempts++;
        if (attempts === 1) throw new LlmError("quota", 429, true, 37_000);
        if (attempts === 2) throw new LlmError("quota", 429, true, 600_000);
        return { text: "ok", toolCalls: [], inputTokens: 1, outputTokens: 1, latencyMs: 1, refused: false };
      },
      { baseDelayMs: 1000, maxDelayMs: 60_000, sleep: async (ms) => void delays.push(ms) },
    );
    await client({ model: "google:x", messages: [] });
    expect(delays).toEqual([37_000, 60_000]);
  });

  it("keeps only the first line of long provider messages", () => {
    const long = JSON.stringify({ error: { message: `You exceeded your current quota.\n* Quota exceeded for metric: x` } });
    expect(providerMessage(long)).toBe("You exceeded your current quota.");
    expect(providerMessage("x".repeat(500))).toHaveLength(200);
  });
});

describe("providerMessage", () => {
  it("pulls the readable message out of provider error bodies", () => {
    expect(providerMessage('{"error":{"code":404,"message":"This model is no longer available to new users."}}')).toBe(
      "This model is no longer available to new users.",
    );
    expect(providerMessage('{"error":"rate limited"}')).toBe("rate limited");
    expect(providerMessage("<html>Bad gateway</html>")).toBe("<html>Bad gateway</html>");
  });
});

function fakeFetch(responseBody: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(responseBody), { status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const body = (init: RequestInit) => JSON.parse(String(init.body));

describe("parseModelRef", () => {
  it("splits provider and model, keeping colons in the model", () => {
    expect(parseModelRef("openai:gpt-4o")).toEqual({ provider: "openai", model: "gpt-4o" });
    expect(parseModelRef("ollama:llama3.2:3b")).toEqual({ provider: "ollama", model: "llama3.2:3b" });
  });

  it.each(["gpt-4o", "nope:model", "openai:"])("rejects %s", (ref) => {
    expect(() => parseModelRef(ref)).toThrow(LlmError);
  });
});

describe("OpenAI-compatible providers", () => {
  it("sends the request and reads text, tools, tokens and the served model", async () => {
    const { fn, calls } = fakeFetch({
      model: "gpt-4o-2024-08-06",
      choices: [
        {
          finish_reason: "tool_calls",
          message: { content: "Hi", tool_calls: [{ function: { name: "lookup", arguments: '{"id":7}' } }] },
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
    const client = createClient({ env: { OPENAI_API_KEY: "test-key" }, fetch: fn });
    const res = await client({
      model: "openai:gpt-4o",
      system: "Be brief",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 50,
      jsonMode: true,
      tools: [{ name: "lookup", parameters: { type: "object" } }],
    });

    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    const sent = body(calls[0]!.init);
    expect(sent.messages[0]).toEqual({ role: "system", content: "Be brief" });
    expect(sent.max_completion_tokens).toBe(50);
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.tools[0].function.name).toBe("lookup");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer test-key");

    expect(res.text).toBe("Hi");
    expect(res.toolCalls).toEqual([{ name: "lookup", arguments: { id: 7 } }]);
    expect(res.inputTokens).toBe(12);
    expect(res.outputTokens).toBe(3);
    expect(res.servedModel).toBe("gpt-4o-2024-08-06");
    expect(res.refused).toBe(false);
  });

  it("uses max_tokens and the base-URL override for other providers", async () => {
    const { fn, calls } = fakeFetch({ choices: [{ message: { content: "ok" } }] });
    const client = createClient({ env: { OLLAMA_BASE_URL: "http://127.0.0.1:9999/v1" }, fetch: fn });
    await client({ model: "ollama:llama3.2:3b", messages: [{ role: "user", content: "x" }], maxTokens: 9 });
    expect(calls[0]?.url).toBe("http://127.0.0.1:9999/v1/chat/completions");
    expect(body(calls[0]!.init).max_tokens).toBe(9);
    expect(body(calls[0]!.init).model).toBe("llama3.2:3b");
  });

  it("reports a missing API key clearly, without calling the network", async () => {
    const { fn } = fakeFetch({});
    const client = createClient({ env: {}, fetch: fn });
    await expect(client({ model: "groq:llama", messages: [{ role: "user", content: "x" }] })).rejects.toThrow("Missing GROQ_API_KEY");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("Anthropic", () => {
  it("maps the Messages API both ways", async () => {
    const { fn, calls } = fakeFetch({
      model: "claude-sonnet-4-5-20250929",
      stop_reason: "refusal",
      content: [
        { type: "text", text: "I can't help with that." },
        { type: "tool_use", name: "search", input: { q: "x" } },
      ],
      usage: { input_tokens: 20, output_tokens: 8 },
    });
    const client = createClient({ env: { ANTHROPIC_API_KEY: "k" }, fetch: fn });
    const res = await client({
      model: "anthropic:claude-sonnet-4-5",
      system: "S",
      messages: [{ role: "user", content: "q" }],
      tools: [{ name: "search", parameters: { type: "object" } }],
    });
    const sent = body(calls[0]!.init);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent.system).toBe("S");
    expect(sent.max_tokens).toBe(1024);
    expect(sent.tools[0].input_schema).toEqual({ type: "object" });
    expect(res.toolCalls).toEqual([{ name: "search", arguments: { q: "x" } }]);
    expect(res.refused).toBe(true);
    expect(res.inputTokens).toBe(20);
  });
});

describe("Google Gemini", () => {
  it("maps generateContent both ways", async () => {
    const { fn, calls } = fakeFetch({
      modelVersion: "gemini-2.5-flash",
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{\"a\":1}" }, { functionCall: { name: "f", args: { b: 2 } } }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 },
    });
    const client = createClient({ env: { GEMINI_API_KEY: "g" }, fetch: fn });
    const res = await client({
      model: "google:gemini-2.5-flash",
      system: "S",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      jsonMode: true,
      maxTokens: 64,
    });
    const sent = body(calls[0]!.init);
    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(sent.contents[1].role).toBe("model");
    expect(sent.systemInstruction.parts[0].text).toBe("S");
    expect(sent.generationConfig).toEqual({ maxOutputTokens: 64, responseMimeType: "application/json" });
    expect(res.text).toBe('{"a":1}');
    expect(res.toolCalls).toEqual([{ name: "f", arguments: { b: 2 } }]);
    expect(res.servedModel).toBe("gemini-2.5-flash");
  });
});

describe("errors and retries", () => {
  it("marks rate limits and server errors as retryable", async () => {
    const limited = createClient({ env: { OPENAI_API_KEY: "k" }, fetch: fakeFetch({ error: "slow down" }, 429).fn });
    await expect(limited({ model: "openai:x", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ retryable: true, status: 429 });
    const bad = createClient({ env: { OPENAI_API_KEY: "k" }, fetch: fakeFetch({ error: "bad" }, 400).fn });
    await expect(bad({ model: "openai:x", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ retryable: false });
  });

  it("retries retryable errors with backoff, then succeeds", async () => {
    let attempts = 0;
    const flaky: LlmClient = async () => {
      attempts++;
      if (attempts < 3) throw new LlmError("busy", 503, true);
      return { text: "ok", toolCalls: [], inputTokens: 1, outputTokens: 1, latencyMs: 1, refused: false };
    };
    const delays: number[] = [];
    const client = withRetry(flaky, { retries: 3, baseDelayMs: 10, sleep: async (ms) => void delays.push(ms) });
    await expect(client({ model: "openai:x", messages: [] })).resolves.toMatchObject({ text: "ok" });
    expect(delays).toEqual([10, 20]);
  });

  it("does not retry non-retryable errors", async () => {
    let attempts = 0;
    const client = withRetry(async () => {
      attempts++;
      throw new LlmError("bad request", 400, false);
    }, { sleep: async () => undefined });
    await expect(client({ model: "openai:x", messages: [] })).rejects.toThrow("bad request");
    expect(attempts).toBe(1);
  });
});

describe("looksLikeRefusal", () => {
  it("spots common refusal openings only at the start", () => {
    expect(looksLikeRefusal("I'm sorry, but I can't do that.")).toBe(true);
    expect(looksLikeRefusal("Sure! Here is the answer. I can't stress this enough.")).toBe(false);
  });
});
