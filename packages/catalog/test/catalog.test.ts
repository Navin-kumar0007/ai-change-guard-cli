import { describe, expect, it } from "vitest";
import { apis, models } from "../src/index.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const real = (d: string) => DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);

describe("the retirement catalog", () => {
  it("lists each model once per platform", () => {
    const keys = models.map((m) => `${m.platform}:${m.id}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it("gives every entry a real date and a source with the day it was checked", () => {
    for (const e of [...models, ...apis]) {
      expect(real(e.retiresOn), `${e.id}: ${e.retiresOn}`).toBe(true);
      expect(e.sources.length, e.id).toBeGreaterThan(0);
      for (const s of e.sources) {
        expect(s.url, e.id).toMatch(/^https:\/\//);
        expect(real(s.checked), `${e.id}: checked ${s.checked}`).toBe(true);
      }
    }
  });

  it("explains every date that is not read straight off the official page", () => {
    for (const e of [...models, ...apis]) if (!e.verified) expect(e.note, e.id).toBeTruthy();
  });

  it("never names a model as its own replacement or reroute", () => {
    for (const m of models) {
      expect(m.replacement, m.id).not.toBe(m.id);
      expect(m.reroutesTo, m.id).not.toBe(m.id);
    }
  });
});
