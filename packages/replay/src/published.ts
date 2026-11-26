// The replay report as the Action publishes it in a GitHub check run, so the AI Change Guard dashboard can show
// the migration report straight from the customer's repository. The data stays in their GitHub: the dashboard
// reads it when someone opens the page and stores nothing.
import type { ReplayReport, Reroute } from "./report.js";
import type { SavingsResult } from "./savings.js";
import type { WatchReport } from "./watch.js";
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

/** A payload as a check run's text: a comment GitHub doesn't show, marked with what it holds. */
const wrapData = (mark: string, value: unknown) => `<!-- ${mark} ${safeJson(value)} -->`;

/** The JSON after `mark` in a check run's text, or undefined when there is none or it doesn't parse. */
function unwrap(text: string | null | undefined, mark: string): unknown {
  if (!text) return undefined;
  const at = text.indexOf(`<!-- ${mark} `);
  if (at < 0) return undefined;
  const end = text.indexOf(" -->", at);
  if (end < 0) return undefined;
  try {
    return JSON.parse(text.slice(at + mark.length + 6, end));
  } catch {
    return undefined;
  }
}

/** The check run's text: the report as data, in a comment GitHub doesn't show. */
export function replayCheckText(report: ReplayReport, prUrl?: string, limit = TEXT_LIMIT): string {
  const base: Omit<PublishedReplay, "items" | "omittedItems"> = {
    v: 1,
    oldModel: report.oldModel.slice(0, 200),
    newModel: report.newModel.slice(0, 200),
    runs: report.runs,
    calls: report.calls,
    failedCalls: report.failedCalls,
    totals: report.totals,
    avgTokens: report.avgTokens,
    avgLatencyMs: report.avgLatencyMs,
    ...(report.costPerCall ? { costPerCall: report.costPerCall } : {}),
    comparedPrompts: report.comparedPrompts,
    rateLimited: report.rateLimited,
    reroutes: report.reroutes.slice(0, 10).map((r) => ({ side: r.side, requested: r.requested.slice(0, 200), served: r.served.slice(0, 200) })),
    ...(prUrl ? { prUrl: prUrl.slice(0, 500) } : {}),
  };
  const wrap = (items: PublishedItem[], omitted: number) => wrapData(MARK, { ...base, items, omittedItems: omitted });
  // Shrink step by step: shorter answers, then no answers for unchanged prompts, then fewer prompts.
  for (const [sample, sameSamples] of [[2000, true], [2000, false], [800, false], [300, false]] as const) {
    const text = wrap(report.items.map((i) => item(i, sample, sameSamples)), 0);
    if (text.length <= limit) return text;
  }
  const items = report.items.map((i) => item(i, 300, false));
  let keep = items.length;
  while (keep > 0 && wrap(items.slice(0, keep), items.length - keep).length > limit) keep = Math.floor(keep * 0.8);
  // The header alone is bounded (cut names, at most 10 reroutes), so with no items it always fits.
  return wrap(items.slice(0, keep), items.length - keep);
}

const VERDICTS = new Set<Verdict>(["same", "changed", "broken", "error"]);
const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const usage = (v: unknown) => ({ input: num(record(v).input), output: num(record(v).output) });

/**
 * The report from a check run's text, or null when there is none or it isn't one we can read. Anyone who can
 * write checks in the repository can write this text, so every field is checked and rebuilt, never passed through.
 */
