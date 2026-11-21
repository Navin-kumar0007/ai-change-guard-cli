import { describe, expect, it } from "vitest";
import type { Finding } from "../src/detect.js";
import { buildReport, daysBetween, formatText } from "../src/report.js";
import type { ScanResult } from "../src/scan.js";

const TODAY = "2026-11-17";

function modelFinding(file: string, line: number, id: string, provider: "openai" | "anthropic" | "google"): Finding {
  return { file, line, kind: "model", snippet: "", model: { provider, id, raw: id } };
}

function result(findings: Finding[]): ScanResult {
  return {
    root: "/tmp/x",
    filesScanned: 3,
    aiFiles: 2,
    callSites: 4,
    findings,
    tokenTips: [
      { file: "a.py", line: 3, rule: "no-output-limit", snippet: "" },
      { file: "b.py", line: 9, rule: "no-output-limit", snippet: "" },
    ],
  };
}

describe("daysBetween", () => {
  it("counts whole days", () => {
    expect(daysBetween(TODAY, "2027-01-14")).toBe(58);
    expect(daysBetween(TODAY, "2026-12-01")).toBe(14);
    expect(daysBetween(TODAY, TODAY)).toBe(0);
  });
});

describe("buildReport", () => {
  const report = buildReport(
    result([
      modelFinding("a.py", 3, "gpt-4o", "openai"),
      modelFinding("b.py", 9, "gpt-4o", "openai"),
      modelFinding("c.ts", 1, "claude-3-5-sonnet-20241022", "anthropic"),
      modelFinding("d.ts", 2, "gemini-2.5-flash", "google"),
      modelFinding("e.ts", 5, "gpt-9-imaginary", "openai"),
      { file: "f.py", line: 7, kind: "dynamic-model", snippet: "model=cfg.model" },
      { file: "g.py", line: 2, kind: "deprecated-api", snippet: "", apiId: "openai-reusable-prompts-api" },
    ]),
    "demo",
    TODAY,
  );

  it("orders retired first, then retiring, rerouting and unknown", () => {
    expect(report.models.map((m) => [m.id, m.status])).toEqual([
      ["claude-3-5-sonnet-20241022", "retired"],
      ["gpt-4o", "retiring"],
      ["gemini-2.5-flash", "rerouting"],
      ["gpt-9-imaginary", "no-known-retirement"],
    ]);
  });

  it("groups locations and counts days left", () => {
    const gpt = report.models.find((m) => m.id === "gpt-4o");
    expect(gpt?.locations).toEqual(["a.py:3", "b.py:9"]);
    expect(gpt?.daysLeft).toBe(58);
    expect(gpt?.otherPlatforms).toEqual([{ platform: "azure-openai", date: "2027-04-14" }]);
  });

  it("shows where a rerouted model goes", () => {
    const gemini = report.models.find((m) => m.id === "gemini-2.5-flash");
    expect(gemini?.reroutesTo).toBe("gemini-3.5-flash-lite");
    expect(gemini?.daysLeft).toBe(14);
  });

  it("lists runtime models and deprecated APIs", () => {
    expect(report.dynamic).toEqual([{ location: "f.py:7", snippet: "model=cfg.model" }]);
    expect(report.apis[0]?.id).toBe("openai-reusable-prompts-api");
    expect(report.apis[0]?.daysLeft).toBe(13);
  });

  it("prints a readable text report", () => {
    const text = formatText(report);
    expect(text).toContain("RETIRES in 58 days (2027-01-14)*");
    expect(text).toContain("a.py:3 (+1 more)");
    expect(text).toContain("SHUTS DOWN in 13 days (2026-11-30)  OpenAI Reusable Prompts API");
    expect(text).toContain("Model set at runtime");
    expect(text).toContain("Token Saver: ways to cut your AI bill");
    expect(text).toContain("No output limit on the AI call  a.py:3 (+1 more)");
  });

  it("explains an empty result", () => {
    const text = formatText(buildReport(result([]), "empty", TODAY));
    expect(text).toContain("No AI model IDs found");
  });
});

describe("unverified footnote", () => {
  it("is shown only when a listed date is unverified", () => {
    const verified = formatText(buildReport(result([modelFinding("a.py", 1, "gpt-4o-2024-08-06", "openai")]), "x", TODAY));
    expect(verified).not.toContain("not yet verified");
    const unverified = formatText(buildReport(result([modelFinding("a.py", 1, "gpt-4o", "openai")]), "x", TODAY));
    expect(unverified).toMatch(/\d{4}-\d{2}-\d{2}\)?\*/);
    expect(unverified).toContain("not yet verified");
  });
});
