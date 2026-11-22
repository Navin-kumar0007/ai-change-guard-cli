import { describe, expect, it } from "vitest";
import { buildCheck } from "../src/check.js";
import { buildReport, formatText } from "../src/report.js";
import { findSecurityIssues, type SecurityRule } from "../src/security.js";

// Fake keys are generated at run time so no key-shaped string is ever committed.
function fakeKey(prefix: string, length: number, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"): string {
  let seed = 7;
  let out = prefix;
  for (let i = 0; i < length; i++) {
    seed = (seed * 48271) % 2147483647;
    out += alphabet[seed % alphabet.length];
  }
  return out;
}

const rules = (file: string, content: string, kind: "code" | "config" = "code") =>
  findSecurityIssues(file, content, kind).map((f) => `${f.rule}@${f.line}`);
const of = (rule: SecurityRule, file: string, content: string, kind: "code" | "config" = "code") =>
  findSecurityIssues(file, content, kind).filter((f) => f.rule === rule);

describe("AI key exposure", () => {
  it("finds real-looking keys in code and example env files, masked, but not in a local .env", () => {
    const key = fakeKey("sk-proj-", 48);
    const found = of("ai-key-exposed", "app.ts", `const client = new OpenAI({ apiKey: "${key}" });`);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toBe("OpenAI key sk-p… written in the file");
    expect(JSON.stringify(found)).not.toContain(key.slice(8));
    expect(of("ai-key-exposed", ".env.example", `GEMINI_API_KEY=${fakeKey("AIza", 35)}`, "config")).toHaveLength(1);
    expect(of("ai-key-exposed", ".env.local", `OPENAI_API_KEY=${key}`, "config")).toEqual([]);
    expect(of("ai-key-exposed", ".env.production", `OPENAI_API_KEY=${key}`, "config").map((f) => f.detail)).toEqual([
      "OpenAI key sk-p… in .env.production: exposed if this file is committed (keep it git-ignored)",
    ]);
  });

  it("ignores placeholders", () => {
    const code = ['apiKey: "sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"', 'key = "sk-proj-your-key-goes-here-your-key-goes-here-your-key"', 'k = "AIza..."'].join("\n");
    expect(of("ai-key-exposed", "a.py", code)).toEqual([]);
  });

  it("flags keys sent to the browser by the build and dangerouslyAllowBrowser", () => {
    expect(rules(".env", "NEXT_PUBLIC_OPENAI_API_KEY=abc\nOPENAI_API_KEY=abc\n", "config")).toEqual(["ai-key-exposed@1"]);
    expect(rules("chat.tsx", 'import OpenAI from "openai";\nconst c = new OpenAI({ apiKey: import.meta.env.VITE_OPENAI_KEY, dangerouslyAllowBrowser: true });')).toEqual([
      "ai-key-exposed@2",
      "ai-key-exposed@2",
    ]);
  });
});

describe("model output into dangerous sinks", () => {
  it("follows the answer through variables into eval, shell, SQL and HTML", () => {
    const py = [
      "from openai import OpenAI",
      "import os, subprocess",
      "resp = client.chat.completions.create(model=m, messages=msgs)",
      "code = resp.choices[0].message.content",
      "cleaned = code.strip()",
      "exec(cleaned)",
      "subprocess.run(code, shell=True)",
      "cursor.execute(resp.choices[0].message.content)",
      "print(code)",
    ].join("\n");
    expect(of("model-output-to-sink", "agent.py", py).map((f) => [f.line, f.detail])).toEqual([
      [6, "`cleaned` (from the model's answer) goes to eval/exec"],
      [7, "`code` (from the model's answer) goes to a shell"],
      [8, "the model's answer goes to SQL"],
    ]);
    const tsx = 'import OpenAI from "openai";\nconst html = completion.choices[0].message.content;\nreturn <div dangerouslySetInnerHTML={{ __html: html }} />;';
    expect(rules("view.tsx", tsx)).toEqual(["model-output-to-sink@3"]);
  });

  it("leaves safe uses and non-AI files alone", () => {
    const safe = ["from openai import OpenAI", "text = resp.choices[0].message.content", "data = json.loads(text)", 'cursor.execute("SELECT * FROM t WHERE id = %s", (data["id"],))'].join("\n");
    expect(of("model-output-to-sink", "safe.py", safe)).toEqual([]);
    expect(of("model-output-to-sink", "util.py", "out = response.text\nexec(out)")).toEqual([]);
  });
});

