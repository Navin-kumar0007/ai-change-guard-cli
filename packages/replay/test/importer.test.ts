import { describe, expect, it } from "vitest";
import { parseGoldenSet } from "../src/golden.js";
import { importPrompts, sameModel } from "../src/importer.js";
import { goldenLine } from "../src/repair.js";

const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n");

describe("importPrompts", () => {
  it("reads OpenAI chat requests and takes a JSON check from the logged answer", () => {
    const log = jsonl(
      {
        id: "req_1",
        model: "gpt-4o-2024-08-06",
        messages: [
          { role: "system", content: "You classify tickets." },
          { role: "user", content: "My card was charged twice" },
        ],
        max_tokens: 100,
        temperature: 0,
      },
      { id: "req_2", model: "gpt-4o-2024-08-06", messages: [{ role: "user", content: [{ type: "text", text: "Say hi" }] }] },
    );
    const r = importPrompts(log);
    expect(r.items).toEqual([
      { id: "req_1", system: "You classify tickets.", messages: [{ role: "user", content: "My card was charged twice" }], maxTokens: 100, temperature: 0 },
      { id: "req_2", messages: [{ role: "user", content: "Say hi" }] },
    ]);
    expect(r.models).toEqual({ "gpt-4o-2024-08-06": 2 });
  });

  it("reads Helicone-style records whose bodies are JSON strings", () => {
    const log = jsonl({
      request_id: "h-1",
      request_body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Order 2 apples" }], response_format: { type: "json_object" } }),
      response_body: JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"qty": 2}' } }] }),
    });
    const [item] = importPrompts(log).items;
    expect(item).toEqual({ id: "h-1", messages: [{ role: "user", content: "Order 2 apples" }], jsonMode: true, expect: { json: true } });
  });

  it("reads a Langfuse trace download: generations with the message list as input", () => {
    const trace = {
      id: "trace-1",
      observations: [
        { id: "span-a", type: "SPAN", name: "retrieve", input: "docs please", output: "..." },
        {
          id: "gen-b",
          type: "GENERATION",
          model: "claude-3-5-sonnet-20241022",
          input: [
            { role: "system", content: "Answer in JSON." },
            { role: "user", content: "Capital of France?" },
          ],
          output: { role: "assistant", content: '```json\n{"city": "Paris"}\n```' },
        },
      ],
    };
    const r = importPrompts(JSON.stringify(trace));
    expect(r.items).toEqual([
      { id: "gen-b", system: "Answer in JSON.", messages: [{ role: "user", content: "Capital of France?" }], expect: { json: true } },
    ]);
    expect(r.models).toEqual({ "claude-3-5-sonnet-20241022": 1 });
    expect(r.skipped).toEqual({ "no prompt found in the record": 1 });
  });

  it("reads Anthropic requests with block content, top-level system and a tool call answer", () => {
    const log = jsonl({
      request: {
        model: "claude-3-5-sonnet-20241022",
        system: [{ type: "text", text: "You book flights." }],
        messages: [{ role: "user", content: [{ type: "text", text: "Book me to Delhi" }] }],
        tools: [{ name: "book_flight", description: "Books", input_schema: { type: "object", required: ["to"] } }],
        max_tokens: 300,
      },
      response: { content: [{ type: "tool_use", name: "book_flight", input: { to: "DEL" } }] },
    });
    const [item] = importPrompts(log).items;
    expect(item).toMatchObject({
      system: "You book flights.",
      messages: [{ role: "user", content: "Book me to Delhi" }],
      tools: [{ name: "book_flight", description: "Books", parameters: { type: "object", required: ["to"] } }],
      maxTokens: 300,
      expect: { tool: "book_flight" },
    });
  });

  it("reads Gemini requests with a response schema", () => {
    const log = jsonl({
      model: "gemini-2.0-flash",
      systemInstruction: { parts: [{ text: "Extract orders." }] },
      contents: [{ role: "user", parts: [{ text: "2 apples" }] }],
      generationConfig: { maxOutputTokens: 50, responseMimeType: "application/json", responseSchema: { type: "object", required: ["qty"] } },
    });
    expect(importPrompts(log).items[0]).toEqual({
      id: "log-1",
      system: "Extract orders.",
      messages: [{ role: "user", content: "2 apples" }],
      maxTokens: 50,
      jsonMode: true,
      expect: { schema: { type: "object", required: ["qty"] } },
    });
  });

  it("reads OpenTelemetry GenAI spans from an OTLP JSON export", () => {
    const attr = (key: string, value: unknown) => ({ key, value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value } });
    const otlp = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  spanId: "abc123",
                  name: "chat gpt-4o",
                  attributes: [
                    attr("gen_ai.operation.name", "chat"),
                    attr("gen_ai.request.model", "gpt-4o"),
                    attr("gen_ai.request.max_tokens", 200),
                    attr("gen_ai.system_instructions", JSON.stringify([{ type: "text", content: "You are a helpful bot" }])),
                    attr("gen_ai.input.messages", JSON.stringify([{ role: "user", parts: [{ type: "text", content: "Tell me a joke" }] }])),
                    attr("gen_ai.output.messages", JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: "Why did..." }] }])),
                  ],
                },
                { spanId: "db1", name: "SELECT", attributes: [attr("db.system", "postgresql")] },
              ],
            },
          ],
        },
      ],
    };
    const r = importPrompts(JSON.stringify(otlp));
    expect(r.items).toEqual([{ id: "abc123", system: "You are a helpful bot", messages: [{ role: "user", content: "Tell me a joke" }], maxTokens: 200 }]);
    expect(r.models).toEqual({ "gpt-4o": 1 });
  });

  it("reads older indexed OpenTelemetry attributes", () => {
    const log = jsonl({
      attributes: { "gen_ai.request.model": "gpt-4o", "gen_ai.prompt.0.role": "system", "gen_ai.prompt.0.content": "Be brief", "gen_ai.prompt.1.role": "user", "gen_ai.prompt.1.content": "Hi" },
    });
    expect(importPrompts(log).items[0]).toMatchObject({ system: "Be brief", messages: [{ role: "user", content: "Hi" }] });
  });

  it("reads OpenAI Responses requests", () => {
    const log = jsonl({ model: "gpt-5", instructions: "Be kind", input: "Hello", text: { format: { type: "json_schema", schema: { type: "object" } } } });
    expect(importPrompts(log).items[0]).toMatchObject({ system: "Be kind", messages: [{ role: "user", content: "Hello" }], jsonMode: true, expect: { schema: { type: "object" } } });
  });

  it("skips tool conversations, images, duplicates and other models, and drops a trailing answer", () => {
    const user = (content: unknown) => ({ model: "gpt-4o", messages: [{ role: "user", content }] });
    const log = [
      jsonl(
        user("Same question"),
        user("Same question"),
        user([{ type: "image_url", image_url: { url: "x" } }]),
        { model: "gpt-4o", messages: [{ role: "user", content: "a" }, { role: "assistant", content: null, tool_calls: [{ id: "1" }] }, { role: "tool", content: "r" }] },
        { model: "gpt-3.5-turbo", messages: [{ role: "user", content: "Old model" }] },
        { model: "gpt-4o", messages: [{ role: "user", content: "Q" }, { role: "assistant", content: "A" }] },
      ),
      "not json at all",
    ].join("\n");
    const r = importPrompts(log, { model: "openai/gpt-4o" });
    expect(r.items.map((i) => i.messages)).toEqual([[{ role: "user", content: "Same question" }], [{ role: "user", content: "Q" }]]);
    expect(r.skipped).toEqual({
      "lines that are not JSON": 1,
      "duplicate of an earlier prompt": 1,
      "non-text content (images, files or audio)": 1,
      "tool-call conversation": 1,
      "a different model": 1,
    });
  });

  it("spreads the limit over the whole log and keeps ids unique", () => {
    const log = jsonl(...Array.from({ length: 10 }, (_, i) => ({ id: "same", model: "m", messages: [{ role: "user", content: `q${i}` }] })));
    const r = importPrompts(log, { limit: 3 });
    expect(r.found).toBe(10);
    expect(r.items.map((i) => i.messages[0]!.content)).toEqual(["q0", "q3", "q6"]);
    expect(r.items.map((i) => i.id)).toEqual(["same", "same-4", "same-7"]);
  });

  it("writes lines that load back as a golden set", () => {
    const r = importPrompts(jsonl({ model: "gpt-4o", messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }], response_format: { type: "json_object" } }));
    expect(parseGoldenSet(r.items.map(goldenLine).join("\n"))).toEqual(r.items);
  });

  it("lower-cases Gemini schema types so the replay check can use them", () => {
    const log = jsonl({
      contents: [{ role: "user", parts: [{ text: "2 apples" }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: { qty: { type: "INTEGER" }, tags: { type: "ARRAY", items: { type: "STRING" } } } } },
    });
    expect(importPrompts(log).items[0]!.expect).toEqual({
      schema: { type: "object", properties: { qty: { type: "integer" }, tags: { type: "array", items: { type: "string" } } } },
    });
  });

  it("matches dated snapshots but not other models, and keeps logs that name no model", () => {
    expect(sameModel("gpt-4o-2024-08-06", "gpt-4o")).toBe(true);
    expect(sameModel("openai/gpt-4o", "gpt-4o")).toBe(true);
    expect(sameModel("claude-3-5-sonnet@20241022", "claude-3-5-sonnet")).toBe(true);
    expect(sameModel("gpt-4o-mini", "gpt-4o")).toBe(false);
    expect(sameModel("gpt-4o-mini-2024-07-18", "gpt-4o")).toBe(false);

    const log = jsonl(
      { model: "gpt-4o-2024-08-06", messages: [{ role: "user", content: "dated" }] },
      { model: "gpt-4o-mini", messages: [{ role: "user", content: "mini" }] },
      { contents: [{ role: "user", parts: [{ text: "gemini body without a model" }] }] },
    );
    const r = importPrompts(log, { model: "gpt-4o" });
    expect(r.items.map((i) => i.messages[0]!.content)).toEqual(["dated", "gemini body without a model"]);
    expect(r.unknownModel).toBe(1);
    expect(r.skipped).toEqual({ "a different model": 1 });
  });

  it("skips a prompt whose last message is empty, and old function_call logs as tool calls", () => {
    const log = jsonl(
      { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }, { role: "user", content: "" }] },
      { messages: [{ role: "user", content: "x" }, { role: "assistant", content: null, function_call: { name: "f", arguments: "{}" } }] },
    );
    expect(importPrompts(log).skipped).toEqual({ "empty prompt": 1, "tool-call conversation": 1 });
  });

  it("adds no tool check when the call forced a tool, and keeps the same prompt asked in two formats", () => {
    const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }];
    const answer = { choices: [{ message: { tool_calls: [{ function: { name: "lookup", arguments: "{}" } }] } }] };
    const forced = importPrompts(jsonl({ request: { messages: [{ role: "user", content: "q" }], tools, tool_choice: "required" }, response: answer })).items[0]!;
    expect(forced.expect).toBeUndefined();
    const free = importPrompts(jsonl({ request: { messages: [{ role: "user", content: "q" }], tools }, response: answer })).items[0]!;
    expect(free.expect).toEqual({ tool: "lookup" });

    const both = jsonl(
      { messages: [{ role: "user", content: "same" }] },
      { messages: [{ role: "user", content: "same" }], response_format: { type: "json_object" } },
    );
    expect(importPrompts(both).items).toHaveLength(2);
  });
});
