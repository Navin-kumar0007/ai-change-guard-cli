import type { FileKind } from "./detect.js";

export type TokenRule =
  | "no-output-limit"
  | "no-prompt-caching"
  | "cache-breaker"
  | "loop-not-batched"
  | "json-without-structured-output";

export interface TokenTip {
  file: string;
  line: number;
  rule: TokenRule;
  snippet: string;
}

export const TOKEN_RULES: Record<TokenRule, { title: string; fix: string; saving: string }> = {
  "no-output-limit": {
    title: "No output limit on the AI call",
    fix: "Set max_tokens / max_output_tokens to the longest answer you actually need.",
    saving: "Caps runaway answers; output tokens usually cost several times more than input tokens.",
  },
  "no-prompt-caching": {
    title: "System prompt sent without prompt caching (Anthropic)",
    fix: 'Add cache_control: {"type": "ephemeral"} to the fixed system prompt block.',
    saving: "Cached input is billed at a fraction of the normal input price on repeat calls (check current Anthropic pricing).",
  },
  "cache-breaker": {
    title: "Changing value inside the system prompt",
    fix: "Move dates, times and IDs out of the system prompt and into the end of the user message.",
    saving: "Keeps the prompt prefix identical so provider prompt caching can apply.",
  },
  "loop-not-batched": {
    title: "AI calls made one by one in a loop",
    fix: "If results aren't needed instantly, send the loop through the provider's Batch API.",
    saving: "Batch APIs are often around half price (confirm each provider's current discount).",
  },
  "json-without-structured-output": {
    title: "JSON parsed from free-text AI output",
    fix: "Ask for structured output (response_format / JSON schema / responseMimeType) instead of parsing text.",
    saving: "Shorter answers and fewer retries when the JSON comes back broken.",
  },
};

const CALL_RE = /\b(?:chat\.completions\.create|responses\.create|messages\.(?:create|stream)|generate_?[cC]ontent|generateText|streamText)\s*\(/;
const ANTHROPIC_CALL_RE = /\bmessages\.(?:create|stream)\s*\(/;
const OUTPUT_LIMIT_RE =
  /\b(?:max_tokens|max_completion_tokens|max_output_tokens|maxTokens|maxOutputTokens|maxCompletionTokens)\b/;
const SPREAD_RE = /\*\*\w|\.\.\.\w/;
const SYSTEM_PARAM_RE = /\bsystem\s*[=:]/;
const PROMPT_VAR_RE = /\b(?:system(?:_prompt|Prompt)?|instructions)\b\s*[=:]/;
const CHANGING_VALUE_RE = /\b(?:datetime\.(?:now|utcnow)|date\.today|time\.time|Date\.now)\s*\(|\bnew Date\s*\(|\buuid\d?\s*\(/;
const LOOP_RE = /^\s*(?:for\s|async for\s|while\s|for\s*\()|\.(?:map|forEach)\s*\(/;
const FUNCTION_START_RE = /^\s*(?:def |async def |function |class |export )/;
const JSON_PARSE_RE = /\b(?:json\.loads|JSON\.parse)\s*\(/;
const AI_OUTPUT_RE =
  /\bchoices\s*\[|\boutput_text\b|\bmessage\.content\b|\.content\s*\[\s*\d+\s*\]\s*\.text\b|\bresponse\.text\b|\bcompletion\.text\b/;
const EMPTY_ARGS_RE = /^\(\s*\)/;
const TRIPLE_QUOTE_RE = /"""|'''/g;
const STRUCTURED_RE =
  /\b(?:response_format|json_schema|responseMimeType|response_mime_type|responseSchema|response_schema|generateObject|zodResponseFormat|text_format|output_format|tool_choice)\b/;
const COMMENT_LINE_RE = /^\s*(?:#|\/\/|\/\*|\*|--)/;

function callBlock(lines: string[], start: number, column: number): string {
  let depth = 0;
  const parts: string[] = [];
  for (let i = start; i < lines.length && i < start + 40; i++) {
    const text = i === start ? (lines[i] ?? "").slice(column) : (lines[i] ?? "");
    parts.push(text);
    for (const ch of text) {
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return parts.join("\n");
      }
    }
  }
  return parts.join("\n");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function insideLoop(lines: string[], index: number, column: number): boolean {
  const line = lines[index] ?? "";
  if (LOOP_RE.test(line.slice(0, column))) return true;
  const indent = indentOf(line);
  for (let j = index - 1; j >= 0 && j >= index - 8; j--) {
    const prev = lines[j] ?? "";
    if (prev.trim() === "") continue;
    if (indentOf(prev) >= indent) continue;
    if (LOOP_RE.test(prev)) return true;
    if (FUNCTION_START_RE.test(prev)) return false;
  }
  return false;
}

export function findTokenTips(file: string, content: string, kind: FileKind): TokenTip[] {
  if (kind !== "code") return [];
  const lines = content.split(/\r?\n/);
  const tips: TokenTip[] = [];
  const usesBatch = /batch/i.test(content);
  const usesCacheControl = /cache_control|cacheControl/.test(content);
  const usesStructuredOutput = STRUCTURED_RE.test(content);
  let cacheTipGiven = false;
  let jsonTipGiven = false;
  let inDocstring = false;

  lines.forEach((line, index) => {
    const quoteCount = (line.match(TRIPLE_QUOTE_RE) ?? []).length;
    const wasInDocstring = inDocstring;
    if (quoteCount % 2 === 1) inDocstring = !inDocstring;
    if (wasInDocstring || quoteCount > 0 || COMMENT_LINE_RE.test(line)) return;
    const tip = (rule: TokenRule) => tips.push({ file, line: index + 1, rule, snippet: line.trim().slice(0, 160) });

    const call = CALL_RE.exec(line);
    if (call && !EMPTY_ARGS_RE.test(line.slice(call.index + call[0].length - 1))) {
      const column = call.index + call[0].length - 1;
      const block = callBlock(lines, index, column);
      if (!OUTPUT_LIMIT_RE.test(block) && !SPREAD_RE.test(block)) tip("no-output-limit");
      if (!usesCacheControl && !cacheTipGiven && ANTHROPIC_CALL_RE.test(line) && SYSTEM_PARAM_RE.test(block)) {
        tip("no-prompt-caching");
        cacheTipGiven = true;
      }
      if (!usesBatch && insideLoop(lines, index, call.index)) tip("loop-not-batched");
    }

    if (PROMPT_VAR_RE.test(line) && CHANGING_VALUE_RE.test(line)) tip("cache-breaker");

    if (!usesStructuredOutput && !jsonTipGiven && JSON_PARSE_RE.test(line) && AI_OUTPUT_RE.test(line)) {
      tip("json-without-structured-output");
      jsonTipGiven = true;
    }
  });

  return tips;
}
