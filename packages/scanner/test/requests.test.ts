import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCheck } from "../src/check.js";
import { buildReport, formatText } from "../src/report.js";
import { claudeVersion, findRequestIssues, sdkOnNewApiVersion } from "../src/requests.js";
import { scanDirectory } from "../src/scan.js";

const py = (args: string) => `import anthropic\nclient = anthropic.Anthropic()\nr = client.messages.create(\n    ${args},\n    messages=[{"role": "user", "content": "hi"}],\n)\n`;
const rules = (file: string, content: string) => findRequestIssues(file, content, "code").map((f) => `${f.line} ${f.rule} ${f.detail}`);

describe("request settings Claude rejects", () => {
  it("reads the model generation from the ID", () => {
    expect(claudeVersion("claude-opus-4-7")).toMatchObject({ defaultsOnly: true, claude4: true });
    expect(claudeVersion("claude-opus-4-8")).toMatchObject({ defaultsOnly: true });
    expect(claudeVersion("claude-sonnet-4-6")).toMatchObject({ defaultsOnly: false, claude4: true });
    expect(claudeVersion("claude-sonnet-4-20250514")).toMatchObject({ defaultsOnly: false, claude4: true });
    expect(claudeVersion("claude-opus-4-5@20251101")).toMatchObject({ defaultsOnly: false, claude4: true });
    expect(claudeVersion("claude-haiku-5-5")).toMatchObject({ defaultsOnly: true, claude4: false });
    expect(claudeVersion("claude-sonnet-5")).toMatchObject({ defaultsOnly: true });
    expect(claudeVersion("claude-fable-5-2")).toMatchObject({ defaultsOnly: true });
    expect(claudeVersion("claude-3-5-sonnet-20241022")).toMatchObject({ defaultsOnly: false, claude4: false });
  });

  it("flags sampling a Claude 4.7+ model rejects today, in Python, TypeScript, Go and Java", () => {
    expect(rules("a.py", py('model="claude-opus-4-7", max_tokens=100, temperature=0.2'))).toEqual(["3 claude-sampling-not-accepted claude-opus-4-7 with temperature=0.2"]);
    const ts = 'import Anthropic from "@anthropic-ai/sdk";\nconst c = new Anthropic();\nawait c.messages.create({ model: "claude-haiku-5-5", max_tokens: 100, top_k: 5, messages });\n';
    expect(rules("a.ts", ts)).toEqual(["3 claude-sampling-not-accepted claude-haiku-5-5 with top_k=5"]);
    const go = 'import "github.com/anthropics/anthropic-sdk-go"\nmsg, err := client.Messages.New(ctx, anthropic.MessageNewParams{\n\tModel: "claude-sonnet-5",\n\tTemperature: anthropic.Float(0.3),\n})\n';
    expect(rules("a.go", go)).toEqual(["2 claude-sampling-not-accepted claude-sonnet-5 with temperature=anthropic.Float(0.3"]);
    const java = 'import com.anthropic.client.AnthropicClient;\nMessage m = client.messages().create(MessageCreateParams.builder()\n  .model("claude-opus-4-8").maxTokens(100).temperature(0.5).build());\n';
    expect(rules("A.java", java)).toEqual(["2 claude-sampling-not-accepted claude-opus-4-8 with temperature=0.5"]);
  });

  it("flags temperature with top_p on Claude 4, and the 2026-10-21 removal everywhere else", () => {
    expect(rules("a.py", py('model="claude-sonnet-4-5", temperature=0.7, top_p=0.9'))).toEqual(["3 claude-temperature-with-top-p claude-sonnet-4-5 with temperature=0.7, top_p=0.9"]);
    // Accepted today, rejected once the SDK sends 2026-10-21: lower values on 4.6, and even the default on 4.7+.
    expect(rules("a.py", py('model="claude-sonnet-4-6", temperature=0.2'))).toEqual(["3 anthropic-sampling-removed claude-sonnet-4-6 with temperature=0.2"]);
    expect(rules("a.py", py('model="claude-opus-5-5", temperature=1.0'))).toEqual(["3 anthropic-sampling-removed claude-opus-5-5 with temperature=1.0"]);
    // The model comes from a variable: only the version rule can be sure.
    expect(rules("a.py", py("model=MODEL, temperature=cfg.temp"))).toEqual(["3 anthropic-sampling-removed temperature=cfg.temp"]);
    // Sent through extra_body, the field still reaches the API.
    expect(rules("a.py", py('model="claude-opus-4-7", extra_body={"top_p": 0.9}'))).toEqual(["3 claude-sampling-not-accepted claude-opus-4-7 with top_p=0.9"]);
  });

  it("stays quiet when there is nothing to say", () => {
    expect(rules("a.py", py('model="claude-opus-4-7", max_tokens=100'))).toEqual([]);
    // OpenAI's Assistants API has its own messages.create, and no Anthropic import here.
    expect(rules("o.py", 'from openai import OpenAI\nOpenAI().beta.threads.messages.create(thread_id=t, temperature=0.2)\n')).toEqual([]);
    expect(rules("o.py", 'import anthropic\n# old: client.messages.create(model="claude-opus-4-7", temperature=0)\nOpenAI().beta.threads.messages.create(thread_id=t, temperature=0.2)\n')).toEqual([]);
    expect(findRequestIssues("README.md", py('model="claude-opus-4-7", temperature=0'), "doc")).toEqual([]);
    // A temperature used for something else, outside any Claude call.
    expect(rules("s.py", 'import anthropic\nsensor = read(temperature=21.5)\nclient.messages.create(model="claude-opus-4-7", max_tokens=10)\n')).toEqual([]);
  });

  it("ignores what the call doesn't send: comments, docstrings, prompt text, and values that leave the field out", () => {
    expect(rules("a.py", py('model="claude-opus-4-7",\n    # temperature=0.2,\n    max_tokens=10'))).toEqual([]);
    expect(rules("a.py", 'import anthropic\ndef f():\n    """Example:\n    client.messages.create(model="claude-opus-4-7", temperature=0.2)\n    """\n')).toEqual([]);
    expect(rules("a.py", py('model="claude-opus-4-7", messages=[{"role": "user", "content": "Report temperature: high or low"}]'))).toEqual([]);
    expect(rules("a.py", py('model="claude-opus-4-7", temperature=NOT_GIVEN'))).toEqual([]);
    const ts = 'import Anthropic from "@anthropic-ai/sdk";\nawait c.messages.create({ model: "claude-opus-4-7", temperature: isOld ? 0.2 : undefined, messages });\n';
    expect(rules("a.ts", ts)).toEqual([]);
  });

  it("reads the whole call and the model it really uses", () => {
    // A bracket inside a prompt doesn't end the call before the setting.
    expect(rules("a.py", py('model="claude-opus-4-7",\n    system="Be nice :)",\n    temperature=0.3'))).toEqual(["3 claude-sampling-not-accepted claude-opus-4-7 with temperature=0.3"]);
    // Of two models, the one that fails decides; a model held in a constant is followed.
    expect(rules("a.py", py('model="claude-sonnet-4-6" if x else "claude-opus-4-7", temperature=0.3'))).toEqual(["3 claude-sampling-not-accepted claude-opus-4-7 with temperature=0.3"]);
    const constant = 'import anthropic\nMODEL = "claude-opus-4-7"\nr = client.messages.create(model=settings.MODEL, temperature=0.2, messages=m)\n';
    expect(rules("a.py", constant)).toEqual(["3 claude-sampling-not-accepted claude-opus-4-7 with temperature=0.2"]);
    // The SDK's raw and streaming response wrappers are the same call.
    const raw = 'import anthropic\nr = client.messages.with_raw_response.create(model="claude-opus-4-7", temperature=0.2, messages=m)\n';
    expect(rules("a.py", raw)).toEqual(["2 claude-sampling-not-accepted claude-opus-4-7 with temperature=0.2"]);
  });

  it("knows which pinned SDK releases already send 2026-10-21, per language", () => {
    const py2 = { ecosystem: "PyPI" as const, name: "anthropic", version: "2.0.1", file: "uv.lock", line: 3 };
    const ts0 = { ecosystem: "npm" as const, name: "@anthropic-ai/sdk", version: "0.65.0", file: "package.json", line: 9 };
    expect(sdkOnNewApiVersion([py2, ts0], "PyPI")).toBe("anthropic 2.0.1 (uv.lock)");
    // A Python pin says nothing about the TypeScript calls in the same repository.
    expect(sdkOnNewApiVersion([py2, ts0], "npm")).toBeUndefined();
    expect(sdkOnNewApiVersion([{ ...ts0, version: "1.2.0" }], "npm")).toBe("@anthropic-ai/sdk 1.2.0 (package.json)");
    expect(sdkOnNewApiVersion([{ ...py2, version: "0.72.0" }], "PyPI")).toBeUndefined();
    expect(sdkOnNewApiVersion([{ ...py2, version: undefined }], "PyPI")).toBeUndefined();
    expect(sdkOnNewApiVersion([py2], undefined)).toBeUndefined();
  });

  it("fails the PR check when a pull request touches a call that already returns an error, and asks for a look otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acg-requests-check-"));
    await writeFile(join(dir, "app.py"), py('model="claude-opus-4-7", temperature=0.2'));
    const report = buildReport(await scanDirectory(dir), "demo", "2026-11-27");
    expect(buildCheck(report, ["app.py"]).conclusion).toBe("failure");
    const elsewhere = buildCheck(report, ["README.md"]);
    expect(elsewhere.conclusion).toBe("neutral");
    expect(elsewhere.title).toContain("1 Claude call with settings that return an error");
  });

  it("shows in the report, the job summary and the PR check, and says when it already breaks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acg-requests-"));
    await writeFile(join(dir, "app.py"), py('model="claude-sonnet-4-6", temperature=0.2'));
    await writeFile(join(dir, "requirements.txt"), "anthropic==2.0.1\n");
    // A TypeScript call in the same repository, on an SDK that still sends the old version.
    await writeFile(join(dir, "web.ts"), 'import Anthropic from "@anthropic-ai/sdk";\nawait c.messages.create({ model: "claude-sonnet-4-6", temperature: 0.2, messages });\n');
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { "@anthropic-ai/sdk": "0.65.0" } }));
    const report = buildReport(await scanDirectory(dir), "demo", "2026-11-27");
    expect(report.requests).toHaveLength(1);
    expect(report.requests![0]).toMatchObject({ rule: "anthropic-sampling-removed", sdk: "anthropic 2.0.1 (requirements.txt)" });
    expect(report.requests![0]!.findings).toEqual([
      { location: "app.py:3", detail: "claude-sonnet-4-6 with temperature=0.2", sdk: "anthropic 2.0.1 (requirements.txt)" },
      { location: "web.ts:2", detail: "claude-sonnet-4-6 with temperature=0.2" },
    ]);
    const text = formatText(report);
    expect(text).toContain("BREAKS NOW in the marked calls (anthropic 2.0.1 (requirements.txt) sends API version 2026-10-21)  Sampling setting removed in Claude API version 2026-10-21");
    expect(text).toContain("app.py:3  claude-sonnet-4-6 with temperature=0.2  <- breaks now");
    expect(text).toMatch(/web\.ts:2  claude-sonnet-4-6 with temperature=0\.2\n/);
    expect(text).toContain("source: https://platform.claude.com/docs/en/api/migration-2026-10-21");
    expect(buildCheck(report, null).summary).toContain("**Request settings that break:**");
  });
});