describe("user input in the system prompt", () => {
  it("flags a system prompt that pastes in the user's text, not one with fixed values", () => {
    const py = ["import openai", 'SYSTEM_PROMPT = f"""You are a helpful agent for {company}.', 'The customer asked: {user_input}"""'].join("\n");
    expect(of("user-input-in-system-prompt", "bot.py", py).map((f) => f.detail)).toEqual(["{user_input} inside SYSTEM_PROMPT"]);
    const fixed = ["import openai", 'SYSTEM_PROMPT = f"""You are a helpful agent for {company}. Today is {today}."""'].join("\n");
    expect(of("user-input-in-system-prompt", "bot.py", fixed)).toEqual([]);
    const js = 'import OpenAI from "openai";\nconst messages = [{ role: "system", content: `Answer questions about ${req.body.topic} politely and briefly.` }];';
    expect(of("user-input-in-system-prompt", "api.ts", js)).toHaveLength(1);
  });
});

describe("risky agent tools", () => {
  it("flags delete/pay/send/shell tools unless the file has a confirmation step", () => {
    const tools = [
      "from openai import OpenAI",
      "tools = [",
      '  {"type": "function", "function": {"name": "delete_account", "parameters": {}}},',
      '  {"type": "function", "function": {"name": "get_weather", "parameters": {}}},',
      '  {"type": "function", "function": {"name": "sendEmail", "parameters": {}}},',
      "]",
    ].join("\n");
    expect(of("risky-agent-tool", "agent.py", tools).map((f) => [f.line, f.detail])).toEqual([
      [3, "tool delete_account"],
      [5, "tool sendEmail"],
    ]);
    expect(of("risky-agent-tool", "agent.py", `${tools}\nif not confirm_with_user(call): return`)).toEqual([]);
    const decorated = "from langchain.tools import tool\n@tool\ndef run_shell(cmd: str) -> str:\n    return ''";
    expect(rules("t.py", decorated)).toEqual(["risky-agent-tool@3"]);
  });
});

describe("unpinned MCP servers", () => {
  it("flags npx/uvx servers without an exact version", () => {
    const config = JSON.stringify(
      {
        mcpServers: {
          files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
          pinned: { command: "npx", args: ["-y", "@acme/mcp@1.4.2"] },
          latest: { command: "npx", args: ["some-mcp@latest"] },
          py: { command: "uvx", args: ["mcp-server-git"] },
          pypinned: { command: "uvx", args: ["mcp-server-fetch==0.6.2"] },
          local: { command: "node", args: ["./server.js"] },
        },
      },
      null,
      2,
    );
    expect(of("unpinned-mcp-server", ".cursor/mcp.json", config, "config").map((f) => f.detail)).toEqual([
      "files: @modelcontextprotocol/server-filesystem",
      "latest: some-mcp@latest",
      "py: mcp-server-git",
    ]);
    expect(of("unpinned-mcp-server", "gemini-extension.json", config, "config")).toHaveLength(3);
    expect(of("unpinned-mcp-server", "package.json", JSON.stringify({ dependencies: { x: "1" } }), "config")).toEqual([]);
  });
});

describe("report", () => {
  it("groups findings by rule, high severity first, and prints the fix", () => {
    const report = buildReport(
      {
        root: ".",
        filesScanned: 1,
        aiFiles: 1,
        callSites: 0,
        findings: [],
        tokenTips: [],
        security: [
          { file: ".mcp.json", line: 3, rule: "unpinned-mcp-server", detail: "x: pkg" },
          { file: "a.ts", line: 2, rule: "ai-key-exposed", detail: "OpenAI key sk-p… written in the file" },
        ],
      },
      ".",
      "2026-11-23",
    );
    expect(report.security?.map((s) => s.rule)).toEqual(["ai-key-exposed", "unpinned-mcp-server"]);
    expect(formatText(report)).toContain("HIGH  AI API key exposed in code or the browser [LLM02]\n    a.ts:2  OpenAI key sk-p… written in the file");
  });
});

