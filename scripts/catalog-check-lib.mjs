// Pure helpers for the daily catalog check (scripts/check-catalog.mjs): read the providers' official
// retirement pages and say what changed since a person last reviewed them. No network, no files here.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** Tags that sit inside a word (highlighting, soft line breaks): removed without a space, so "gpt<wbr>-4o" stays one ID. */
const INLINE_TAGS = /<\/?(?:wbr|span|code|b|i|em|strong|a|mark|kbd|var|samp)\b[^>]*>/gi;

function decodeEntity(m, e) {
  if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
  const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
}

/** The page as plain text. Script tags stay: some doc sites keep their tables in embedded JSON. */
export function pageText(html) {
  return html
    .replace(INLINE_TAGS, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    .replace(/\\u002[dD]/g, "-")
    .replace(/\s+/g, " ");
}

/** Every model ID on the page, as the scanner would recognise it in code. "a/b" is read whole ("models/x"), then part by part. */
export function extractIds(text, classify) {
  const ids = new Set();
  for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9._\/:@-]{1,80}/g)) {
    const token = m[0].replace(/[.:\/@-]+$/, "");
    const whole = classify(token);
    if (whole) ids.add(whole.id);
    else for (const part of token.split(/[\/@]/)) {
      const hit = part.length > 1 ? classify(part) : null;
      if (hit) ids.add(hit.id);
    }
  }
  return [...ids].sort();
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";

function iso(y, monthName, d) {
  const mo = MONTHS.findIndex((m) => m.startsWith(monthName.toLowerCase().replace(".", "").slice(0, 3))) + 1;
  return isoNum(y, mo, d);
}
function isoNum(y, mo, d) {
  const s = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().startsWith(s) ? s : null;
}

/** Every calendar date on the page, as YYYY-MM-DD, whichever way the provider writes it. */
export function extractDates(text) {
  const out = new Set();
  const add = (s) => s && out.add(s);
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) add(isoNum(m[1], Number(m[2]), Number(m[3])));
  for (const m of text.matchAll(new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, "gi"))) add(iso(m[3], m[1], Number(m[2])));
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON},?\\s+(20\\d{2})\\b`, "gi"))) add(iso(m[3], m[2], Number(m[1])));
  return [...out].sort();
}

/**
 * What a person should look at, for one page. `cited` are the catalog entries (models and APIs) that cite
 * this page; `known` is every model ID anywhere in the catalog; `text` is the page text.
 * - newIds: model IDs on the page that weren't there at the last review (a new retirement, or a new model);
 * - newDates: dates after today that weren't there (a new or moved retirement date; "updated on" stamps are today or earlier);
 * - goneFromPage: verified, still-future model entries whose ID is no longer on the page (cancelled or moved);
 * - dateNotOnPage: verified, still-future entries whose retiresOn the page no longer shows (the date changed).
 */
export function comparePage({ seen, previous, cited, known, text, today }) {
  const before = new Set(previous?.ids ?? []);
  const beforeDates = new Set(previous?.dates ?? []);
  const onPage = new Set(seen.ids);
  const lower = text.toLowerCase();
  const live = cited.filter((e) => e.verified && e.retiresOn > today);
  const dates = new Set(seen.dates);
  return {
    newIds: seen.ids.filter((id) => !before.has(id)).map((id) => ({ id, inCatalog: known.has(id) })),
    newDates: seen.dates.filter((d) => d > today && !beforeDates.has(d)),
    // An ID the scanner can't classify (no version number, say) still counts as present if the page text has it.
    goneFromPage: live.filter((e) => e.kind === "model" && !onPage.has(e.id) && !lower.includes(e.id.toLowerCase())).map((e) => e.id),
    dateNotOnPage: live.filter((e) => !dates.has(e.retiresOn)).map((e) => `${e.id} (${e.retiresOn})`),
  };
}

export const hasFindings = (r) => r.newIds.length + r.newDates.length + r.goneFromPage.length + r.dateNotOnPage.length > 0;

/** A short Markdown report for the job summary. */
export function report(results, today) {
  const lines = [`# Catalog check, ${today}`, ""];
  const changed = results.filter((r) => r.error || hasFindings(r));
  if (changed.length === 0) lines.push(`No changes on the ${results.length} official pages since the last review.`);
  for (const r of changed) {
    lines.push(`## ${r.url}`, "");
    if (r.error) {
      lines.push(`Could not read this page: ${r.error}`, "");
      continue;
    }
    if (r.newIds.length) lines.push(`New model IDs: ${r.newIds.map((x) => `\`${x.id}\`${x.inCatalog ? "" : " (not in the catalog)"}`).join(", ")}`);
    if (r.newDates.length) lines.push(`New future dates: ${r.newDates.join(", ")}`);
    if (r.goneFromPage.length) lines.push(`In the catalog but no longer on this page: ${r.goneFromPage.map((id) => `\`${id}\``).join(", ")}`);
    if (r.dateNotOnPage.length) lines.push(`Catalog date no longer on this page: ${r.dateNotOnPage.join(", ")}`);
    lines.push("");
  }
  if (changed.length) lines.push("Update packages/catalog/data/models.json (or apis.json) from the page, then run `node scripts/check-catalog.mjs --update` and commit the catalog and scripts/source-snapshot.json.");
  return lines.join("\n");
}
