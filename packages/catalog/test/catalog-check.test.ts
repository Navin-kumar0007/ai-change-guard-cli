import { describe, expect, it } from "vitest";
import { classifyModelId } from "../../scanner/src/index.js";
// @ts-expect-error plain JavaScript maintainer script, no type declarations
import { comparePage, extractDates, extractIds, hasFindings, pageText, report } from "../../../scripts/catalog-check-lib.mjs";

const TODAY = "2026-11-25";

describe("the daily catalog check", () => {
  it("reads model IDs off a page the way the scanner reads them in code", () => {
    const text = pageText(`<table><tr><td><code>gpt-image-1.5</code></td><td>o3</td><td>models/text-embedding-004.</td>
      <td>claude-opus-4-5-20251101</td><td>gpt&#x2D;4o</td><td>nothing-here</td></tr></table>`);
    expect(extractIds(text, classifyModelId)).toEqual(["claude-opus-4-5-20251101", "gpt-4o", "gpt-image-1.5", "o3", "text-embedding-004"]);
  });

  it("reads dates however the provider writes them, and only real ones", () => {
    const text = "Shutdown: December 1, 2026. Retires 2027-01-14 · 22 Jan 2027 · Sept 3rd, 2026 · Feb 30, 2027 · 2026-13-01";
    expect(extractDates(text)).toEqual(["2026-09-03", "2026-12-01", "2027-01-14", "2027-01-22"]);
  });

  it("keeps an ID whole across highlighting tags, splits names joined by a slash, and survives odd entities", () => {
    const text = pageText(`<td>gpt-4o-<wbr>2024-08-06</td><td><span>gpt</span>-4.1</td><td>o3/o4-mini</td><td>&#x110000; &#99999999;</td><td>gpt-5<sup>4</sup></td>`);
    expect(extractIds(text, classifyModelId)).toEqual(["gpt-4.1", "gpt-4o-2024-08-06", "gpt-5", "o3", "o4-mini"]);
  });

  const cited = [
    { id: "o3", retiresOn: "2026-12-11", verified: true, kind: "model" },
    { id: "gpt-4o", retiresOn: "2027-01-14", verified: false, kind: "model" },
    { id: "dall-e-2", retiresOn: "2026-05-12", verified: true, kind: "model" },
    { id: "gemini-embedding-exp", retiresOn: "2027-02-01", verified: true, kind: "model" },
  ];
  const known = new Set(["o3", "gpt-4o", "dall-e-2", "gemini-embedding-exp", "gpt-image-1.5"]);
  const text = "o3 retires December 11, 2026; gemini-embedding-exp shuts down 2027-02-01.";

  it("reports what is new since the last review, and ignores the page's own 'updated today' stamp", () => {
    const r = comparePage({
      seen: { ids: ["gpt-4o", "gpt-image-1.5", "o3", "gpt-x"], dates: ["2026-01-01", TODAY, "2026-12-11", "2027-02-01", "2027-02-26"] },
      previous: { ids: ["gpt-4o"], dates: ["2026-01-01", "2026-12-11", "2027-02-01"] },
      cited,
      known,
      text,
      today: TODAY,
    });
    // gpt-image-1.5 is in the catalog under another page, so it isn't "not in the catalog".
    expect(r.newIds).toEqual([{ id: "gpt-image-1.5", inCatalog: true }, { id: "o3", inCatalog: true }, { id: "gpt-x", inCatalog: false }]);
    expect(r.newDates).toEqual(["2027-02-26"]);
    expect(r.goneFromPage).toEqual([]);
    expect(r.dateNotOnPage).toEqual([]);
  });

  it("flags a verified entry that left the page or whose date the page no longer shows", () => {
    const seen = { ids: ["gpt-image-1.5"], dates: ["2027-01-14"] };
    const r = comparePage({ seen, previous: seen, cited, known, text: "gpt-image-1.5 on 2027-01-14", today: TODAY });
    // Unverified (gpt-4o) and past (dall-e-2) entries are left alone.
    expect(r.goneFromPage).toEqual(["o3", "gemini-embedding-exp"]);
    expect(r.dateNotOnPage).toEqual(["o3 (2026-12-11)", "gemini-embedding-exp (2027-02-01)"]);
    // o3 still listed, but moved to a date already on the page: the old date is gone, so it is reported.
    const moved = comparePage({ seen: { ids: ["o3"], dates: ["2027-01-14"] }, previous: { ids: ["o3"], dates: ["2027-01-14"] }, cited, known, text: "o3 2027-01-14 gemini-embedding-exp 2027-02-01", today: TODAY });
    expect(moved.dateNotOnPage).toContain("o3 (2026-12-11)");
  });

  it("is quiet when nothing changed, and says so in the summary", () => {
    const seen = { ids: ["o3"], dates: ["2026-12-11", "2027-02-01"] };
    const r = { url: "https://example.com/deprecations", ...comparePage({ seen, previous: seen, cited, known, text, today: TODAY }) };
    expect(hasFindings(r)).toBe(false);
    expect(report([r], TODAY)).toMatch(/No changes on the 1 official pages/);
    const broken = { url: "https://example.com/x", error: "HTTP 503", newIds: [], newDates: [], goneFromPage: [], dateNotOnPage: [] };
    expect(report([r, broken], TODAY)).toMatch(/Could not read this page: HTTP 503/);
  });
});
