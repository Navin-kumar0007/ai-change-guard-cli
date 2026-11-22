import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmClient } from "@ai-change-guard/llm";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/main.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "acg-action-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

async function runAction(files: Record<string, string>, inputs: Record<string, string>, client?: LlmClient) {
  const dir = await workspace(files);
  const env: Record<string, string> = { GITHUB_WORKSPACE: dir, GITHUB_STEP_SUMMARY: join(dir, "summary.md") };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  const lines: string[] = [];
  const code = await run({ env, today: "2026-11-21", log: (l) => lines.push(l), client });
  return { code, lines, summary: await readFile(env.GITHUB_STEP_SUMMARY!, "utf8") };
}

const RETIRED = { "bot.py": 'from anthropic import Anthropic\nclient.messages.create(model="claude-3-5-sonnet-20241022", max_tokens=100)\n' };

describe("GitHub Action", () => {
  it("fails on a retired model and writes a job summary without a PR column", async () => {
    const { code, lines, summary } = await runAction(RETIRED, {});
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^::error::AI Change Guard: AI models and APIs: 1 retired/);
    expect(summary).toContain("`claude-3-5-sonnet-20241022`");
    expect(summary).toContain("| Model | Status | Where |\n");
    expect(summary).not.toContain("In this PR");
  });

  it("passes with fail-on: none", async () => {
    expect((await runAction(RETIRED, { "fail-on": "none" })).code).toBe(0);
  });

  it("rejects an unknown fail-on value", async () => {
    await expect(runAction(RETIRED, { "fail-on": "sometimes" })).rejects.toThrow(/fail-on/);
  });

  it("needs all three replay inputs together", async () => {
    await expect(runAction({}, { "old-model": "openai:a" })).rejects.toThrow(/all three inputs/);
  });

  it("runs a replay and fails when the new model breaks JSON output", async () => {
    const client: LlmClient = async (req) => ({
      text: req.model === "openai:old" ? '{"ok": true}' : "Sure! Here you go: ok",
      toolCalls: [],
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 1,
      refused: false,
    });
    const files = { "golden.jsonl": '{"id":"a","input":"Reply in JSON","expect":{"json":true}}\n' };
    const { code, lines, summary } = await runAction(
      files,
      { prompts: "golden.jsonl", "old-model": "openai:old", "new-model": "openai:new", runs: "2", concurrency: "1" },
      client,
    );
    expect(code).toBe(1);
    expect(lines.at(-1)).toBe("::error::AI Change Guard replay: 0 same, 0 changed, 1 broken");
    expect(summary).toContain("AI Change Guard: 0 AI models found");
  });
});

describe("bundled catalog data", () => {
  it("matches packages/catalog/data (run npm run build:action after catalog changes)", async () => {
    for (const file of ["models.json", "apis.json"]) {
      const bundled = await readFile(new URL(`../data/${file}`, import.meta.url), "utf8");
      const source = await readFile(new URL(`../../packages/catalog/data/${file}`, import.meta.url), "utf8");
      expect(bundled, file).toBe(source);
    }
  });
});

describe("Prompt Repair in the Action", () => {
  it("shows the fix in the Summary and still fails the step until it is applied", async () => {
    const client: LlmClient = async (req) => ({
      text: req.model === "openai:old" || req.system?.includes("Answer with one JSON value only") ? '{"ok": true}' : "Sure! Here you go: ok",
      toolCalls: [],
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 1,
      refused: false,
    });
    const files = { "golden.jsonl": '{"id":"a","input":"Reply in JSON","expect":{"json":true}}\n' };
    const inputs = { prompts: "golden.jsonl", "old-model": "openai:old", "new-model": "openai:new", runs: "2", concurrency: "1", repair: "true" };
    const { code, lines, summary } = await runAction(files, inputs, client);
    expect(code).toBe(1);
    expect(lines).toContain("AI Change Guard Prompt Repair: 1 of 1 format breaks fixed (2 extra calls); the fixes are in the Summary");
    expect(summary).toContain("### Prompt Repair");
    expect(summary).toContain("**Change for `a`:** add this to the end of the system prompt:");
  });

  it("skips repair when max-calls has no room left, and still reports the replay", async () => {
    const client: LlmClient = async (req) => ({
      text: req.model === "openai:old" ? '{"ok": true}' : "Sure! Here you go: ok",
      toolCalls: [],
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 1,
      refused: false,
    });
    const files = { "golden.jsonl": '{"id":"a","input":"Reply in JSON","expect":{"json":true}}\n' };
    const inputs = { prompts: "golden.jsonl", "old-model": "openai:old", "new-model": "openai:new", runs: "2", concurrency: "1", "max-calls": "5", repair: "true" };
    const { code, lines } = await runAction(files, inputs, client);
    expect(code).toBe(1);
    expect(lines).toContain("::warning::AI Change Guard Prompt Repair skipped: it could need 4 calls, and only 1 are left under the limit of 5.");
    expect(lines.at(-1)).toBe("::error::AI Change Guard replay: 0 same, 0 changed, 1 broken");
  });
});
