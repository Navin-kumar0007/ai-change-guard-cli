// Request settings that a Claude model or API version rejects with a 400 error: today, or after the next
// SDK upgrade. Static rules, zero AI calls. Sources: Anthropic's per-model migration guides and the
// 2026-10-21 API version migration guide (links in REQUEST_RULES).
import { classifyModelId, type FileKind } from "./detect.js";
import type { Dependency, Ecosystem } from "./deps.js";
import { callBlock, COMMENT_LINE_RE } from "./tokens.js";

export type RequestRule = "claude-sampling-not-accepted" | "claude-temperature-with-top-p" | "anthropic-sampling-removed";

export interface RequestFinding {
  file: string;
  line: number;
  rule: RequestRule;
  detail: string;
}

export const REQUEST_RULES: Record<RequestRule, { title: string; severity: "breaks" | "upgrade"; why: string; fix: string; source: string }> = {
  "claude-sampling-not-accepted": {
    title: "Sampling setting this Claude model rejects",
    severity: "breaks",
    why: "Claude Opus 4.7 and later, every Claude 5 model and Fable accept only the default sampling: top_p, top_k or a temperature other than 1 returns a 400 error.",
    fix: "Remove temperature, top_p and top_k from the call and steer the answer with the prompt instead.",
    source: "https://platform.claude.com/docs/en/models/opus-5-5/migration-guide",
  },
  "claude-temperature-with-top-p": {
    title: "temperature and top_p set together on Claude 4",
    severity: "breaks",
    why: "Claude 4 models return a 400 error when a request sets both temperature and top_p.",
    fix: "Keep one of them (usually temperature) and remove the other.",
    source: "https://platform.claude.com/docs/en/about-claude/models/migration-guide",
  },
  "anthropic-sampling-removed": {
    title: "Sampling setting removed in Claude API version 2026-10-21",
    severity: "upgrade",
    why: "From API version 2026-10-21, which anthropic (Python) 2.0.0, @anthropic-ai/sdk 1.0.0 and the other new SDK majors send by default, any temperature, top_p or top_k returns a 400 error, even at its default value.",
    fix: "Remove the setting before upgrading the Anthropic SDK; models that accept other values (Sonnet 4.6, Haiku 4.5) then sample with the defaults, so check those answers still work.",
    source: "https://platform.claude.com/docs/en/api/migration-2026-10-21",
  },
};

/**
 * An Anthropic Messages call (Python incl. with_raw_response / with_streaming_response, TypeScript, Go, Java),
 * but not OpenAI's Assistants threads.messages.create.
 */
