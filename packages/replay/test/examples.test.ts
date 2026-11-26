import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGoldenSet } from "../src/golden.js";

const EXAMPLES = join(import.meta.dirname, "../../../examples");

describe("golden set templates", () => {
  it("ships the three templates the README links, each loading with 10 prompts and unique ids", async () => {
    const files = (await readdir(EXAMPLES)).filter((f) => f.endsWith(".jsonl")).sort();
    expect(files).toEqual(["data-extraction.jsonl", "summariser.jsonl", "support-bot.jsonl"]);
    for (const file of files) {
      const items = await loadGoldenSet(join(EXAMPLES, file));
      expect(items, file).toHaveLength(10);
      expect(new Set(items.map((i) => i.id)).size, file).toBe(10);
    }
  });

  it("checks what each template is for: JSON schemas for extraction, kept facts for summaries", async () => {
    const extraction = await loadGoldenSet(join(EXAMPLES, "data-extraction.jsonl"));
    expect(extraction.every((i) => i.expect?.schema)).toBe(true);
    const summaries = await loadGoldenSet(join(EXAMPLES, "summariser.jsonl"));
    expect(summaries.every((i) => (i.expect?.contains?.length ?? 0) > 0)).toBe(true);
  });
});
