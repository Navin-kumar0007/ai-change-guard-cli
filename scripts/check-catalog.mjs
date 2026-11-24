// Daily catalog check (plan 8.3): reads every official page the model catalog cites and reports what
// changed since a person last reviewed it. Exit 0 = nothing new, 1 = something to review, 2 = a page
// couldn't be read. `--update` saves what the pages say now as the reviewed state.
// Run after `npm run build`: node scripts/check-catalog.mjs [--update]
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { apis, models } from "../packages/catalog/dist/index.js";
import { classifyModelId } from "../packages/scanner/dist/index.js";
import { comparePage, extractDates, extractIds, hasFindings, pageText, report } from "./catalog-check-lib.mjs";

const SNAPSHOT = new URL("./source-snapshot.json", import.meta.url);
const update = process.argv.includes("--update");
const today = new Date().toISOString().slice(0, 10);
/** On a page that lists models, fewer IDs than this means it didn't load as expected (a sign-in wall, a redesign). */
const MIN_IDS = 3;

/** Every page the catalog cites, with the entries that cite it. */
const byUrl = new Map();
const cite = (e, kind) => {
  for (const s of e.sources) (byUrl.get(s.url) ?? byUrl.set(s.url, []).get(s.url)).push({ ...e, kind });
};
for (const m of models) cite(m, "model");
for (const a of apis) cite(a, "api");
const known = new Set(models.map((m) => m.id));

let snapshot = { pages: {} };
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") {
    // A broken file (a merge conflict, say) must not look like a first run, or --update would erase the reviewed state.
    console.error(`scripts/source-snapshot.json can't be read (${error instanceof Error ? error.message : error}). Fix it from git history first.`);
    process.exit(2);
  }
  if (!update) console.error("No reviewed snapshot yet: run with --update once.");
}

async function fetchPage(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "ai-change-guard-catalog-check", "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(30_000),
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      // Google's docs sometimes serve a machine translation (lang="it-x-mtfrom-en"), whose dates we can't read.
      const lang = /<html[^>]*\slang="([^"]+)"/i.exec(html)?.[1];
      if (lang && !/^en\b/i.test(lang)) throw new Error(`served in "${lang}", not English`);
      return html;
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

// The pages are independent: read them all at once.
const results = await Promise.all(
  [...byUrl].map(async ([url, cited]) => {
    try {
      const text = pageText(await fetchPage(url));
      const seen = { ids: extractIds(text, classifyModelId), dates: extractDates(text) };
      if (cited.some((e) => e.kind === "model") && seen.ids.length < MIN_IDS) throw new Error(`only ${seen.ids.length} model IDs found; the page may have changed layout`);
      return { url, seen, ...comparePage({ seen, previous: snapshot.pages[url], cited, known, text, today }) };
    } catch (error) {
      return { url, error: error instanceof Error ? error.message : String(error), newIds: [], newDates: [], goneFromPage: [], dateNotOnPage: [] };
    }
  }),
);
results.sort((a, b) => a.url.localeCompare(b.url));

if (update) {
  const pages = {};
  for (const r of results) pages[r.url] = r.seen ? { checked: today, ids: r.seen.ids, dates: r.seen.dates } : snapshot.pages[r.url];
  const out = {
    $comment: "What each official page said when a person last reviewed it against the catalog. Written by `node scripts/check-catalog.mjs --update`.",
    pages,
  };
  writeFileSync(SNAPSHOT, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`Saved the reviewed state of ${results.filter((r) => r.seen).length} pages.`);
}

const text = report(results, today);
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
if (results.some((r) => r.error)) process.exitCode = 2;
else if (!update && results.some(hasFindings)) process.exitCode = 1;
