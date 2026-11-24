import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const split = (text: string) => {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error("no frontmatter");
  return { front: m[1]!, body: m[2]! };
};

describe("AI coding tool integrations", () => {
  it("the Claude Code marketplace lists the plugin under the same name as its manifest", async () => {
    const market = JSON.parse(await read(".claude-plugin/marketplace.json"));
    const plugin = JSON.parse(await read("plugins/ai-change-guard/.claude-plugin/plugin.json"));
    expect(market.plugins).toEqual([expect.objectContaining({ name: plugin.name, source: "./plugins/ai-change-guard" })]);
    expect(plugin.name).toBe("ai-change-guard");
  });

  it("the skill has a name and a description that says when to use it", async () => {
    const { front } = split(await read("plugins/ai-change-guard/skills/check-ai-models/SKILL.md"));
    expect(front).toMatch(/^name: check-ai-models$/m);
    expect(front).toMatch(/^description: .*Use when .*retiring/m);
  });

  it("the Cursor rule says exactly what the skill says (regenerate it when the skill changes)", async () => {
    const skill = split(await read("plugins/ai-change-guard/skills/check-ai-models/SKILL.md"));
    const rule = split(await read("integrations/cursor/ai-change-guard.mdc"));
    expect(rule.body).toBe(skill.body);
    expect(rule.front).toContain(/^description: (.*)$/m.exec(skill.front)![1]!);
    expect(rule.front).toMatch(/^alwaysApply: false$/m);
  });
});