export function readReplayCheckText(text: string | null | undefined): PublishedReplay | null {
  const data = unwrap(text, MARK);
  if (data === undefined) return null;
  const d = record(data);
  const totals = record(d.totals);
  const oldModel = str(d.oldModel, 200);
  const newModel = str(d.newModel, 200);
  if (d.v !== 1 || !oldModel || !newModel || !Array.isArray(d.items)) return null;
  if (!["same", "changed", "broken", "error"].every((k) => typeof totals[k] === "number" && Number.isFinite(totals[k]))) return null;

  const items: PublishedItem[] = [];
  for (const raw of d.items.slice(0, 5000)) {
    const i = record(raw);
    const id = str(i.id, 200);
    if (id === undefined || !VERDICTS.has(i.verdict as Verdict)) return null;
    const sampleOld = str(i.sampleOld, 4000);
    const sampleNew = str(i.sampleNew, 4000);
    const error = str(i.error, 500);
    items.push({
      id,
      verdict: i.verdict as Verdict,
      reasons: (Array.isArray(i.reasons) ? i.reasons : []).flatMap((r) => (typeof r === "string" ? [r.slice(0, 500)] : [])).slice(0, 20),
      ...(sampleOld !== undefined ? { sampleOld } : {}),
      ...(sampleNew !== undefined ? { sampleNew } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }
  const cost = record(d.costPerCall);
  const prUrl = str(d.prUrl, 500);
  return {
    v: 1,
    oldModel,
    newModel,
    runs: num(d.runs, 1),
    calls: num(d.calls),
    failedCalls: num(d.failedCalls),
    totals: { same: num(totals.same), changed: num(totals.changed), broken: num(totals.broken), error: num(totals.error) },
    avgTokens: { old: usage(record(d.avgTokens).old), new: usage(record(d.avgTokens).new) },
    avgLatencyMs: { old: num(record(d.avgLatencyMs).old), new: num(record(d.avgLatencyMs).new) },
    ...(d.costPerCall !== undefined
      ? { costPerCall: { ...(typeof cost.old === "number" ? { old: num(cost.old) } : {}), ...(typeof cost.new === "number" ? { new: num(cost.new) } : {}) } }
      : {}),
    comparedPrompts: num(d.comparedPrompts),
    rateLimited: d.rateLimited === true,
    reroutes: (Array.isArray(d.reroutes) ? d.reroutes : []).slice(0, 10).flatMap((r) => {
      const x = record(r);
      const requested = str(x.requested, 200);
      const served = str(x.served, 200);
      return (x.side === "old" || x.side === "new") && requested && served ? [{ side: x.side, requested, served }] : [];
    }),
    items,
    omittedItems: num(d.omittedItems),
    ...(prUrl ? { prUrl } : {}),
  };
}

/**
 * The check run's conclusion, matching the job: it fails only on what replay-fail-on fails the job for (broken
 * prompts by default), and asks for a look when anything changed, broke or couldn't be compared.
 */
export function replayConclusion(report: Pick<ReplayReport, "totals">, failOn: "broken" | "changed" | "none" = "broken"): "success" | "neutral" | "failure" {
  const t = report.totals;
  if ((failOn === "broken" && t.broken > 0) || (failOn === "changed" && t.broken + t.changed > 0)) return "failure";
  return t.broken + t.changed + t.error > 0 ? "neutral" : "success";
}

/** "45 same · 3 changed · 2 broken", the check run's title. */
export function replayTitle(report: Pick<ReplayReport, "totals">): string {
  const t = report.totals;
  const parts = [`${t.same} same`, `${t.changed} changed`, `${t.broken} broken`];
  if (t.error) parts.push(`${t.error} could not compare`);
  return parts.join(" · ");
}

/** The nightly watch's check run (its baseline replayed on the model in use): the dashboard's "last night's result". */
export const WATCH_CHECK_NAME = "AI Change Guard nightly watch";
const WATCH_MARK = "ai-change-guard:watch:v1";

export interface PublishedWatch {
  v: 1;
  model: string;
  baselineCreatedAt: string;
  totals: Record<Verdict, number>;
  alert: boolean;
  snapshotChanged: boolean;
  reroutes: { requested: string; served: string }[];
  servedNow: string[];
}

export function watchCheckText(w: WatchReport): string {
  return wrapData(WATCH_MARK, {
    v: 1,
    model: w.model.slice(0, 200),
    baselineCreatedAt: w.baselineCreatedAt.slice(0, 40),
    totals: w.report.totals,
    alert: w.alert,
    snapshotChanged: w.snapshotChanged,
    reroutes: w.reroutes.slice(0, 10).map((r) => ({ requested: r.requested.slice(0, 200), served: r.served.slice(0, 200) })),
    servedNow: w.servedNow.slice(0, 10).map((m) => m.slice(0, 200)),
  } satisfies PublishedWatch);
}

export function readWatchCheckText(text: string | null | undefined): PublishedWatch | null {
  const d = record(unwrap(text, WATCH_MARK));
  const totals = record(d.totals);
  const model = str(d.model, 200);
  if (d.v !== 1 || !model || !["same", "changed", "broken", "error"].every((k) => typeof totals[k] === "number")) return null;
  return {
    v: 1,
    model,
    baselineCreatedAt: str(d.baselineCreatedAt, 40) ?? "",
    totals: { same: num(totals.same), changed: num(totals.changed), broken: num(totals.broken), error: num(totals.error) },
    alert: d.alert === true,
    snapshotChanged: d.snapshotChanged === true,
    reroutes: (Array.isArray(d.reroutes) ? d.reroutes : []).slice(0, 10).flatMap((r) => {
      const x = record(r);
      const requested = str(x.requested, 200);
      const served = str(x.served, 200);
      return requested && served ? [{ requested, served }] : [];
    }),
    servedNow: (Array.isArray(d.servedNow) ? d.servedNow : []).flatMap((m) => (typeof m === "string" ? [m.slice(0, 200)] : [])).slice(0, 10),
  };
}

/** Money-Finder's check run (cheaper models tested on the golden set): the dashboard's savings card. */
export const SAVINGS_CHECK_NAME = "AI Change Guard Money-Finder";
const SAVINGS_MARK = "ai-change-guard:savings:v1";

export interface SavingsLine {
  model: string;
  qualifies: boolean;
  reason?: string;
  /** Share of the per-call cost saved (0.7 = 70% cheaper). */
  savingShare?: number;
  /** Dollars a month saved at the call volume given. */
  monthlySaving?: number;
}

export interface PublishedSavings {
  v: 1;
  primary: string;
  callsPerMonth?: number;
  best?: SavingsLine;
  candidates: SavingsLine[];
}

const line = (c: SavingsResult["candidates"][number]): SavingsLine => ({
  model: c.model.slice(0, 200),
  qualifies: c.qualifies,
  ...(c.reason ? { reason: c.reason.slice(0, 300) } : {}),
  ...(c.savingShare !== undefined ? { savingShare: c.savingShare } : {}),
  ...(c.monthlySaving !== undefined ? { monthlySaving: c.monthlySaving } : {}),
});

export function savingsCheckText(r: SavingsResult): string {
  return wrapData(SAVINGS_MARK, {
    v: 1,
    primary: r.primary.slice(0, 200),
    ...(r.callsPerMonth !== undefined ? { callsPerMonth: r.callsPerMonth } : {}),
    ...(r.best ? { best: line(r.best) } : {}),
    candidates: r.candidates.slice(0, 10).map(line),
  } satisfies PublishedSavings);
}

function readLine(v: unknown): SavingsLine | null {
  const x = record(v);
  const model = str(x.model, 200);
  if (!model) return null;
  const reason = str(x.reason, 300);
  return {
    model,
    qualifies: x.qualifies === true,
    ...(reason ? { reason } : {}),
    ...(typeof x.savingShare === "number" && Number.isFinite(x.savingShare) ? { savingShare: x.savingShare } : {}),
    ...(typeof x.monthlySaving === "number" && Number.isFinite(x.monthlySaving) ? { monthlySaving: x.monthlySaving } : {}),
  };
}

export function readSavingsCheckText(text: string | null | undefined): PublishedSavings | null {
  const d = record(unwrap(text, SAVINGS_MARK));
  const primary = str(d.primary, 200);
  if (d.v !== 1 || !primary || !Array.isArray(d.candidates)) return null;
  const best = d.best === undefined ? null : readLine(d.best);
  return {
    v: 1,
    primary,
    ...(typeof d.callsPerMonth === "number" && Number.isFinite(d.callsPerMonth) ? { callsPerMonth: d.callsPerMonth } : {}),
    ...(best ? { best } : {}),
    candidates: d.candidates.slice(0, 10).flatMap((c) => {
      const l = readLine(c);
      return l ? [l] : [];
    }),
  };
}

