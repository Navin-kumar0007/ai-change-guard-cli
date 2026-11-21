import {
  apis,
  defaultPlatform,
  lookupModel,
  type ModelEntry,
  type Platform,
  type Provider,
} from "@ai-change-guard/catalog";
import type { ScanResult } from "./scan.js";
import { TOKEN_RULES, type TokenRule } from "./tokens.js";

export interface TokenTipRow {
  rule: TokenRule;
  title: string;
  fix: string;
  saving: string;
  locations: string[];
}

export type RowStatus = "retired" | "rerouted" | "retiring" | "rerouting" | "no-known-retirement";

export interface ModelRow {
  id: string;
  provider: Provider;
  platform: Platform;
  status: RowStatus;
  date?: string;
  daysLeft?: number;
  reroutesTo?: string;
  replacement?: string;
  verified?: boolean;
  note?: string;
  fineTuned: boolean;
  gateways: string[];
  otherPlatforms: { platform: Platform; date: string }[];
  locations: string[];
}

export interface ApiRow {
  id: string;
  name: string;
  date: string;
  daysLeft: number;
  replacement?: string;
  verified: boolean;
  locations: string[];
}

export interface Report {
  target: string;
  today: string;
  filesScanned: number;
  aiFiles: number;
  callSites: number;
  models: ModelRow[];
  dynamic: { location: string; snippet: string }[];
  apis: ApiRow[];
  tokenTips: TokenTipRow[];
}

const STATUS_ORDER: Record<RowStatus, number> = {
  retired: 0,
  rerouted: 1,
  retiring: 2,
  rerouting: 3,
  "no-known-retirement": 4,
};

export function localToday(): string {
  return new Date().toLocaleDateString("en-CA");
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function statusFor(entry: ModelEntry | undefined, today: string): Pick<ModelRow, "status" | "daysLeft" | "date"> {
  if (!entry) return { status: "no-known-retirement" };
  const daysLeft = daysBetween(today, entry.retiresOn);
  const past = daysLeft <= 0;
  const status: RowStatus = entry.reroutesTo ? (past ? "rerouted" : "rerouting") : past ? "retired" : "retiring";
  return { status, daysLeft, date: entry.retiresOn };
}

export function buildReport(result: ScanResult, target: string, today: string): Report {
  const rows = new Map<string, ModelRow>();
  const dynamic: Report["dynamic"] = [];
  const apiLocations = new Map<string, string[]>();

  for (const f of result.findings) {
    const location = `${f.file}:${f.line}`;
    if (f.kind === "dynamic-model") {
      dynamic.push({ location, snippet: f.snippet });
    } else if (f.kind === "deprecated-api" && f.apiId) {
      const list = apiLocations.get(f.apiId) ?? [];
      list.push(location);
      apiLocations.set(f.apiId, list);
    } else if (f.kind === "model" && f.model) {
      const hit = f.model;
      const platform = hit.platformHint ?? defaultPlatform[hit.provider];
      const key = `${hit.id}|${platform}`;
      let row = rows.get(key);
      if (!row) {
        const entries = lookupModel(hit.id);
        const primary = entries.find((e) => e.platform === platform);
        row = {
          id: hit.id,
          provider: hit.provider,
          platform,
          ...statusFor(primary, today),
          fineTuned: false,
          gateways: [],
          otherPlatforms: entries
            .filter((e) => e !== primary)
            .map((e) => ({ platform: e.platform, date: e.retiresOn })),
          locations: [],
        };
        if (primary) {
          row.verified = primary.verified;
          if (primary.reroutesTo) row.reroutesTo = primary.reroutesTo;
          if (primary.replacement) row.replacement = primary.replacement;
          if (primary.note) row.note = primary.note;
        }
        rows.set(key, row);
      }
      if (hit.fineTuned) row.fineTuned = true;
      if (hit.gateway && !row.gateways.includes(hit.gateway)) row.gateways.push(hit.gateway);
      row.locations.push(location);
    }
  }

  const models = [...rows.values()].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) ||
      a.id.localeCompare(b.id),
  );

  const apiRows: ApiRow[] = [];
  for (const [id, locations] of apiLocations) {
    const entry = apis.find((a) => a.id === id);
    if (!entry) continue;
    const row: ApiRow = {
      id,
      name: entry.name,
      date: entry.retiresOn,
      daysLeft: daysBetween(today, entry.retiresOn),
      verified: entry.verified,
      locations,
    };
    if (entry.replacement) row.replacement = entry.replacement;
    apiRows.push(row);
  }
  apiRows.sort((a, b) => a.daysLeft - b.daysLeft);

  const tipRows = new Map<TokenRule, TokenTipRow>();
  for (const tip of result.tokenTips) {
    let row = tipRows.get(tip.rule);
    if (!row) {
      row = { rule: tip.rule, ...TOKEN_RULES[tip.rule], locations: [] };
      tipRows.set(tip.rule, row);
    }
    row.locations.push(`${tip.file}:${tip.line}`);
  }
  const tokenTips = [...tipRows.values()].sort((a, b) => b.locations.length - a.locations.length);

  return {
    target,
    today,
    filesScanned: result.filesScanned,
    aiFiles: result.aiFiles,
    callSites: result.callSites,
    models,
    dynamic,
    apis: apiRows,
    tokenTips,
  };
}