describe("review fixes", () => {
  it("does not treat a plain fetch body as model output", () => {
    const code = 'import OpenAI from "openai";\nconst html = await res.text();\nel.innerHTML = html;';
    expect(of("model-output-to-sink", "page.ts", code)).toEqual([]);
    const gemini = 'import { GoogleGenerativeAI } from "@google/generative-ai";\nconst code = result.response.text();\neval(code);';
    expect(of("model-output-to-sink", "g.ts", gemini)).toHaveLength(1);
  });

  it("is not switched off by the word confirm in a tool name or a prompt", () => {
    const code = [
      "from openai import OpenAI",
      'SYSTEM = "Always confirm the address before you answer."',
      'tools = [{"type": "function", "function": {"name": "send_order_confirmation", "parameters": {}}}]',
    ].join("\n");
    expect(of("risky-agent-tool", "a.py", code).map((f) => f.detail)).toEqual(["tool send_order_confirmation"]);
    expect(of("risky-agent-tool", "a.py", `${code}\nif not await confirm(call): return`)).toEqual([]);
  });

  it("reads Python keyword tool names", () => {
    const code = "from langchain.tools import StructuredTool\ntool = StructuredTool.from_function(name=\"delete_file\", func=f)";
    expect(of("risky-agent-tool", "t.py", code).map((f) => f.detail)).toEqual(["tool delete_file"]);
  });

  it("reads JSONC MCP configs, VS Code settings, Windows runners and uvx flags", () => {
    const jsonc = '{\n  // my servers\n  "servers": {\n    "x": { "command": "npx.cmd", "args": ["-y", "some-mcp"], },\n  },\n}';
    expect(of("unpinned-mcp-server", ".vscode/mcp.json", jsonc, "config").map((f) => [f.line, f.detail])).toEqual([[4, "x: some-mcp"]]);
    const settings = '{ "editor.tabSize": 2, "mcp": { "servers": { "git": { "command": "uvx", "args": ["--python", "3.11", "mcp-server-git"] } } } }';
    expect(of("unpinned-mcp-server", ".vscode/settings.json", settings, "config").map((f) => f.detail)).toEqual(["git: mcp-server-git"]);
    const inline = JSON.stringify({ mcpServers: { a: { command: "npx -y other-mcp" }, b: { command: "C:\\tools\\npx.cmd", args: ["pinned-mcp@2.0.1"] } } });
    expect(of("unpinned-mcp-server", "mcp.json", inline, "config").map((f) => f.detail)).toEqual(["a: other-mcp"]);
    const from = JSON.stringify({ mcpServers: { f: { command: "uvx", args: ["--from", "mcp-tools==1.2.0", "mcp-tool"] } } });
    expect(of("unpinned-mcp-server", "mcp.json", from, "config")).toEqual([]);
  });

  it("fails the PR check only when the pull request changes a file with an exposed key", () => {
    const report = buildReport(
      {
        root: ".",
        filesScanned: 2,
        aiFiles: 1,
        callSites: 0,
        findings: [],
        tokenTips: [],
        security: [
          { file: "src/chat.ts", line: 2, rule: "ai-key-exposed", detail: "OpenAI key sk-p… written in the file" },
          { file: "agent.py", line: 3, rule: "risky-agent-tool", detail: "tool delete_files" },
        ],
      },
      ".",
      "2026-11-23",
    );
    const touched = buildCheck(report, ["src/chat.ts"]);
    expect(touched.conclusion).toBe("failure");
    expect(touched.title).toMatch(/^AI API key exposed in this pull request/);
    expect(buildCheck(report, ["agent.py"]).conclusion).toBe("success");
    expect(buildCheck(report, null).conclusion).toBe("success");
  });
});

