import { describe, expect, it } from "vitest";
import { findPromptsInText } from "../src/prompts.js";

describe("findPromptsInText", () => {
  it("finds a Python triple-quoted system prompt and notices JSON parsing", () => {
    const code = [
      "import json",
      "from openai import OpenAI",
      "",
      'SYSTEM_PROMPT = """',
      "    You are a support assistant for Acme.",
      "    Classify the ticket and reply as JSON with keys topic and urgency.",
      '"""',
      "",
      "def classify(ticket):",
      '    r = client.chat.completions.create(model="gpt-4o", messages=[{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": ticket}])',
      "    return json.loads(r.choices[0].message.content)",
    ].join("\n");
    expect(findPromptsInText("bot.py", code)).toEqual([
      {
        file: "bot.py",
        line: 4,
        name: "SYSTEM_PROMPT",
        text: "You are a support assistant for Acme.\nClassify the ticket and reply as JSON with keys topic and urgency.",
        json: true,
        templated: false,
        partial: false,
      },
    ]);
  });

  it("finds JS template literals, inline system messages and Anthropic system arguments", () => {
    const code = [
      'import Anthropic from "@anthropic-ai/sdk";',
      "const systemPrompt = `You write short, friendly replies",
      "to customer emails for ${company}.`;",
      'const messages = [{ role: "system", content: "You translate English product names into Hindi, keeping brand names." }];',
      'await client.messages.create({ model: "claude-sonnet-4-5", system: "You are a careful legal summarizer. Never give advice.", messages });',
    ].join("\n");
    const found = findPromptsInText("app.ts", code);
    expect(found.map((p) => [p.line, p.name, p.templated, p.json])).toEqual([
      [2, "systemPrompt", true, false],
      [4, "content", false, false],
      [5, "system", false, false],
    ]);
    expect(found[0]!.text).toBe("You write short, friendly replies\nto customer emails for ${company}.");
  });

  it("finds Gemini systemInstruction and reads escapes", () => {
    const code =
      'import { GoogleGenAI } from "@google/genai";\nconst config = { systemInstruction: "You extract orders.\\nReply with JSON only, no prose.", responseMimeType: "application/json" };';
    expect(findPromptsInText("g.ts", code)).toEqual([
      expect.objectContaining({ name: "systemInstruction", text: "You extract orders.\nReply with JSON only, no prose.", json: true }),
    ]);
  });

  it("skips user-message templates, short strings and files without an AI SDK", () => {
    const ai = ["import openai", 'prompt = f"Summarize this ticket for the support team: {ticket}"', 'system = "Be brief."'].join("\n");
    expect(findPromptsInText("a.py", ai)).toEqual([]);
    expect(findPromptsInText("b.py", 'SYSTEM_PROMPT = "You are a helpful assistant that answers billing questions."')).toEqual([]);
  });

  it("recognises the google-genai import style `from google import genai`", () => {
    const code = 'from google import genai\nSYSTEM_PROMPT = """You are the support assistant for ShopKart. Reply only with JSON."""\n';
    expect(findPromptsInText("support.py", code)).toEqual([expect.objectContaining({ name: "SYSTEM_PROMPT", line: 2 })]);
  });

  it("skips user-message variables, reads joined and raw strings, and finds quoted system keys", () => {
    const py = [
      "import anthropic",
      'USER_PROMPT = "Summarize the following support ticket in three bullet points please"',
      'SYSTEM_PROMPT = ("You are a careful assistant for Acme. "',
      '                 "Always answer in JSON with keys a and b.")',
      'PATTERN_INSTRUCTIONS = r"""Match \\d+ digits and keep \\n as written in the text."""',
      'body = {"model": "claude-x", "system": "You only answer questions about Acme invoices, politely."}',
      'PERSONA = "You are Asha, a friendly guide for new users. " + user_name',
    ].join("\n");
    const found = findPromptsInText("p.py", py);
    expect(found.map((p) => p.name)).toEqual(["SYSTEM_PROMPT", "PATTERN_INSTRUCTIONS", "system", "PERSONA"]);
    expect(found[0]).toMatchObject({ text: "You are a careful assistant for Acme. Always answer in JSON with keys a and b.", json: true, partial: false });
    expect(found[1]!.text).toBe("Match \\d+ digits and keep \\n as written in the text.");
    expect(found[3]).toMatchObject({ partial: true, json: false });
  });

  it("adds a JSON check per prompt, not per file", () => {
    const code = [
      "import json, openai",
      'CHAT_SYSTEM_PROMPT = "You are a friendly chat companion who answers in plain sentences."',
      'CLASSIFIER_SYSTEM_PROMPT = "Classify the message. Answer with JSON: {\\"label\\": ...}"',
      "label = json.loads(out)",
    ].join("\n");
    expect(findPromptsInText("two.py", code).map((p) => [p.name, p.json])).toEqual([
      ["CHAT_SYSTEM_PROMPT", false],
      ["CLASSIFIER_SYSTEM_PROMPT", true],
    ]);
  });
});
