// The replay report as the Action publishes it in a GitHub check run, so the AI Change Guard dashboard can show
// the migration report straight from the customer's repository. The data stays in their GitHub: the dashboard
// reads it when someone opens the page and stores nothing.
import type { ReplayReport, Reroute } from "./report.js";
import type { Verdict } from "./verdict.js";

/** The check run's name: the dashboard looks for exactly this. */
export const REPLAY_CHECK_NAME = "AI Change Guard model switch";
const MARK = "ai-change-guard:replay:v1";
/** GitHub caps a check run's text at 65,535 characters; stay under it with room for the wrapper. */
const TEXT_LIMIT = 60_000;

export interface PublishedItem {
  id: string;
  verdict: Verdict;
  reasons: string[];
  sampleOld?: string;
  sampleNew?: string;
  error?: string;
}

export interface PublishedReplay {
  v: 1;
  oldModel: string;
  newModel: string;
  runs: number;
  calls: number;
  failedCalls: number;
  totals: Record<Verdict, number>;
  avgTokens: ReplayReport["avgTokens"];
  avgLatencyMs: ReplayReport["avgLatencyMs"];
  costPerCall?: ReplayReport["costPerCall"];
  comparedPrompts: number;
  rateLimited: boolean;
  reroutes: Reroute[];
  /** Changed and broken prompts first. Long answers are cut, and when even that doesn't fit, the last items are left out. */
  items: PublishedItem[];
  omittedItems: number;
  prUrl?: string;
}

const cut = (s: string | undefined, n: number) => (s === undefined ? undefined : s.length > n ? `${s.slice(0, n)}…` : s);

function item(i: ReplayReport["items"][number], sample: number, sameSamples: boolean): PublishedItem {
  const withSamples = i.verdict !== "same" || sameSamples;
  return {
    id: i.id.slice(0, 200),
    verdict: i.verdict,
    reasons: i.reasons.map((r) => r.detail.slice(0, 500)),
    ...(withSamples && i.sampleOld !== undefined ? { sampleOld: cut(i.sampleOld, sample) } : {}),
    ...(withSamples && i.sampleNew !== undefined ? { sampleNew: cut(i.sampleNew, sample) } : {}),
    ...(i.error ? { error: i.error.slice(0, 500) } : {}),
  };
}

/** JSON that can sit inside an HTML comment: "<", ">" and "&" never appear literally, so "-->" can't end it early. */
const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

/** The check run's text: the report as data, in a comment GitHub doesn't show. */
export function replayCheckText(report: ReplayReport, prUrl?: string, limit = TEXT_LIMIT): string {
  const base: Omit<PublishedReplay, "items" | "omittedItems"> = {
    v: 1,
    oldModel: report.oldModel,
    newModel: report.newModel,
    runs: report.runs,
    calls: report.calls,
    failedCalls: report.failedCalls,
    totals: report.totals,
    avgTokens: report.avgTokens,
    avgLatencyMs: report.avgLatencyMs,
    ...(report.costPerCall ? { costPerCall: report.costPerCall } : {}),
    comparedPrompts: report.comparedPrompts,
    rateLimited: report.rateLimited,
    reroutes: report.reroutes,
    ...(prUrl ? { prUrl } : {}),
  };
  const wrap = (items: PublishedItem[], omitted: number) => `<!-- ${MARK} ${safeJson({ ...base, items, omittedItems: omitted })} -->`;
  // Shrink step by step: shorter answers, then no answers for unchanged prompts, then fewer prompts.
  for (const [sample, sameSamples] of [[2000, true], [2000, false], [800, false], [300, false]] as const) {
    const text = wrap(report.items.map((i) => item(i, sample, sameSamples)), 0);
    if (text.length <= limit) return text;
  }
  const items = report.items.map((i) => item(i, 300, false));
  let keep = items.length;
  while (keep > 0 && wrap(items.slice(0, keep), items.length - keep).length > limit) keep = Math.floor(keep * 0.8);
  return wrap(items.slice(0, keep), items.length - keep);
}

const VERDICTS = new Set(["same", "changed", "broken", "error"]);
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** The report from a check run's text, or null when there is none or it isn't one we can read. */
export function readReplayCheckText(text: string | null | undefined): PublishedReplay | null {
  if (!text) return null;
  const at = text.indexOf(`<!-- ${MARK} `);
  if (at < 0) return null;
  const end = text.indexOf(" -->", at);
  if (end < 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(text.slice(at + MARK.length + 6, end));
  } catch {
    return null;
  }
  const d = data as Partial<PublishedReplay>;
  const ok =
    d.v === 1 &&
    typeof d.oldModel === "string" &&
    typeof d.newModel === "string" &&
    d.totals !== undefined &&
    ["same", "changed", "broken", "error"].every((k) => isNum((d.totals as Record<string, unknown>)[k])) &&
    Array.isArray(d.items) &&
    d.items.every((i) => i && typeof i.id === "string" && VERDICTS.has(i.verdict) && Array.isArray(i.reasons));
  return ok ? (d as PublishedReplay) : null;
}

/** The check run's conclusion: broken prompts fail it, changed ones (or prompts that couldn't be compared) ask for a look. */
export function replayConclusion(report: Pick<ReplayReport, "totals">): "success" | "neutral" | "failure" {
  const t = report.totals;
  if (t.broken > 0) return "failure";
  return t.changed + t.error > 0 ? "neutral" : "success";
}

/** "45 same · 3 changed · 2 broken", the check run's title. */
export function replayTitle(report: Pick<ReplayReport, "totals">): string {
  const t = report.totals;
  const parts = [`${t.same} same`, `${t.changed} changed`, `${t.broken} broken`];
  if (t.error) parts.push(`${t.error} could not compare`);
  return parts.join(" · ");
}
