import { basename } from "node:path";
import type { McpServerConfig } from "./mcp-tools.js";
import { isAiContent, type FileKind } from "./detect.js";
import { findPromptsInText } from "./prompts.js";

/**
 * AI Security Check, part A: static rules for AI-specific mistakes, with zero AI calls. Mapped to
 * the OWASP Top 10 for LLM Applications (2025) and for Agentic Applications (2026). Findings are
 * advisory: they point at a likely weakness, they never claim an app is safe.
 */
export type SecurityRule = "ai-key-exposed" | "model-output-to-sink" | "user-input-in-system-prompt" | "risky-agent-tool" | "unpinned-mcp-server";

export interface SecurityFinding {
  file: string;
  line: number;
  rule: SecurityRule;
  /** Short context. Never contains a secret: keys are cut to their first characters. */
  detail: string;
}

export const SECURITY_RULES: Record<SecurityRule, { title: string; owasp: string; severity: "high" | "medium" | "review"; why: string; fix: string }> = {
  "ai-key-exposed": {
    title: "AI API key exposed in code or the browser",
    owasp: "LLM02",
    severity: "high",
    why: "Anyone who sees the code or the web page can use the key and run up your bill; stolen AI keys are sold and abused within hours.",
    fix: "Revoke the key now, keep keys in server-side environment variables, and call the AI API from your backend only.",
  },
  "model-output-to-sink": {
    title: "Model output passed to eval, a shell, SQL or raw HTML",
    owasp: "LLM05",
    severity: "high",
    why: "Text from the model can be steered by anyone who controls the prompt or the documents it reads, so it can become code, commands or script.",
    fix: "Treat model output as untrusted input: parse it into a fixed structure, use parameterised queries, allow-list commands, and escape HTML.",
  },
  "user-input-in-system-prompt": {
    title: "User input placed inside the system prompt",
    owasp: "LLM01",
    severity: "medium",
    why: "Instructions in the system prompt carry the most weight; user text mixed in there can override your rules (prompt injection).",
    fix: "Keep the system prompt fixed and pass user text in a user message, clearly delimited.",
  },
  "risky-agent-tool": {
    title: "Agent tool that deletes, pays, sends or runs commands",
    owasp: "ASI02",
    severity: "review",
    why: "An agent tricked by injected instructions can call a high-impact tool on its own.",
    fix: "Ask a person to confirm before the tool acts (or limit what it can touch), and log every call.",
  },
  "unpinned-mcp-server": {
    title: "MCP server not pinned to a version",
    owasp: "LLM03",
    severity: "medium",
    why: "npx/uvx fetch the newest release on every start, so a hijacked release runs on your machine with your credentials.",
    fix: "Pin an exact version (package@1.2.3 or package==1.2.3) and update it on purpose.",
  },
};

// ---------- 1. AI keys ----------