const ANTHROPIC_CALL_RE =
  /(?<!threads\.)\b(?:messages\.(?:with_raw_response\.|with_streaming_response\.)?(?:create|stream|parse)|batches\.create|Messages\.New|messages\(\)\.create)\s*\(/;
const SAMPLING_RE = /(?<![\w.$])["']?(temperature|top_p|top_k|topP|topK|Temperature|TopP|TopK)["']?\s*[=:]\s*([^,\n)}]+)|\.(temperature|topP|topK)\s*\(\s*([^)\n]+)/g;
/** A value that leaves the field out of the request (or might): the SDKs' "not given" markers and conditionals that fall back to them. */
const OMITTED_RE = /\b(?:NOT_GIVEN|NotGiven|omit|undefined|None|null|nil)\b/;
const QUOTED_RE = /["'`]([^"'`\s]{4,120})["'`]/g;
/** Every string literal, in order, so each quote opens or closes exactly one string. */
const STRING_RE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const MODEL_NAME_RE = /\bmodel\s*[=:]\s*(?:[\w$]+\.)*([A-Za-z_$][\w$]*)\b/;
const TRIPLE_QUOTE_RE = /"""|'''/g;

interface ClaudeVersion {
  id: string;
  /** Accepts only the default sampling values (Claude 4.7 and later). */
  defaultsOnly: boolean;
  claude4: boolean;
}

/** What a Claude model ID says about its generation: claude-opus-4-7, claude-sonnet-4-20250514, claude-3-5-sonnet-..., claude-fable-5-2. */
export function claudeVersion(id: string): ClaudeVersion | null {
  const named = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:-(\d{1,2}))?(?:[-@]\d{8})?(?:-|$)/.exec(id);
  if (named) {
    const [major, minor] = [Number(named[2]), Number(named[3] ?? 0)];
    const newest = named[1] === "fable" || named[1] === "mythos" || major >= 5 || (major === 4 && minor >= 7);
    return { id, defaultsOnly: newest, claude4: major === 4 };
  }
  return /^claude-\d/.test(id) ? { id, defaultsOnly: false, claude4: false } : null;
}

function claudeIds(text: string): ClaudeVersion[] {
  const out: ClaudeVersion[] = [];
  for (const m of text.matchAll(QUOTED_RE)) {
    const hit = classifyModelId(m[1]!);
    const v = hit?.provider === "anthropic" ? claudeVersion(hit.id) : null;
    if (v) out.push(v);
  }
  return out;
}

/**
 * The model of a call: the Claude IDs written in it, or the one a same-file constant holds (MODEL = "claude-...").
 * With two (a conditional), the stricter one decides, since that branch is the one that fails.
 */
function modelOf(block: string, content: string): ClaudeVersion | null {
  let ids = claudeIds(block);
  if (ids.length === 0) {
    const name = MODEL_NAME_RE.exec(block)?.[1];
    if (name && name !== "model") {
      const def = new RegExp(`(?:^|[\\s,(])${name.replace(/\$/g, "\\$")}\\s*(?::\\s*[\\w\\[\\]|]+\\s*)?=\\s*(["'\`][^"'\`\\n]+["'\`])`, "m").exec(content);
      if (def) ids = claudeIds(def[1]!);
    }
  }
  return ids.find((v) => v.defaultsOnly) ?? ids.find((v) => v.claude4) ?? ids[0] ?? null;
}

const NAME: Record<string, string> = { temperature: "temperature", top_p: "top_p", top_k: "top_k", topp: "top_p", topk: "top_k" };

/** temperature=1 (or 1.0, Float(1)) is the default; anything else, including a variable, may not be. */
function isDefaultTemperature(value: string): boolean {
  return /^(?:[\w.]+\(\s*)?1(?:\.0*)?\s*\)?$/.test(value.trim());
}

/** The settings a call sends, read with comment lines dropped and prompt text blanked. */
function settingsIn(block: string): Map<string, string> {
  const code = block
    .split("\n")
    .filter((l) => !COMMENT_LINE_RE.test(l))
    .join("\n")
    // Quoted text with spaces is prompt or message text, never a field name.
    .replace(STRING_RE, (str) => (/\s/.test(str) ? '""' : str));
  const set = new Map<string, string>();
  for (const m of code.matchAll(SAMPLING_RE)) {
    const name = NAME[(m[1] ?? m[3] ?? "").toLowerCase()];
    const value = (m[2] ?? m[4] ?? "").trim();
    if (name && !set.has(name) && !OMITTED_RE.test(value)) set.set(name, value);
  }
  return set;
}

/** Call from scan.ts for AI files only. */
export function findRequestIssues(file: string, content: string, kind: FileKind): RequestFinding[] {
  if (kind !== "code" || !/anthropic/i.test(content)) return [];
  const lines = content.split(/\r?\n/);
  const out: RequestFinding[] = [];
  let inDocstring = false;
  lines.forEach((line, index) => {
    const quotes = (line.match(TRIPLE_QUOTE_RE) ?? []).length;
    const wasInDocstring = inDocstring;
    if (quotes % 2 === 1) inDocstring = !inDocstring;
    if (wasInDocstring || quotes > 0 || COMMENT_LINE_RE.test(line)) return;
    const call = ANTHROPIC_CALL_RE.exec(line);
    if (!call) return;
    const block = callBlock(lines, index, call.index + call[0].length - 1);
    const set = settingsIn(block);
    if (set.size === 0) return;
    const model = modelOf(block, content);
    const settings = [...set].map(([k, v]) => `${k}=${v.slice(0, 30)}`).join(", ");
    const add = (rule: RequestRule, detail: string) => out.push({ file, line: index + 1, rule, detail });
    const temperature = set.get("temperature");
    const nonDefault = set.has("top_p") || set.has("top_k") || (temperature !== undefined && !isDefaultTemperature(temperature));
    if (model?.defaultsOnly && nonDefault) add("claude-sampling-not-accepted", `${model.id} with ${settings}`);
    else if (model?.claude4 && set.has("temperature") && set.has("top_p")) add("claude-temperature-with-top-p", `${model.id} with ${settings}`);
    else add("anthropic-sampling-removed", model ? `${model.id} with ${settings}` : settings);
  });
  return out;
}

/** The first Anthropic SDK release that sends API version 2026-10-21 by default, per ecosystem the scanner reads. */
const NEW_VERSION_SDKS: { ecosystem: Ecosystem; name: string; major: number }[] = [
  { ecosystem: "PyPI", name: "anthropic", major: 2 },
  { ecosystem: "npm", name: "@anthropic-ai/sdk", major: 1 },
];

/** Which SDK a source file calls Claude through, by its language. */
export function ecosystemOf(file: string): Ecosystem | undefined {
  if (/\.pyi?$/.test(file)) return "PyPI";
  if (/\.(?:[cm]?[jt]sx?)$/.test(file)) return "npm";
  return undefined;
}

/** "anthropic 2.0.1 (uv.lock)" when the project pins a release for that language that already sends 2026-10-21. */
export function sdkOnNewApiVersion(deps: Dependency[], ecosystem: Ecosystem | undefined): string | undefined {
  if (!ecosystem) return undefined;
  for (const d of deps) {
    const sdk = NEW_VERSION_SDKS.find((s) => s.ecosystem === ecosystem && d.ecosystem === ecosystem && s.name === d.name.toLowerCase());
    const major = d.version ? Number(/^v?(\d+)\./.exec(d.version)?.[1]) : NaN;
    if (sdk && major >= sdk.major) return `${d.name} ${d.version} (${d.file})`;
  }
  return undefined;
}
