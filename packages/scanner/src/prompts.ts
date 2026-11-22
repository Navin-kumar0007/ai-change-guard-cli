import { readFile, stat } from "node:fs/promises";
import { isAiContent } from "./detect.js";
import { walk } from "./walk.js";

/**
 * Finds system prompts written in code, so a starter golden set can be generated for apps that
 * have no logs yet. It looks in files that use an AI SDK for:
 *   - variables named like a system prompt:  SYSTEM_PROMPT = """...""", const systemPrompt = `...`
 *   - system messages:                       {"role": "system", "content": "..."}
 *   - system arguments and keys:             system="...", "instructions": "...", systemInstruction: "..."
 * Strings may span lines (Python triple quotes, JS template literals) and may be joined from
 * several literals ("a" + "b", or Python's adjacent "a" "b").
 */
export interface FoundPrompt {
  file: string;
  line: number;
  /** The variable or argument it was found in. */
  name: string;
  text: string;
  /** The prompt asks for JSON, or it is the only prompt in a file that parses JSON answers. */
  json: boolean;
  /** Holds template placeholders such as {name} or ${name}, which are kept as written. */
  templated: boolean;
  /** Joined with a variable, so only the literal parts are here. */
  partial: boolean;
}

const MIN_CHARS = 30;
const MAX_CHARS = 8000;
const MAX_FILE_BYTES = 1_000_000;

const Q3 = "'''";
const OPEN = String.raw`([rRfFbBuU]{0,2})("""|` + Q3 + String.raw`|\x60|"|')`;
const STARTS = [
  // NAME = "...", NAME: str = "...", const NAME = `...`
  new RegExp(String.raw`\b((?:[A-Za-z_$][\w$]*)?(?:system|prompt|instruction|persona)[\w$]*)\s*(?::\s*[\w.\[\], |]+?)?\s*=\s*\(?\s*` + OPEN, "gi"),
  // system="...", instructions: "...", {"system": "..."}, systemInstruction: "..."
  new RegExp(String.raw`["']?\b(system|instructions|system_instruction|systemInstruction|system_prompt|systemPrompt)\b["']?\s*[:=]\s*\(?\s*` + OPEN, "g"),
  // {"role": "system", "content": "..."}
  new RegExp(String.raw`["']?role["']?\s*[:=]\s*["'](?:system|developer)["']\s*,\s*["']?(content)["']?\s*[:=]\s*` + OPEN, "g"),
];
const NEXT_LITERAL = new RegExp(String.raw`^\s*(\+)?\s*` + OPEN);
const JOINED_WITH_CODE = /^\s*\+\s*[A-Za-z_$(]/;

// USER_PROMPT, prompt_template, question_prompt ... hold the user's message, not a system prompt.
const USER_SIDE_NAME = /user|human|template|question|query|input|message/i;
const SYSTEM_NAME = /system|instruction|persona/i;

const JSON_SIGNS =
  /response_format|json_object|json_schema|responseMimeType|response_mime_type|application\/json|json\.loads\(|JSON\.parse\(|with_structured_output|zodResponseFormat/;

interface Literal {
  text: string;
  end: number;
}

/** Reads a string literal that opens at `start` (just after the quote). Raw strings keep backslashes. */
function readLiteral(content: string, start: number, quote: string, raw: boolean): Literal | null {
  const multi = quote.length === 3 || quote === "`";
  let i = start;
  let text = "";
  while (i < content.length) {
    const c = content[i]!;
    if (c === "\\" && !raw) {
      const next = content[i + 1] ?? "";
      const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "`": "`", "\n": "" };
      if (next in simple) {
        text += simple[next];
        i += 2;
      } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(content.slice(i + 2, i + 6))) {
        text += String.fromCharCode(parseInt(content.slice(i + 2, i + 6), 16));
        i += 6;
      } else {
        text += c; // unknown escape: kept as written, like Python does
        i++;
      }
      continue;
    }
    if (raw && c === "\\" && content[i + 1] === quote[0] && quote.length === 1) {
      text += c + quote;
      i += 2;
      continue;
    }
    if (content.startsWith(quote, i)) return { text, end: i + quote.length };
    if (c === "\n" && !multi) return null;
    text += c;
    i++;
  }
  return null;
}

/** Reads a literal and any literals joined to it, and tells whether code was joined in too. */
function readJoined(content: string, start: number, prefix: string, quote: string, goRaw: boolean): { text: string; partial: boolean } | null {
  const raw = (q: string, p: string) => /r/i.test(p) || (goRaw && q === "`");
  let lit = readLiteral(content, start, quote, raw(quote, prefix));
  if (!lit) return null;
  let text = lit.text;
  for (let guard = 0; guard < 50; guard++) {
    const rest = content.slice(lit.end, lit.end + 2000);
    const next = NEXT_LITERAL.exec(rest);
    if (!next) return { text, partial: JOINED_WITH_CODE.test(rest) };
    const nextLit = readLiteral(content, lit.end + next[0].length, next[3]!, raw(next[3]!, next[2]!));
    if (!nextLit) return { text, partial: false };
    text += nextLit.text;
    lit = nextLit;
  }
  return { text, partial: false };
}

/** Python and JS indent multi-line strings with the code; strip the shared indent. */
function dedent(text: string): string {
  const lines = text.replace(/^\n/, "").split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines
    .map((l) => l.slice(cut))
    .join("\n")
    .trim();
}

function lineIndex(content: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

export function findPromptsInText(file: string, content: string): FoundPrompt[] {
  if (!isAiContent(content)) return [];
  const lineAt = lineIndex(content);
  const goRaw = file.endsWith(".go");
  const found: FoundPrompt[] = [];
  const seen = new Set<number>();
  for (const re of STARTS) {
    for (const m of content.matchAll(re)) {
      const name = m[1]!;
      const prefix = m[2]!;
      const quote = m[3]!;
      const open = m.index + m[0].length;
      if (seen.has(open)) continue;
      seen.add(open);
      if (USER_SIDE_NAME.test(name) && !SYSTEM_NAME.test(name)) continue;
      const joined = readJoined(content, open, prefix, quote, goRaw);
      if (!joined) continue;
      const text = dedent(joined.text);
      if (text.length < MIN_CHARS || text.length > MAX_CHARS || !/\s/.test(text)) continue;
      const templated = /\$\{[^}]+\}|\{[A-Za-z_][\w.]*\}/.test(text);
      // `prompt = f"Summarize {text}"` is usually the user's message template, not a system prompt.
      if (templated && !/system|instruction|persona|content/i.test(name)) continue;
      found.push({ file, line: lineAt(m.index), name, text, json: false, templated, partial: joined.partial });
    }
  }
  // JSON check: the prompt asks for JSON, or it is the only prompt in a file that parses JSON.
  const fileParsesJson = JSON_SIGNS.test(content);
  for (const p of found) p.json = /\bjson\b/i.test(p.text) || (fileParsesJson && found.length === 1);
  return found.sort((a, b) => a.line - b.line);
}

/** System prompts across a folder, each text once (the first place it appears). */
export async function findPrompts(root: string): Promise<FoundPrompt[]> {
  const out: FoundPrompt[] = [];
  const texts = new Set<string>();
  for await (const file of walk(root)) {
    if (file.kind !== "code") continue;
    if ((await stat(file.path)).size > MAX_FILE_BYTES) continue;
    const content = await readFile(file.path, "utf8");
    for (const p of findPromptsInText(file.rel, content)) {
      if (texts.has(p.text)) continue;
      texts.add(p.text);
      out.push(p);
    }
  }
  return out;
}