const KEY_PATTERNS: { provider: string; re: RegExp }[] = [
  { provider: "Anthropic", re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{60,}/g },
  { provider: "OpenRouter", re: /\bsk-or-v1-[a-f0-9]{48,}/g },
  { provider: "OpenAI", re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/g },
  { provider: "OpenAI", re: /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/g },
  { provider: "Google AI", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { provider: "Groq", re: /\bgsk_[A-Za-z0-9]{48,}\b/g },
  { provider: "xAI", re: /\bxai-[A-Za-z0-9]{70,}\b/g },
];
const PLACEHOLDER_RE = /x{6,}|0{8,}|\.\.\.|your|example|placeholder|dummy|fake|redacted|<|>/i;
const PUBLIC_ENV_RE =
  /\b(?:NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|NUXT_PUBLIC|GATSBY|PUBLIC)_[A-Z0-9_]*(?:OPENAI|ANTHROPIC|CLAUDE|GEMINI|GOOGLE_AI|GENAI|GROQ|MISTRAL|OPENROUTER|XAI|DEEPSEEK|COHERE|PERPLEXITY)[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\b/;
const BROWSER_FLAG_RE = /\bdangerouslyAllowBrowser\s*:\s*true\b/;

/** *.local env files are git-ignored by convention; .env and .env.production are often committed. */
function isLocalEnvFile(file: string): boolean {
  return /^\.env(?:\.[\w-]+)?\.local$/.test(basename(file).toLowerCase());
}
const isEnvFile = (file: string) => /^\.env(?:\.[\w-]+)*$/.test(basename(file).toLowerCase());

/** Real keys look random; placeholders repeat characters or spell words. */
function looksReal(key: string): boolean {
  if (PLACEHOLDER_RE.test(key)) return false;
  const body = key.replace(/^[a-z]+[-_](?:[a-z]+\d*-)?/i, "");
  return new Set(body).size >= 12 && /\d/.test(body) && /[A-Za-z]/.test(body);
}

const mask = (key: string) => `${key.slice(0, 4)}…`;

// ---------- 2. model output into a dangerous sink ----------

const AI_OUTPUT_RE =
  /\bchoices\s*\[\s*\d+\s*\]\s*\.(?:message|text)\b|\boutput_text\b|\.content\s*\[\s*\d+\s*\]\s*\.text\b|\b(?:response|result|resp|res|completion|answer|output)\.text\b(?!\s*\()|\.response\.text\s*\(\s*\)/;
const ASSIGN_RE = /^\s*(?:(?:const|let|var|final)\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[\w[\]|<> ]+)?\s*=(?!=)/;
const SINKS: { name: string; re: RegExp }[] = [
  { name: "eval/exec", re: /(?<![\w.])(?:eval|exec)\s*\(|\bnew\s+Function\s*\(/ },
  { name: "a shell", re: /\bos\.system\s*\(|\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\(|\b(?:execSync|spawnSync|execFileSync)\s*\(/ },
  { name: "SQL", re: /\b(?:cursor|conn|connection|db|session)\.(?:execute|executemany|exec_driver_sql)\s*\(|\.(?:\$queryRawUnsafe|\$executeRawUnsafe)\s*\(/ },
  { name: "raw HTML", re: /\bdangerouslySetInnerHTML\b|\.(?:innerHTML|outerHTML)\s*=|\bdocument\.write\s*\(|\bv-html\b|\bmark_safe\s*\(|\bMarkup\s*\(/ },
];

// Parsing the answer into a structure is the recommended defence, so taint stops there.
const PARSED_RE = /\b(?:json\.loads|JSON\.parse|model_validate(?:_json)?|parse_obj|safeParse|\.parse)\s*\(/;

/** The first argument of the call that starts at `from` (the SQL text; later ones are bound parameters). */
function firstArgument(line: string, from: number): string {
  let depth = 0;
  for (let i = from; i < line.length; i++) {
    const c = line[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return line.slice(from, i);
      depth--;
    } else if (c === "," && depth === 0) return line.slice(from, i);
  }
  return line.slice(from);
}

const usesVar = (line: string, name: string) => new RegExp(`(?<![\\w.$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(line);

// ---------- 3. user input in the system prompt ----------

const USER_INPUT_NAME_RE =
  /^(?:user|input|query|question|message|msg|request|req|body|params|comment|feedback|search|q|text)(?:[._[\]'"]|$)|user_?input|user_?message|user_?query|user_?question|req\.(?:body|query|params)/i;

// ---------- 4. risky agent tools ----------

const TOOL_CONTEXT_RE =
  /\btools\s*[=:[]|function_declarations|functionDeclarations|input_schema|\bparameters\s*["']?\s*:|@(?:\w+\.)?tool\b|\btool\s*\(|\bFunctionTool\b|\bStructuredTool\b|@function_tool\b/;
const CONFIRMATION_RE = /confirm|approv|human_in_the_loop|humanInTheLoop|\binterrupt|needsApproval|requires?_approval|ask_user|askUser/i;
/** Test files build risky tools and fake answers on purpose; only the key rule applies there. */
const TEST_FILE_RE = /(?:^|\/)(?:tests?|__tests__|spec|e2e|fixtures?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$/i;
const RISKY_VERB_RE =
  /^(?:delete|remove|drop|destroy|purge|wipe|truncate|pay|charge|refund|transfer|withdraw|send|email|purchase|buy|cancel|run_shell|run_command|execute_command|exec|execute_sql|shell)(?:_|$)/;
const TOOL_NAME_RES = [
  /["']?name["']?\s*:\s*["']([A-Za-z][\w-]{2,60})["']/g,
  /@(?:\w+\.)?(?:tool|function_tool)(?:\([^)]*\))?\s*\n\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*tool\s*\(/g,
  /^\s*([A-Za-z_$][\w$]*)\s*:\s*tool\s*\(/gm,
  /\b(?:Tool|StructuredTool(?:\.from_function)?|FunctionTool(?:\.from_defaults)?)\s*\([^)]{0,400}?\bname\s*=\s*["']([A-Za-z][\w-]{2,60})["']/g,
];

const snake = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();

// ---------- 5. unpinned MCP servers ----------

const MCP_FILE_RE = /(?:^|\/)(?:\.?mcp|mcp_settings|claude_desktop_config|cline_mcp_settings)\.json$/i;
const RUNNERS = new Set(["npx", "bunx", "uvx", "pnpx"]);
// Runner flags that take a value, so the value is not mistaken for the package.
const FLAGS_WITH_VALUE = new Set(["--python", "-p", "--with", "--package", "--index-url", "--registry", "--cache", "-c", "--call"]);

/** The package a runner starts, and whether it names an exact version. */
function packageSpec(rawCommand: string, rawArgs: string[]): { spec: string; pinned: boolean } | null {
  // "npx -y pkg" in one string, Windows "npx.cmd" or a full path to the runner.
  const [first = "", ...inline] = rawCommand.trim().split(/\s+/);
  const command = basename(first.replace(/\\/g, "/")).replace(/\.(?:cmd|exe|ps1)$/i, "").toLowerCase();
  let rest = [...inline, ...rawArgs];
  if (command === "pnpm" && rest[0] === "dlx") rest = rest.slice(1);
  else if (!RUNNERS.has(command)) return null;
  let spec: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--from") {
      spec = rest[i + 1]; // uvx --from pkg==1.2.3 tool
      break;
    }
    if (FLAGS_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    spec = a;
    break;
  }
  if (!spec) return null;
  const version = /^@?[^@\s]+@(.+)$/.exec(spec)?.[1] ?? /==([^,\s]+)$/.exec(spec)?.[1];
  return { spec, pinned: Boolean(version && /^\d+\.\d+\.\d+[\w.+-]*$/.test(version)) };
}

function lineOf(lines: string[], needle: string): number {
  const i = lines.findIndex((l) => l.includes(needle));
  return i >= 0 ? i + 1 : 1;
}

/** VS Code and other clients write JSONC: comments and trailing commas. Strings are left intact. */
function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const m = end.exec(text);
      if (!m) return undefined;
      out += m[0];
      i += m[0].length - 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) return undefined;
      i = close + 1;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return undefined;
  }
}

const strings = (v: unknown): Record<string, string> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
    : undefined;

/** The MCP servers a config file declares (mcpServers, servers, or VS Code's "mcp": { "servers" }). */
export function parseMcpServers(file: string, content: string): McpServerConfig[] {
  const config = parseJsonc(content);
  if (config === undefined) return [];
  const root = (config ?? {}) as Record<string, unknown>;
  const servers = (root.mcpServers ?? root.servers ?? (root.mcp as Record<string, unknown> | undefined)?.servers) as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== "object") return [];
  const out: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const s = (raw ?? {}) as { command?: unknown; args?: unknown; env?: unknown; url?: unknown; serverUrl?: unknown; httpUrl?: unknown; headers?: unknown; type?: unknown };
    const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string") : [];
    const url = [s.url, s.serverUrl, s.httpUrl].find((u): u is string => typeof u === "string");
    if (typeof s.command === "string") {
      const env = strings(s.env);
      out.push({ name, file, command: s.command, args, ...(env ? { env } : {}) });
    } else if (url) {
      const headers = strings(s.headers);
      out.push({ name, file, url, args: [], ...(headers ? { headers } : {}), ...(s.type === "sse" ? { transport: "sse" as const } : {}) });
    }
  }
  return out;
}

/** Whether a file is an MCP config the scanner reads. */
export function isMcpConfig(file: string, content: string, kind: FileKind): boolean {
  const vscodeSettings = /(?:^|\/)settings\.json$/i.test(file) && content.includes('"mcp"') && content.includes('"servers"');
  return kind === "config" && (MCP_FILE_RE.test(file) || content.includes('"mcpServers"') || vscodeSettings);
}

function mcpFindings(file: string, content: string, lines: string[]): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  for (const server of parseMcpServers(file, content)) {
    if (!server.command) continue;
    const parsed = packageSpec(basename(server.command), server.args);
    if (!parsed || parsed.pinned) continue;
    out.push({ file, line: lineOf(lines, parsed.spec), rule: "unpinned-mcp-server", detail: `${server.name}: ${parsed.spec}` });
  }
  return out;
}

// ---------- all rules ----------

const COMMENT_LINE_RE = /^\s*(?:#|\/\/|\/\*|\*|--)/;

export function findSecurityIssues(file: string, content: string, kind: FileKind): SecurityFinding[] {
  const lines = content.split(/\r?\n/);
  const out: SecurityFinding[] = [];
  const add = (index: number, rule: SecurityRule, detail: string) => out.push({ file, line: index + 1, rule, detail });

  // 1. Keys: literal keys anywhere except a local .env; public env names and the browser flag everywhere.
  const localEnv = isLocalEnvFile(file);
  lines.forEach((line, i) => {
    if (!localEnv) {
      for (const { provider, re } of KEY_PATTERNS) {
        for (const m of line.matchAll(re)) {
          if (!looksReal(m[0])) continue;
          add(i, "ai-key-exposed", isEnvFile(file) ? `${provider} key ${mask(m[0])} in ${basename(file)}: exposed if this file is committed (keep it git-ignored)` : `${provider} key ${mask(m[0])} written in the file`);
        }
      }
    }
    const pub = PUBLIC_ENV_RE.exec(line);
    if (pub) add(i, "ai-key-exposed", `${pub[0]} is sent to the browser by the build`);
    if (BROWSER_FLAG_RE.test(line)) add(i, "ai-key-exposed", "dangerouslyAllowBrowser: true puts the API key in the browser");
  });

  // MCP configs: the usual file names, or any JSON with an mcpServers key (gemini-extension.json, ...).
  // MCP configs: the usual file names, any JSON with an mcpServers key (gemini-extension.json, ...),
  // and VS Code settings.json with "mcp": { "servers": ... }.
  if (isMcpConfig(file, content, kind)) out.push(...mcpFindings(file, content, lines));
  if (kind !== "code" || TEST_FILE_RE.test(file) || !isAiContent(content)) return out.sort((a, b) => a.line - b.line);

  // 2. Model output into eval, a shell, SQL or raw HTML (same line, or through a variable assigned from it).
  const fromModel = new Set<string>();
  lines.forEach((line, i) => {
    if (COMMENT_LINE_RE.test(line)) return;
    const assigned = ASSIGN_RE.exec(line)?.[1];
    const direct = AI_OUTPUT_RE.test(line);
    const rhs = line.slice(line.indexOf("=") + 1);
    if (assigned && !PARSED_RE.test(rhs) && (direct || [...fromModel].some((v) => usesVar(rhs, v)))) fromModel.add(assigned);
    for (const sink of SINKS) {
      const hit = sink.re.exec(line);
      if (!hit) continue;
      // For SQL only the query text counts: values passed as parameters are bound safely.
      const scope = sink.name === "SQL" ? firstArgument(line, hit.index + hit[0].length) : line;
      if (sink.name === "SQL" && !AI_OUTPUT_RE.test(scope) && ![...fromModel].some((v) => usesVar(scope, v))) continue;
      const via = AI_OUTPUT_RE.test(scope) ? null : [...fromModel].find((v) => usesVar(scope, v));
      if (AI_OUTPUT_RE.test(scope) || via) {
        add(i, "model-output-to-sink", `${via ? `\`${via}\` (from the model's answer)` : "the model's answer"} goes to ${sink.name}`);
        break;
      }
    }
  });

  // 3. User input inside the system prompt.
  for (const p of findPromptsInText(file, content)) {
    if (!p.templated) continue;
    const placeholders = [...p.text.matchAll(/\$\{([^}]+)\}|\{([A-Za-z_][\w.[\]'"]*)\}/g)].map((m) => (m[1] ?? m[2] ?? "").trim());
    const user = placeholders.find((name) => USER_INPUT_NAME_RE.test(name));
    if (user) add(p.line - 1, "user-input-in-system-prompt", `{${user}} inside ${p.name}`);
  }

  // 4. High-impact agent tools, when the file shows no sign of a confirmation step.
  if (TOOL_CONTEXT_RE.test(content)) {
    const risky = new Map<string, number>();
    for (const re of TOOL_NAME_RES) {
      for (const m of content.matchAll(re)) {
        const name = m[1]!;
        if (risky.has(name) || !RISKY_VERB_RE.test(snake(name))) continue;
        risky.set(name, content.slice(0, m.index + m[0].indexOf(name)).split("\n").length - 1);
      }
    }
    if (risky.size > 0) {
      // Look for a confirmation step in the code itself: string literals (prompts, tool names) and
      // the risky tools' own names (send_order_confirmation) do not count.
      let code = content.replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
      for (const name of risky.keys()) code = code.split(name).join("");
      if (!CONFIRMATION_RE.test(code)) for (const [name, index] of risky) add(index, "risky-agent-tool", `tool ${name}`);
    }
  }

  return out.sort((a, b) => a.line - b.line);
}
