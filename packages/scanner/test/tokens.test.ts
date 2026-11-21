import { describe, expect, it } from "vitest";
import { findTokenTips } from "../src/tokens.js";

function rules(code: string, file = "app.py") {
  return findTokenTips(file, code, "code").map((t) => [t.rule, t.line]);
}

describe("findTokenTips", () => {
  it("flags an OpenAI call with no output limit, across several lines", () => {
    const code = ["r = client.chat.completions.create(", '    model="gpt-4o",', "    messages=msgs,", ")"].join("\n");
    expect(rules(code)).toEqual([["no-output-limit", 1]]);
  });

  it("accepts any of the output-limit parameter names", () => {
    expect(rules('client.chat.completions.create(model="gpt-4o", max_tokens=300)')).toEqual([]);
    expect(rules("await generateText({ model, prompt, maxOutputTokens: 200 })", "a.ts")).toEqual([]);
    expect(rules('client.responses.create(model="x", input=i, max_output_tokens=500)')).toEqual([]);
  });

  it("stays quiet when arguments are spread in, since the limit may be inside", () => {
    expect(rules("client.chat.completions.create(**params)")).toEqual([]);
  });

  it("suggests prompt caching for an Anthropic call with a system prompt", () => {
    const code = ["r = client.messages.create(", "    model=m, max_tokens=500,", "    system=SYSTEM,", "    messages=msgs)"].join("\n");
    expect(rules(code)).toEqual([["no-prompt-caching", 1]]);
  });

  it("does not suggest caching when cache_control is already used", () => {
    const code = 'SYSTEM = [{"type": "text", "text": T, "cache_control": {"type": "ephemeral"}}]\nclient.messages.create(model=m, max_tokens=5, system=SYSTEM)';
    expect(rules(code)).toEqual([]);
  });

  it("flags dates inside the system prompt", () => {
    expect(rules('system_prompt = f"Today is {datetime.now()}. You are a helpful bot."')).toEqual([["cache-breaker", 1]]);
    expect(rules("const systemPrompt = `Now: ${new Date().toISOString()}`;", "a.ts")).toEqual([["cache-breaker", 1]]);
  });

  it("flags AI calls inside a loop when no batch API is used", () => {
    const code = ["for row in rows:", "    out = client.chat.completions.create(model=m, max_tokens=50, messages=row)"].join("\n");
    expect(rules(code)).toEqual([["loop-not-batched", 2]]);
  });

  it("does not flag loops when the file already uses batches", () => {
    const code = ["# uses client.batches for nightly jobs", "for row in rows:", "    client.chat.completions.create(model=m, max_tokens=50, messages=row)"].join("\n");
    expect(rules(code)).toEqual([]);
  });

  it("does not treat a call in a new function as part of an earlier loop", () => {
    const code = ["for x in xs:", "    print(x)", "def ask(q):", "    return client.chat.completions.create(model=m, max_tokens=9, messages=q)"].join("\n");
    expect(rules(code)).toEqual([]);
  });

  it("flags JSON parsed from free text, once per file", () => {
    const code = ["a = json.loads(resp.choices[0].message.content)", "b = json.loads(other.choices[0].message.content)"].join("\n");
    expect(rules(code)).toEqual([["json-without-structured-output", 1]]);
  });

  it("does not flag JSON parsing when structured output is requested", () => {
    const code = 'r = client.chat.completions.create(model=m, max_tokens=9, response_format={"type": "json_object"})\nd = json.loads(r.choices[0].message.content)';
    expect(rules(code)).toEqual([]);
  });

  it("ignores commented-out calls", () => {
    expect(rules("# client.chat.completions.create(model='gpt-4o')")).toEqual([]);
  });

  it("ignores calls mentioned in docstrings or prose", () => {
    const code = [
      "def f():",
      '    """Prepare parameters for client.messages.create() call.',
      "    Also used by client.chat.completions.create(model=x) in docs.",
      '    """',
      "    return 1",
      "x = 'Translate an effort level into messages.stream() kwargs.'",
    ].join("\n");
    expect(rules(code)).toEqual([]);
  });

  it("does not treat non-AI JSON as AI output", () => {
    const code = [
      "body = json.loads(request.content)",
      "const message = JSON.parse(raw);",
      "apply(JSON.parse(message.data));",
    ].join("\n");
    expect(rules(code)).toEqual([]);
  });

  it("recognises AI output paths for the JSON tip", () => {
    expect(rules("d = json.loads(r.output_text)")).toEqual([["json-without-structured-output", 1]]);
    expect(rules("const d = JSON.parse(msg.content[0].text);", "a.ts")).toEqual([["json-without-structured-output", 1]]);
  });
});
