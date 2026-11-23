import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCheck } from "../src/check.js";
import { baselineModelId, buildLock, compareLock, formatLockChanges, LockError, parseBaselineSummary, parseLock, serializeLock, type AiStackLock } from "../src/lock.js";
import { buildReport, formatText, refreshReport } from "../src/report.js";
import { scanDirectory } from "../src/scan.js";

const TODAY = "2026-11-24";

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "acg-lock-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

const APP = { "app.py": 'from openai import OpenAI\nOpenAI().chat.completions.create(model="gpt-4o", messages=[])\n', "requirements.txt": "openai==1.99.0\n" };

describe("ai-stack.lock", () => {
  it("lists models with catalog facts, packages and baselines, with files but no line numbers", async () => {
    const baseline = JSON.stringify({ version: 1, model: "openai:gpt-4o", createdAt: "2026-11-20T00:00:00.000Z", runs: 5, items: [{ id: "a", hash: "x" }], records: [] });
    const dir = await project({ ...APP, "golden.baseline.json": baseline });
    const report = buildReport(await scanDirectory(dir), "demo", TODAY);
    const lock = buildLock(report, report.baselines);
    expect(lock.models.find((m) => m.id === "gpt-4o")).toMatchObject({ platform: "openai-api", files: ["app.py"], retiresOn: "2027-01-14", replacement: "gpt-6-luna", price: { input: 2.5, output: 10 } });
    expect(lock.packages).toEqual([{ ecosystem: "PyPI", name: "openai", versions: ["1.99.0"], files: ["requirements.txt"] }]);
    expect(lock.baselines).toEqual([{ file: "golden.baseline.json", model: "openai:gpt-4o", createdAt: "2026-11-20T00:00:00.000Z", prompts: 1 }]);
    // Same scan, same file: nothing in it depends on the day or on line numbers.
    expect(serializeLock(buildLock(buildReport(await scanDirectory(dir), "demo", "2026-11-25"), report.baselines))).toBe(serializeLock(lock));
  });

  it("is up to date right after writing, and reports code changes as outdated", async () => {
    const dir = await project(APP);
    await writeFile(join(dir, "ai-stack.lock"), serializeLock(buildLock(buildReport(await scanDirectory(dir), "demo", TODAY))));
    const clean = buildReport(await scanDirectory(dir), "demo", TODAY);
    expect(clean.lock).toEqual({ file: expect.any(Object), changes: [] });
    expect(formatText(clean)).toContain("ai-stack.lock: up to date with the code and the catalog.");

    await writeFile(join(dir, "app.py"), APP["app.py"].replace("gpt-4o", "gpt-6-luna"));
    await writeFile(join(dir, "requirements.txt"), "openai==2.0.0\n");
    const changed = buildReport(await scanDirectory(dir), "demo", TODAY);
    const changes = changed.lock && "changes" in changed.lock ? changed.lock.changes : [];
    expect(changes.map((c) => `${c.kind}: ${c.subject}: ${c.detail}`)).toEqual([
      "outdated: model gpt-6-luna (openai-api): new in the code (app.py)",
      "outdated: model gpt-4o (openai-api): no longer in the code",
      "outdated: package openai (PyPI): 1.99.0 when locked; now 2.0.0",
    ]);
    const check = buildCheck(changed, ["app.py"]);
    expect(check.summary).toContain("**`ai-stack.lock`: out of date with the code.** To fix: run ai-change-guard lock and commit it");
  });

  it("reports catalog changes since the lock: a retirement announced, a price change", () => {
    const current: AiStackLock = {
      lockfileVersion: 1,
      models: [{ id: "gpt-4o", platform: "openai-api", files: ["app.py"], retiresOn: "2027-01-14", replacement: "gpt-6-luna", price: { input: 2.5, output: 10 }, priceChanges: ["2027-02-01"] }],
      apis: [],
      packages: [],
      baselines: [],
    };
    const locked: AiStackLock = { ...current, models: [{ id: "gpt-4o", platform: "openai-api", files: ["app.py"], price: { input: 2, output: 8 } }] };
    expect(compareLock(locked, current)).toEqual([
      { kind: "catalog", subject: "model gpt-4o (openai-api)", detail: "no retirement announced when locked; now retires on 2027-01-14" },
      { kind: "catalog", subject: "model gpt-4o (openai-api)", detail: "replacement none when locked; now gpt-6-luna" },
      { kind: "catalog", subject: "model gpt-4o (openai-api)", detail: "list price $2 / $8 when locked; now $2.5 / $10" },
      { kind: "catalog", subject: "model gpt-4o (openai-api)", detail: "price change announced for 2027-02-01" },
    ]);
  });

  it("flags a baseline for a model the code no longer uses", () => {
    const lock: AiStackLock = {
      lockfileVersion: 1,
      models: [{ id: "gpt-6-luna", platform: "openai-api", files: ["app.py"] }],
      apis: [],
      packages: [],
      baselines: [{ file: "golden.baseline.json", model: "openai:gpt-4o", createdAt: "2026-11-20", prompts: 5 }],
    };
    expect(compareLock(lock, lock)).toEqual([
      { kind: "unverified", subject: "baseline golden.baseline.json", detail: "verifies openai:gpt-4o, which the code no longer uses" },
    ]);
  });

  it("re-compares a stored report's lock with today's catalog when it is refreshed", async () => {
    const dir = await project(APP);
    const lock = buildLock(buildReport(await scanDirectory(dir), "demo", TODAY));
    // Pretend the lock was written before gpt-4o's retirement was announced.
    const old = { ...lock, models: lock.models.map(({ retiresOn: _r, replacement: _p, ...m }) => m) };
    await writeFile(join(dir, "ai-stack.lock"), serializeLock(old));
    const stored = buildReport(await scanDirectory(dir), "demo", TODAY);
    const fresh = refreshReport(stored, "2026-12-01");
    const changes = fresh.lock && "changes" in fresh.lock ? fresh.lock.changes : [];
    expect(changes.map((c) => c.kind)).toEqual(["catalog", "catalog"]);
    expect(changes[0]!.detail).toContain("now retires on 2027-01-14");
  });

  it("explains a lock it cannot read", async () => {
    expect(() => parseLock("{nope")).toThrow(LockError);
    expect(() => parseLock('{"lockfileVersion": 9}')).toThrow(/lockfileVersion 9/);
    const dir = await project({ ...APP, "ai-stack.lock": "{nope" });
    const report = buildReport(await scanDirectory(dir), "demo", TODAY);
    expect(report.lock).toEqual({ error: "ai-stack.lock is not valid JSON. Fix it, or delete it and write a new one with: ai-change-guard lock" });
  });

  it("reads only real baseline files", () => {
    expect(parseBaselineSummary("x.baseline.json", '{"version":1,"model":"openai:gpt-4o","createdAt":"2026-11-20","items":[]}')).toMatchObject({ prompts: 0 });
    expect(parseBaselineSummary("x.baseline.json", '{"model":"x"}')).toBeUndefined();
    expect(parseBaselineSummary("x.baseline.json", "not json")).toBeUndefined();
  });
});

