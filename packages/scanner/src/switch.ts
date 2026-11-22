import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { valueSpans, type Finding } from "./detect.js";
import { fileKind } from "./walk.js";

/** One changed line. `before` and `after` are the whole line, trimmed. */
export interface SwitchEdit {
  file: string;
  line: number;
  before: string;
  after: string;
}

/** A use of the old model that was found but not changed, with the reason. */
export interface SwitchSkip {
  file: string;
  line: number;
  raw: string;
  reason: string;
}

export interface SwitchPlan {
  from: string;
  to: string;
  edits: SwitchEdit[];
  skipped: SwitchSkip[];
  /** New full contents of every file that changes, keyed by path relative to the scan root. */
  files: Map<string, string>;
}

export interface SwitchOptions {
  /**
   * Only change uses written behind this gateway prefix, e.g. "openai" when the replay tested
   * openrouter:openai/gpt-4o. Without it, every direct or gateway use changes.
   */
  prefix?: string;
}

const MODEL_ID_RE = /^[A-Za-z0-9][\w.\-:@]{0,119}$/;
// A character touching the ID on either side that makes it part of a longer ID (gpt-4o-mini,
// anthropic.claude-…, ft:…:org). "/" and ":" may come before it: a gateway prefix or key:value.
const ID_CHAR_BEFORE = /[\w.\-@]/;
const ID_CHAR_AFTER = /[\w.\-/:@]/;
const TOKEN_CHAR = /[\w.\-/:@]/;

const REASONS = {
  fineTuned: "Fine-tuned model: train a new fine-tune on the new model first.",
  bedrock: "Bedrock model IDs have their own format; change this one by hand.",
  azure: "Azure calls a deployment name; deploy the new model on Azure, then change this by hand.",
  other: "Written in a form AI Change Guard does not rewrite automatically.",
};

/** Checks both IDs before anything is read or any replay is paid for. */
export function checkSwitchIds(from: string, to: string): { from: string; to: string } {
  const fromId = from.trim().toLowerCase();
  const toId = to.trim();
  if (!MODEL_ID_RE.test(fromId) || !MODEL_ID_RE.test(toId)) throw new Error("Model IDs may only contain letters, digits and . - _ : @");
  if (fromId === toId.toLowerCase()) throw new Error("The old and new model are the same.");
  return { from: fromId, to: toId };
}

function findingReason(finding: Finding, from: string): string | null {
  const hit = finding.model!;
  if (hit.fineTuned) return REASONS.fineTuned;
  if (hit.platformHint === "aws-bedrock") return REASONS.bedrock;
  if (hit.platformHint === "azure-openai") return REASONS.azure;
  const raw = hit.raw.trim().toLowerCase();
  return raw === from || raw.endsWith(`/${from}`) ? null : REASONS.other;
}

/**
 * Rewrites one line. Only occurrences inside a string literal or config value change, so a
 * comment that mentions the model stays as written. Returns the new line and why any
 * occurrence was left alone.
 */
function rewriteLine(line: string, kind: "code" | "config", from: string, to: string, opts: SwitchOptions): { line: string; reasons: string[] } {
  const spans = valueSpans(line, kind);
  const lower = line.toLowerCase();
  const reasons: string[] = [];
  let out = "";
  let last = 0;
  for (let i = lower.indexOf(from); i !== -1; i = lower.indexOf(from, i + 1)) {
    const end = i + from.length;
    if (end > line.length || (i > 0 && ID_CHAR_BEFORE.test(line[i - 1]!)) || (end < line.length && ID_CHAR_AFTER.test(line[end]!))) continue;
    if (!spans.some((s) => i >= s.start && end <= s.end)) continue;
    let start = i;
    while (start > 0 && TOKEN_CHAR.test(line[start - 1]!)) start--;
    const prefix = lower.slice(start, i);
    if (prefix.startsWith("ft:") || prefix.endsWith("ft:")) reasons.push(REASONS.fineTuned);
    else if (/(^|\/)azure\/$/.test(prefix)) reasons.push(REASONS.azure);
    else if (/(^|\/)bedrock\/$/.test(prefix)) reasons.push(REASONS.bedrock);
    else if (opts.prefix && !prefix.endsWith(`${opts.prefix.toLowerCase()}/`)) {
      reasons.push(`Not called through ${opts.prefix}/, the route the replay tested.`);
    } else {
      out += line.slice(last, i) + to;
      last = end;
    }
  }
  return { line: out + line.slice(last), reasons };
}

/**
 * Plans replacing the model ID `from` with `to` everywhere the scanner found it.
 * Only exact uses change: string literals and config values that are the model ID itself,
 * optionally behind a gateway prefix such as openrouter's `openai/`. Nothing is written.
 */
export async function planSwitch(root: string, findings: readonly Finding[], from: string, to: string, opts: SwitchOptions = {}): Promise<SwitchPlan> {
  const ids = checkSwitchIds(from, to);
  const plan: SwitchPlan = { ...ids, edits: [], skipped: [], files: new Map() };
  const byFile = new Map<string, Map<number, Finding[]>>();
  for (const f of findings) {
    if (f.kind !== "model" || f.model?.id !== ids.from) continue;
    const lines = byFile.get(f.file) ?? new Map<number, Finding[]>();
    lines.set(f.line, [...(lines.get(f.line) ?? []), f]);
    byFile.set(f.file, lines);
  }

  for (const [file, uses] of byFile) {
    const kind = fileKind(file);
    if (!kind) continue;
    const lines = (await readFile(join(root, file), "utf8")).split("\n");
    let changed = false;
    for (const [lineNo, lineFindings] of uses) {
      const original = lines[lineNo - 1];
      if (original === undefined) continue;
      const result = rewriteLine(original, kind, ids.from, ids.to, opts);
      const reasons = new Set(result.reasons);
      for (const f of lineFindings) {
        const reason = findingReason(f, ids.from);
        if (reason && reason !== REASONS.other) reasons.add(reason);
      }
      if (result.line !== original) {
        lines[lineNo - 1] = result.line;
        changed = true;
        plan.edits.push({ file, line: lineNo, before: original.trim(), after: result.line.trim() });
      } else if (reasons.size === 0) {
        reasons.add(lineFindings.some((f) => findingReason(f, ids.from)) ? REASONS.other : "Could not place the change on this line.");
      }
      const raw = lineFindings[0]!.model!.raw;
      for (const reason of reasons) plan.skipped.push({ file, line: lineNo, raw, reason });
    }
    if (changed) plan.files.set(file, lines.join("\n"));
  }
  plan.edits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  plan.skipped.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return plan;
}

/** Writes a plan's changed files under `root`. */
export async function applySwitch(root: string, plan: SwitchPlan): Promise<void> {
  for (const [file, content] of plan.files) await writeFile(join(root, file), content);
}
