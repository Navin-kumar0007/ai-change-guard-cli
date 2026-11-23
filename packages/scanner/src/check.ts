import { describeCost } from "./costs.js";
import { describePackage, PACKAGE_FIX } from "./packages.js";
import { groupLockChanges, LOCK_FILE } from "./lock.js";
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
  // A malicious AI package release fails the check when this pull request touches the file that installs it.
  const compromised = (report.packages ?? []).filter((p) => p.issue === "compromised");
  const introducedPackage = compromised.some((p) => inChangedFiles(p.locations, changed));
  const conclusion: Conclusion =
    introducedDead || introducedKey || introducedPackage ? "failure" : compromised.length > 0 ? "neutral" : dead.length + deadApis.length + soon.length + soonApis.length > 0 ? "neutral" : "success";

  const parts: string[] = [];
  if (dead.length + deadApis.length > 0) parts.push(`${dead.length + deadApis.length} retired`);
  if (soon.length + soonApis.length > 0) parts.push(`${soon.length + soonApis.length} changing within ${SOON_DAYS} days`);
  const modelTitle = parts.length > 0 ? `AI models and APIs: ${parts.join(", ")}` : `${report.models.length} AI models found, none changing soon`;
  const title = introducedKey
    ? `AI API key exposed in this pull request · ${modelTitle}`
    : compromised.length > 0
      ? `Malicious AI package release installed · ${modelTitle}`
      : modelTitle;

  const lines: string[] = [];
  if (introducedKey) lines.push("**This pull request adds or touches a file with an exposed AI API key. Revoke the key and move it to a server-side secret.**", "");
  if (introducedDead) lines.push("**This pull request touches code that uses a retired AI model or API.**", "");
  if (compromised.length > 0) {
    lines.push(`**${introducedPackage ? "This pull request installs" : "This repository installs"} an AI package release that was published with malicious code.** ${PACKAGE_FIX.compromised}`);
    for (const p of compromised) lines.push(`- ${describePackage(p)} (${p.locations.slice(0, 3).map((l) => `\`${l}\``).join(", ")})${p.url ? ` [advisory](${p.url})` : ""}`);
    lines.push("");
  }
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
  const costs = (report.costs ?? []).filter((c) => c.daysLeft <= SOON_DAYS);
  if (costs.length > 0) {
    lines.push("", "**Price changes** (advisory):");
    for (const c of costs) lines.push(`- ${describeCost(c)}`);
  }
  if (report.security?.length) {
    lines.push("", "**AI security check** (advisory):");
    for (const s of report.security) {
      const where = s.findings.slice(0, 3).map((f) => `\`${f.location}\``).join(", ") + (s.findings.length > 3 ? ` +${s.findings.length - 3} more` : "");
      lines.push(`- ${s.severity === "high" ? "**High:** " : ""}${s.title} [${s.owasp}]: ${where}. ${s.fix}`);
    }
  }
  const otherPackages = (report.packages ?? []).filter((p) => p.issue !== "compromised");
  if (otherPackages.length > 0) {
    lines.push("", "**AI packages to review** (advisory):");
    for (const p of otherPackages) lines.push(`- ${describePackage(p)}`);
  }
  if (report.lock) {
    if ("error" in report.lock) lines.push("", `**ai-stack.lock:** ${report.lock.error}`);
    else if (report.lock.changes.length > 0) {
      for (const g of groupLockChanges(report.lock.changes)) {
        lines.push("", `**\`${LOCK_FILE}\`: ${g.heading}.** To fix: ${g.remedy}.`, ...g.changes.map((c) => `- ${c.subject}: ${c.detail}`));
      }
    } else lines.push("", `\`${LOCK_FILE}\` is up to date.`);
  }
  if (report.tokenTips.length > 0) {
    lines.push("", "**Token Saver:** " + report.tokenTips.map((t) => `${t.title} (${t.locations.length})`).join(" · "));
  }
  lines.push("", `Scanned ${report.filesScanned} files · ${report.models.length} models · ${report.callSites} AI call sites.`);
  return { conclusion, title, summary: lines.join("\n") };
}
