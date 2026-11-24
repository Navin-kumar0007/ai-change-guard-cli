import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findPromptsInText, planPromptEdit, rewritePromptLiteral } from "../src/prompts.js";

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
        literal: { start: expect.any(Number), end: expect.any(Number), quote: '"""', prefix: "" },
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

describe("rewritePromptLiteral (Verified Prompt Slimming writes the shorter prompt back)", () => {
  const one = (file: string, code: string) => findPromptsInText(file, code)[0]!;
  const rewrite = (file: string, code: string, text: string) => rewritePromptLiteral(code, one(file, code), text);

  it("keeps a Python triple-quoted prompt's layout and indent", () => {
    const code = ["from openai import OpenAI", "", "def run():", '    SYSTEM_PROMPT = """', "        You are a support assistant for Acme. Always be polite.", "        Reply as JSON with keys topic and urgency.", '    """', "    return SYSTEM_PROMPT"].join("\n");
    const r = rewrite("bot.py", code, "Support assistant for Acme.\nReply JSON: topic, urgency.");
    expect(r).toEqual({ content: code.replace("        You are a support assistant for Acme. Always be polite.\n        Reply as JSON with keys topic and urgency.", "        Support assistant for Acme.\n        Reply JSON: topic, urgency.") });
  });

  it("escapes a quote in a one-line string, and keeps a template literal's placeholders", () => {
    const py = 'from openai import OpenAI\nsystem_prompt = "You are a helpful assistant who answers questions about Acme orders."\n';
    const r1 = rewrite("a.py", py, 'Answer "Acme" order questions.\nBe brief.');
    expect("content" in r1 && r1.content).toContain('system_prompt = "Answer \\"Acme\\" order questions.\\nBe brief."');
    const js = "import OpenAI from 'openai';\nconst systemPrompt = `You help ${user.name} with their Acme orders, kindly and in detail, always.`;\n";
    const r2 = rewrite("a.ts", js, "Help ${user.name} with Acme `orders`.");
    expect("content" in r2 && r2.content).toContain("const systemPrompt = `Help ${user.name} with Acme \\`orders\\`.`;");
  });

  it("leaves joined, escaped or raw strings to a person", () => {
    const joined = 'from openai import OpenAI\nSYSTEM_PROMPT = "You are a helpful assistant for Acme. " + "Reply as JSON with keys a and b."\n';
    expect(rewrite("a.py", joined, "Short prompt for Acme, reply JSON.")).toEqual({ reason: expect.stringMatching(/joined/) });
    const escaped = 'from openai import OpenAI\nSYSTEM_PROMPT = "You are a helpful assistant.\\nReply as JSON with keys a and b."\n';
    expect(rewrite("a.py", escaped, "Reply JSON with keys a and b.")).toEqual({ reason: expect.stringMatching(/escape sequences/) });
    const raw = 'from openai import OpenAI\nSYSTEM_PROMPT = r"You are a helpful assistant for Acme orders, reply as JSON."\n';
    expect(rewrite("a.py", raw, "Acme orders.\nReply JSON.")).toEqual({ reason: expect.stringMatching(/raw string/) });
  });

  it("writes CR and backslashes safely, and a short prompt too", () => {
    const ts = 'import OpenAI from "openai";\nconst systemPrompt = "You are a helpful assistant for Acme orders, reply in JSON.";\n';
    const r1 = rewrite("a.ts", ts, "Acme orders.\rReply JSON.");
    expect("content" in r1 && r1.content).toContain('const systemPrompt = "Acme orders.\\nReply JSON.";');
    const r2 = rewrite("a.ts", ts, "Acme orders. Reply JSON."); // under the finder's 30 characters
    expect("content" in r2 && r2.content).toContain('const systemPrompt = "Acme orders. Reply JSON.";');
    const py = 'from openai import OpenAI\nSYSTEM_PROMPT = """You are a helpful assistant for Acme orders.\nReply in JSON."""\n';
    const r3 = rewrite("a.py", py, "Acme orders: use \\n between items.");
    expect("content" in r3 && r3.content).toContain('SYSTEM_PROMPT = """Acme orders: use \\\\n between items."""');
  });

  it("finds an indented prompt recorded from traffic, with its indent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acg-slim-"));
    try {
      const code = ["from openai import OpenAI", "def run():", '    SYSTEM_PROMPT = """', "        You are a support assistant for Acme.", "        Reply as JSON with keys topic and urgency.", '    """'].join("\n");
      await writeFile(join(dir, "bot.py"), code);
      const recorded = "\n        You are a support assistant for Acme.\n        Reply as JSON with keys topic and urgency.\n    ";
      const plan = await planPromptEdit(dir, recorded, "Acme support. Reply JSON: topic, urgency.");
      expect(plan.edits).toEqual([{ file: "bot.py", line: 3 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("plans the edit across a folder and reports places it can't change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acg-slim-"));
    try {
      const prompt = "You are a helpful assistant for Acme. Reply as JSON with keys a and b.";
      await writeFile(join(dir, "bot.py"), `from openai import OpenAI\nSYSTEM_PROMPT = "${prompt}"\n`);
      await writeFile(join(dir, "other.py"), `from openai import OpenAI\nSYSTEM_PROMPT = "You are a helpful assistant for Acme. " + "Reply as JSON with keys a and b."\n`);
      const plan = await planPromptEdit(dir, prompt, "Acme assistant. Reply JSON with keys a and b.");
      expect(plan.edits).toEqual([{ file: "bot.py", line: 2 }]);
      expect(plan.skipped).toEqual([{ file: "other.py", line: 2, reason: expect.stringMatching(/joined/) }]);
      expect(plan.files.get("bot.py")).toContain('SYSTEM_PROMPT = "Acme assistant. Reply JSON with keys a and b."');
      expect(await readFile(join(dir, "bot.py"), "utf8")).toContain(prompt); // planning never writes
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
