import type { ModelRow, Report } from "./report.js";

export type Conclusion = "success" | "neutral" | "failure";

export interface CheckOutput {
  conclusion: Conclusion;
  title: string;
  summary: string;
}

const SOON_DAYS = 90;

function inChangedFiles(locations: string[], changed: Set<string>): boolean {
  return locations.some((loc) => changed.has(loc.replace(/:\d+$/, "")));
}

function statusText(row: ModelRow): string {
  if (row.status === "retired") return `Retired ${row.date}`;
  if (row.status === "rerouted") return `Rerouted to ${row.reroutesTo} since ${row.date}`;
  if (row.status === "retiring") return `Retires ${row.date} (${row.daysLeft} days)`;
  if (row.status === "rerouting") return `Reroutes to ${row.reroutesTo} on ${row.date} (${row.daysLeft} days)`;
  return "No retirement known";
}

/** Pass null for changedFiles outside a pull request: the "In this PR" column is then left out. */
export function buildCheck(report: Report, changedFiles: string[] | null): CheckOutput {
  const changed = new Set(changedFiles ?? []);
  const dead = report.models.filter((m) => m.status === "retired" || m.status === "rerouted");
  const soon = report.models.filter(
    (m) => (m.status === "retiring" || m.status === "rerouting") && (m.daysLeft ?? Infinity) <= SOON_DAYS,
  );
  const deadApis = report.apis.filter((a) => a.daysLeft <= 0);
  const soonApis = report.apis.filter((a) => a.daysLeft > 0 && a.daysLeft <= SOON_DAYS);

  const introducedDead =
    dead.some((m) => inChangedFiles(m.locations, changed)) || deadApis.some((a) => inChangedFiles(a.locations, changed));
  // Security findings stay advisory, except an AI key exposed in a file this pull request changes.
  const keyRow = report.security?.find((s) => s.rule === "ai-key-exposed");
  const introducedKey = Boolean(keyRow && inChangedFiles(keyRow.findings.map((f) => f.location), changed));
  const conclusion: Conclusion =
    introducedDead || introducedKey ? "failure" : dead.length + deadApis.length + soon.length + soonApis.length > 0 ? "neutral" : "success";

  const parts: string[] = [];
  if (dead.length + deadApis.length > 0) parts.push(`${dead.length + deadApis.length} retired`);
  if (soon.length + soonApis.length > 0) parts.push(`${soon.length + soonApis.length} changing within ${SOON_DAYS} days`);
  const modelTitle = parts.length > 0 ? `AI models and APIs: ${parts.join(", ")}` : `${report.models.length} AI models found, none changing soon`;
  const title = introducedKey ? `AI API key exposed in this pull request · ${modelTitle}` : modelTitle;

  const lines: string[] = [];
  if (introducedKey) lines.push("**This pull request adds or touches a file with an exposed AI API key. Revoke the key and move it to a server-side secret.**", "");
  if (introducedDead) lines.push("**This pull request touches code that uses a retired AI model or API.**", "");
  const rows = [...dead, ...soon];
  if (rows.length > 0) {
    const prColumn = changedFiles !== null;
    lines.push(prColumn ? "| Model | Status | Where | In this PR |" : "| Model | Status | Where |", prColumn ? "| --- | --- | --- | --- |" : "| --- | --- | --- |");
    for (const m of rows) {
      const where = m.locations.slice(0, 3).map((l) => `\`${l}\``).join(", ") + (m.locations.length > 3 ? ` +${m.locations.length - 3} more` : "");
      const prCell = prColumn ? ` ${inChangedFiles(m.locations, changed) ? "yes" : ""} |` : "";
      lines.push(`| \`${m.id}\` | ${statusText(m)} | ${where} |${prCell}`);
    }
    lines.push("");
  }
  for (const a of [...deadApis, ...soonApis]) {
    lines.push(`- **${a.name}** ${a.daysLeft <= 0 ? "shut down" : "shuts down"} ${a.date}${a.replacement ? ` (replacement: ${a.replacement})` : ""}`);
  }
  if (report.security?.length) {
    lines.push("", "**AI security check** (advisory):");
    for (const s of report.security) {
      const where = s.findings.slice(0, 3).map((f) => `\`${f.location}\``).join(", ") + (s.findings.length > 3 ? ` +${s.findings.length - 3} more` : "");
      lines.push(`- ${s.severity === "high" ? "**High:** " : ""}${s.title} [${s.owasp}]: ${where}. ${s.fix}`);
    }
  }
  if (report.tokenTips.length > 0) {
    lines.push("", "**Token Saver:** " + report.tokenTips.map((t) => `${t.title} (${t.locations.length})`).join(" · "));
  }
  lines.push("", `Scanned ${report.filesScanned} files · ${report.models.length} models · ${report.callSites} AI call sites.`);
  return { conclusion, title, summary: lines.join("\n") };
}