describe("lock review fixes", () => {
  it("stores the catalog's list price and announced change dates, so the file does not change as days pass", async () => {
    const dir = await project({ "app.py": 'client.models.generate_content(model="gemini-4-carbon", contents=x)\nclient.models.generate_content(model="gemini-2.5-pro", contents=x)\n' });
    const lockOn = async (day: string) => buildLock(buildReport(await scanDirectory(dir), "demo", day));
    const before = await lockOn("2026-11-24");
    expect(before.models.find((m) => m.id === "gemini-4-carbon")).toMatchObject({ price: { input: 2, output: 10 }, priceChanges: ["2026-12-01"] });
    // On and well after the announced change day (and the gemini-2.5-pro reroute), nothing differs.
    for (const day of ["2026-12-01", "2027-03-01"]) {
      expect(serializeLock(await lockOn(day))).toBe(serializeLock(before));
      expect(compareLock(before, await lockOn(day))).toEqual([]);
    }
  });

  it("matches baselines to models the way the scanner names them", () => {
    expect(baselineModelId("openrouter:openai/gpt-4o")).toBe("gpt-4o");
    expect(baselineModelId("google:models/gemini-2.5-flash")).toBe("gemini-2.5-flash");
    const lock: AiStackLock = { lockfileVersion: 1, models: [{ id: "gpt-4o", platform: "openai-api", files: ["a.py"] }], apis: [], packages: [], baselines: [{ file: "b.baseline.json", model: "openrouter:openai/gpt-4o", createdAt: "x", prompts: 1 }] };
    expect(compareLock(lock, lock)).toEqual([]);
  });

  it("does not count model names inside a baseline file as models the code uses", async () => {
    const baseline = JSON.stringify({ version: 1, model: "openai:gpt-6-luna", createdAt: "2026-11-20", runs: 1, items: [{ id: "a", hash: "x" }], records: [{ itemId: "a", run: 0, response: { servedModel: "gpt-4o-2024-08-06" } }] });
    const dir = await project({ "app.py": 'OpenAI().chat.completions.create(model="gpt-6-luna", messages=m)\n', "golden.baseline.json": baseline });
    const report = buildReport(await scanDirectory(dir), "demo", TODAY);
    expect(report.models.map((m) => m.id)).toEqual(["gpt-6-luna"]);
  });

  it("reports an API or package used in a new file", () => {
    const base: AiStackLock = { lockfileVersion: 1, models: [], apis: [{ id: "x", name: "Old API", retiresOn: "2027-01-01", files: ["a.py"] }], packages: [{ ecosystem: "PyPI", name: "openai", versions: ["1.0"], files: ["requirements.txt"] }], baselines: [] };
    const now: AiStackLock = { ...base, apis: [{ ...base.apis[0]!, files: ["a.py", "b.py"] }], packages: [{ ...base.packages[0]!, files: ["requirements-dev.txt", "requirements.txt"] }] };
    expect(compareLock(base, now).map((c) => c.detail)).toEqual(["now used in a.py, b.py", "now declared in requirements-dev.txt, requirements.txt"]);
  });

  it("says plainly when an edited or merged lock is damaged", () => {
    expect(() => parseLock("null")).toThrow(/not a lock file/);
    expect(() => parseLock('{"lockfileVersion":1,"packages":[{"ecosystem":"PyPI","name":"x","files":[]}]}')).toThrow(/"packages" is damaged/);
    expect(() => parseLock('{"lockfileVersion":1,"models":{}}')).toThrow(/"models" is damaged/);
  });

  it("groups changes with what to do for each, the same in text and in the pull request check", () => {
    const text = formatLockChanges([
      { kind: "unverified", subject: "baseline b.baseline.json", detail: "verifies openai:gpt-4o, which the code no longer uses" },
      { kind: "catalog", subject: "model gpt-4o (openai-api)", detail: "x" },
    ]);
    expect(text).toEqual([
      "ai-stack.lock: changed in the catalog since the lock was written (check these, then run ai-change-guard lock and commit):",
      "  model gpt-4o (openai-api): x",
      "ai-stack.lock: model switched without a new baseline (make a new baseline for the model in use with ai-change-guard baseline):",
      "  baseline b.baseline.json: verifies openai:gpt-4o, which the code no longer uses",
    ]);
  });
});