function statusLabel(row: ModelRow): string {
  const star = row.verified === false ? "*" : "";
  switch (row.status) {
    case "retired":
      return `RETIRED since ${row.date}${star}`;
    case "rerouted":
      return `REROUTED to ${row.reroutesTo} since ${row.date}${star}`;
    case "retiring":
      return `RETIRES in ${row.daysLeft} days (${row.date})${star}`;
    case "rerouting":
      return `REROUTES to ${row.reroutesTo} in ${row.daysLeft} days (${row.date})${star}`;
    default:
      return "no retirement known";
  }
}

function whereLabel(locations: string[]): string {
  const [first, ...rest] = locations;
  return rest.length > 0 ? `${first} (+${rest.length} more)` : (first ?? "");
}

function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (cells: string[]) =>
    "  " + cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  ");
  return [fmt(headers), ...rows.map(fmt)];
}

export function formatText(report: Report): string {
  const out: string[] = [];
  out.push(`AI Change Guard scan: ${report.target}`);
  out.push(
    `${report.filesScanned} files scanned · ${report.aiFiles} files use an AI SDK · ` +
      `${report.callSites} AI call sites · ${report.models.length} model IDs found · today ${report.today}`,
  );
  out.push("");

  if (report.models.length === 0 && report.dynamic.length === 0 && report.apis.length === 0) {
    out.push("No AI model IDs found in code or config.");
    out.push("If this app uses AI, the model may be set in a database, a dashboard or a gateway config. Check there.");
    return out.join("\n");
  }

  if (report.models.length > 0) {
    out.push("Models");
    out.push(
      ...table(
        ["STATUS", "MODEL", "PLATFORM", "WHERE"],
        report.models.map((m) => [statusLabel(m), m.fineTuned ? `${m.id} (fine-tuned)` : m.id, m.platform, whereLabel(m.locations)]),
      ),
    );
    for (const m of report.models) {
      const extras: string[] = [];
      if (m.replacement) extras.push(`replacement: ${m.replacement}`);
      if (m.note) extras.push(m.note);
      for (const other of m.otherPlatforms) extras.push(`on ${other.platform}: retires ${other.date}`);
      if (m.gateways.length > 0) extras.push(`called through: ${m.gateways.join(", ")}`);
      if (extras.length > 0) out.push(`  ${m.id}: ${extras.join(" · ")}`);
    }
    out.push("");
  }

  if (report.apis.length > 0) {
    out.push("Deprecated AI APIs");
    for (const a of report.apis) {
      const when = a.daysLeft <= 0 ? `SHUT DOWN since ${a.date}` : `SHUTS DOWN in ${a.daysLeft} days (${a.date})`;
      out.push(`  ${when}${a.verified ? "" : "*"}  ${a.name}  ${whereLabel(a.locations)}`);
      if (a.replacement) out.push(`    replacement: ${a.replacement}`);
    }
    out.push("");
  }

  if (report.tokenTips.length > 0) {
    out.push("Token Saver: ways to cut your AI bill");
    for (const t of report.tokenTips) {
      out.push(`  ${t.title}  ${whereLabel(t.locations)}`);
      out.push(`    fix: ${t.fix}`);
      out.push(`    why: ${t.saving}`);
    }
    out.push("");
  }

  if (report.dynamic.length > 0) {
    out.push("Model set at runtime (check these by hand)");
    for (const d of report.dynamic.slice(0, 20)) out.push(`  ${d.location}  ${d.snippet}`);
    if (report.dynamic.length > 20) out.push(`  ... and ${report.dynamic.length - 20} more`);
    out.push("");
  }

  if (report.models.some((m) => m.verified === false && m.status !== "no-known-retirement")) {
    out.push("* Date not yet verified against the provider's official page.");
  }
  return out.join("\n");
}
