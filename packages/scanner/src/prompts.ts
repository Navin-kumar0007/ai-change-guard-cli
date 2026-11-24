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
  /** Where the prompt is written, when it is one string literal (not joined), so it can be rewritten in place. */
  literal?: { start: number; end: number; quote: string; prefix: string };
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
function readJoined(content: string, start: number, prefix: string, quote: string, goRaw: boolean): { text: string; partial: boolean; pieces: number; end: number } | null {
  const raw = (q: string, p: string) => /r/i.test(p) || (goRaw && q === "`");
  let lit = readLiteral(content, start, quote, raw(quote, prefix));
  if (!lit) return null;
  let text = lit.text;
  let pieces = 1;
  for (let guard = 0; guard < 50; guard++) {
    const rest = content.slice(lit.end, lit.end + 2000);
    const next = NEXT_LITERAL.exec(rest);
    if (!next) return { text, partial: JOINED_WITH_CODE.test(rest), pieces, end: lit.end };
    const nextLit = readLiteral(content, lit.end + next[0].length, next[3]!, raw(next[3]!, next[2]!));
    if (!nextLit) return { text, partial: false, pieces, end: lit.end };
    text += nextLit.text;
    lit = nextLit;
    pieces++;
  }
  return { text, partial: false, pieces, end: lit.end };
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
      const prompt: FoundPrompt = { file, line: lineAt(m.index), name, text, json: false, templated, partial: joined.partial };
      if (joined.pieces === 1 && !joined.partial) prompt.literal = { start: open, end: joined.end, quote, prefix };
      found.push(prompt);
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

// ---------- Rewriting a prompt in place (Verified Prompt Slimming) ----------

/** A system prompt rewritten in the code: every place the old text is written, changed or skipped with the reason. */
export interface PromptEditPlan {
  edits: { file: string; line: number }[];
  skipped: { file: string; line: number; reason: string }[];
  /** New full contents of every file that changes, keyed by path relative to the folder. */
  files: Map<string, string>;
}

const BY_HAND = "change it by hand";

/**
 * The file with `prompt` (found in it by findPromptsInText) replaced by `text`, written in the same kind of
 * string literal with the same indent, or the reason it can't be done safely. Only plain literals are
 * rewritten: a prompt joined from pieces, or written with escape sequences, is left for a person.
 */
export function rewritePromptLiteral(content: string, prompt: FoundPrompt, text: string): { content: string } | { reason: string } {
  const lit = prompt.literal;
  if (!lit) return { reason: `it is joined from several strings or with code; ${BY_HAND}` };
  const inner = content.slice(lit.start, lit.end - lit.quote.length);
  if (inner.includes("\\")) return { reason: `it is written with escape sequences; ${BY_HAND}` };
  if (dedent(inner) !== prompt.text) return { reason: `the code changed since it was read; run again` };
  // One kind of line break: a lone CR would end a one-line string, and Python reads CR in a file as a newline.
  const next = text.replace(/\r\n?/g, "\n").trim();
  const isRaw = /r/i.test(lit.prefix) || (prompt.file.endsWith(".go") && lit.quote === "`");
  const multi = lit.quote.length === 3 || lit.quote === "`";
  const fString = /f/i.test(lit.prefix);
  if (fString && /[{}]/.test(next.replace(/\{\{[^{}]*\}\}|\{[A-Za-z_][\w.]*\}/g, ""))) return { reason: `an f-string, and the new text has braces that are not placeholders; ${BY_HAND}` };

  let body: string;
  if (multi) {
    if (lit.quote.length === 3 && next.includes(lit.quote)) return { reason: `the new text contains ${lit.quote}; ${BY_HAND}` };
    const goRaw = prompt.file.endsWith(".go") && lit.quote === "`";
    if (goRaw && next.includes("`")) return { reason: `the new text contains a backtick, which a Go raw string can't hold; ${BY_HAND}` };
    // Backslashes are doubled unless the string is raw; a template literal also escapes its backtick (its
    // ${placeholders} stay as they are: slimming checks they are the same as before).
    const doubled = isRaw ? next : next.replace(/\\/g, "\\\\");
    const escaped = lit.quote === "`" && !goRaw ? doubled.replace(/`/g, "\\`") : doubled;
    // Same layout as before: a leading newline, the shared indent, and whatever closed the literal.
    const leading = inner.startsWith("\n") ? "\n" : "";
    const lines = inner.replace(/^\n/, "").split("\n");
    const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0]);
    const indent = indents.length ? indents.reduce((a, b) => (b.length < a.length ? b : a)) : "";
    const tail = /\n[ \t]*$/.exec(inner)?.[0] ?? "";
    const rows = escaped.split("\n").map((l, i) => (!l.trim() ? "" : i === 0 && !leading ? l : indent + l));
    body = leading + rows.join("\n") + tail;
  } else {
    if (/r/i.test(lit.prefix) && (/[\n\\]/.test(next) || next.includes(lit.quote))) return { reason: `a raw string can't hold this text; ${BY_HAND}` };
    body = next
      .replace(/\\/g, "\\\\")
      .replace(new RegExp(lit.quote, "g"), `\\${lit.quote}`)
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  }
  const updated = content.slice(0, lit.start) + body + content.slice(lit.end - lit.quote.length);
  // Read the literal back: it must close where expected and hold exactly the new prompt.
  const back = readLiteral(updated, lit.start, lit.quote, isRaw);
  if (!back || back.end !== lit.start + body.length + lit.quote.length || dedent(back.text) !== next) return { reason: `could not write it back exactly; ${BY_HAND}` };
  return { content: updated };
}

/** Every place in the folder where `from` is written as a system prompt, rewritten to `to`. */
export async function planPromptEdit(root: string, from: string, to: string): Promise<PromptEditPlan> {
  const plan: PromptEditPlan = { edits: [], skipped: [], files: new Map() };
  // Prompts recorded from traffic keep the code's indent; found prompts have it removed, so compare both without it.
  const want = dedent(from);
  for await (const file of walk(root)) {
    if (file.kind !== "code") continue;
    if ((await stat(file.path)).size > MAX_FILE_BYTES) continue;
    let content = await readFile(file.path, "utf8");
    // Later places first, so earlier offsets stay right after each change.
    const places = findPromptsInText(file.rel, content).filter((p) => p.text === want).sort((a, b) => (b.literal?.start ?? 0) - (a.literal?.start ?? 0));
    let changed = false;
    for (const place of places) {
      const result = rewritePromptLiteral(content, place, to);
      if ("reason" in result) plan.skipped.push({ file: file.rel, line: place.line, reason: result.reason });
      else {
        content = result.content;
        changed = true;
        plan.edits.push({ file: file.rel, line: place.line });
      }
    }
    if (changed) plan.files.set(file.rel, content);
  }
  plan.edits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  plan.skipped.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return plan;
}
