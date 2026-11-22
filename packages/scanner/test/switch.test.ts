import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanDirectory } from "../src/scan.js";
import { applySwitch, planSwitch } from "../src/switch.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "acg-switch-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

async function plan(files: Record<string, string>, from: string, to: string) {
  const dir = await repo(files);
  return { dir, plan: await planSwitch(dir, (await scanDirectory(dir)).findings, from, to) };
}

describe("planSwitch", () => {
  it("replaces exact uses in code and config, and leaves longer IDs alone", async () => {
    const { dir, plan: p } = await plan(
      {
        "app.py": 'from openai import OpenAI\nclient.chat.completions.create(model="gpt-4o", messages=m)\nsmall = "gpt-4o-mini"\n',
        ".env": "OPENAI_MODEL=gpt-4o\n",
      },
      "gpt-4o",
      "gpt-6-luna",
    );
    expect(p.edits).toEqual([
      { file: ".env", line: 1, before: "OPENAI_MODEL=gpt-4o", after: "OPENAI_MODEL=gpt-6-luna" },
      { file: "app.py", line: 2, before: 'client.chat.completions.create(model="gpt-4o", messages=m)', after: 'client.chat.completions.create(model="gpt-6-luna", messages=m)' },
    ]);
    expect(p.skipped).toEqual([]);
    await applySwitch(dir, p);
    expect(await readFile(join(dir, "app.py"), "utf8")).toContain('small = "gpt-4o-mini"');
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("OPENAI_MODEL=gpt-6-luna\n");
  });

  it("keeps a gateway prefix and Windows line endings", async () => {
    const { plan: p } = await plan(
      { "router.ts": 'import OpenAI from "openai";\r\nconst model = "openrouter/openai/gpt-4o";\r\nconst b = "openai/gpt-4o";\r\n' },
      "gpt-4o",
      "gpt-6-luna",
    );
    expect(p.edits.map((e) => e.after)).toEqual(['const model = "openrouter/openai/gpt-6-luna";', 'const b = "openai/gpt-6-luna";']);
    expect(p.files.get("router.ts")).toBe('import OpenAI from "openai";\r\nconst model = "openrouter/openai/gpt-6-luna";\r\nconst b = "openai/gpt-6-luna";\r\n');
  });

  it("skips fine-tuned, Bedrock and Azure uses with a reason", async () => {
    const { plan: p } = await plan(
      {
        "a.py": [
          "import anthropic",
          'ft = "ft:gpt-4o-2024-08-06:acme::abc"',
          'azure = "azure/gpt-4o-2024-08-06"',
          "",
        ].join("\n"),
      },
      "gpt-4o-2024-08-06",
      "gpt-6-luna",
    );
    expect(p.edits).toEqual([]);
    expect(p.skipped.map((s) => s.reason)).toEqual([expect.stringMatching(/^Fine-tuned/), expect.stringMatching(/^Azure/)]);

    const bedrock = await plan({ "b.py": 'import boto3\nm = "anthropic.claude-3-5-sonnet-20241022-v2:0"\n' }, "claude-3-5-sonnet-20241022", "claude-sonnet-4-5");
    expect(bedrock.plan.skipped).toEqual([expect.objectContaining({ line: 2, reason: expect.stringMatching(/^Bedrock/) })]);
  });

  it("changes every use on one line", async () => {
    const { plan: p } = await plan({ "c.yaml": "models: [gemini-2.0-flash, 'gemini-2.0-flash']\n" }, "gemini-2.0-flash", "gemini-3.1-flash-lite");
    expect(p.files.get("c.yaml")).toBe("models: [gemini-3.1-flash-lite, 'gemini-3.1-flash-lite']\n");
  });

  it("changes every form on a line, key:value config, and never a comment", async () => {
    const { plan: p } = await plan(
      {
        "a.py": 'import openai\nmodels = ["gpt-4o", "openai/gpt-4o"]  # gpt-4o retires soon\n',
        "app.properties": "model:gpt-4o\n",
      },
      "gpt-4o",
      "gpt-6-luna",
    );
    expect(p.files.get("a.py")).toBe('import openai\nmodels = ["gpt-6-luna", "openai/gpt-6-luna"]  # gpt-4o retires soon\n');
    expect(p.files.get("app.properties")).toBe("model:gpt-6-luna\n");
    expect(p.skipped).toEqual([]);
  });

  it("with a prefix, only changes uses on the route the replay tested", async () => {
    const dir = await repo({ "r.ts": 'import OpenAI from "openai";\nconst a = "openai/gpt-4o";\nconst b = "gpt-4o";\n' });
    const p = await planSwitch(dir, (await scanDirectory(dir)).findings, "gpt-4o", "gpt-6-luna", { prefix: "openai" });
    expect(p.edits.map((e) => e.line)).toEqual([2]);
    expect(p.skipped).toEqual([expect.objectContaining({ line: 3, reason: "Not called through openai/, the route the replay tested." })]);
  });

  it("rejects a new model ID that could break the code", async () => {
    await expect(plan({ "a.py": 'm = "gpt-4o"\n' }, "gpt-4o", 'gpt-5"; os.system("x')).rejects.toThrow(/may only contain/);
    await expect(plan({ "a.py": 'm = "gpt-4o"\n' }, "gpt-4o", "GPT-4o")).rejects.toThrow(/same/);
  });
});
