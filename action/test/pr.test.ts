import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmClient } from "@ai-change-guard/llm";
import { afterEach, describe, expect, it } from "vitest";
import { run, switchIds } from "../src/main.js";
import { branchName, GitHubError, gitBlobSha, type GitHubApi } from "../src/pr.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const SHA = "a".repeat(40);
const BRANCH = "ai-change-guard/gpt-4o-to-gpt-6-luna";
const OUR_COMMIT = { commit: { message: "Switch gpt-4o to gpt-6-luna\n\nReplayed 1 prompts" } };

const FILES: Record<string, string> = {
  "src/bot.py": 'from openai import OpenAI\nclient.chat.completions.create(model="gpt-4o", messages=m)\n',
  "golden.jsonl": '{"id":"a","input":"Reply in JSON","expect":{"json":true}}\n',
};

interface Call {
  method: string;
  path: string;
  body?: any;
}

interface FakeOptions {
  pulls?: { number: number; state: string; merged_at?: string | null; html_url: string }[];
  headSha?: string;
  refExists?: boolean;
  denyPulls?: boolean;
  racePulls?: boolean;
  compare?: { ahead_by: number; behind_by: number; commits: { commit: { message: string } }[] };
  /** Files committed at SHA (path → content); defaults to FILES. */
  committed?: Record<string, string>;
}

/** A fake GitHub that answers like the REST API and records every call. */
function fakeGitHub(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  let pullsListed = 0;
  const api: GitHubApi = async <T>(method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const reply = (value: unknown) => value as T;
    if (method === "GET" && path === "/repos/acme/bot") return reply({ default_branch: "main" });
    if (method === "GET" && path === "/repos/acme/bot/git/ref/heads/main") return reply({ object: { sha: opts.headSha ?? SHA } });
    if (method === "GET" && path === `/repos/acme/bot/git/trees/${SHA}?recursive=1`) {
      const files = Object.entries(opts.committed ?? FILES);
      return reply({ truncated: false, tree: files.map(([p, c]) => ({ path: p, mode: "100644", type: "blob", sha: gitBlobSha(Buffer.from(c)) })) });
    }
    if (method === "GET" && path.startsWith("/repos/acme/bot/pulls?")) {
      pullsListed++;
      if (opts.racePulls && pullsListed > 1) return reply([{ number: 9, state: "open", html_url: "https://github.com/acme/bot/pull/9" }]);
      return reply(opts.pulls ?? []);
    }
    if (method === "GET" && path === `/repos/acme/bot/compare/main...${encodeURIComponent(BRANCH)}`) {
      return reply(opts.compare ?? { ahead_by: 1, behind_by: 0, commits: [OUR_COMMIT] });
    }
    if (method === "GET" && path === `/repos/acme/bot/git/commits/${SHA}`) return reply({ tree: { sha: "base-tree" } });
    if (method === "POST" && path === "/repos/acme/bot/git/trees") return reply({ sha: "new-tree" });
    if (method === "POST" && path === "/repos/acme/bot/git/commits") return reply({ sha: "new-commit" });
    if (method === "POST" && path === "/repos/acme/bot/git/refs") {
      if (opts.refExists) throw new GitHubError(422, "GitHub 422 on POST /repos/acme/bot/git/refs: Reference already exists");
      return reply({});
    }
    if (method === "PATCH" && path.startsWith("/repos/acme/bot/git/refs/heads/")) return reply({});
    if (method === "POST" && path === "/repos/acme/bot/pulls") {
      if (opts.denyPulls) throw new GitHubError(403, "GitHub 403 on POST /repos/acme/bot/pulls: GitHub Actions is not permitted to create or approve pull requests.");
      if (opts.racePulls) throw new GitHubError(422, "GitHub 422 on POST /repos/acme/bot/pulls: A pull request already exists");
      return reply({ number: 7, html_url: "https://github.com/acme/bot/pull/7" });
    }
    if (method === "PATCH" && path.startsWith("/repos/acme/bot/pulls/")) return reply({});
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, calls };
}

const passing: LlmClient = async () => ({ text: '{"ok": true}', toolCalls: [], inputTokens: 10, outputTokens: 5, latencyMs: 1, refused: false });

async function runWithPr(
  github: GitHubApi,
  {
    client = passing,
    inputs = {},
    ref = "refs/heads/main",
    files = FILES,
  }: { client?: LlmClient; inputs?: Record<string, string>; ref?: string; files?: Record<string, string> } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "acg-pr-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  const env: Record<string, string> = {
    GITHUB_WORKSPACE: dir,
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    GITHUB_REPOSITORY: "acme/bot",
    GITHUB_REF: ref,
    GITHUB_SHA: SHA,
  };
  const all = { prompts: "golden.jsonl", "old-model": "openai:gpt-4o", "new-model": "openai:gpt-6-luna", runs: "1", concurrency: "1", "open-pr": "true", ...inputs };
  for (const [k, v] of Object.entries(all)) env[`INPUT_${k.toUpperCase()}`] = v;
  const lines: string[] = [];
  const code = await run({ env, today: "2026-11-22", log: (l) => lines.push(l), client, github });
  return { code, lines, summary: await readFile(env.GITHUB_STEP_SUMMARY!, "utf8"), dir };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
const prBody = (calls: Call[]) => calls.find((c) => c.path.startsWith("/repos/acme/bot/pulls") && c.method !== "GET")!.body.body as string;

describe("evidence pull request", () => {
  it("commits the switch to a branch and opens a PR with the replay as proof", async () => {
    const { api, calls } = fakeGitHub();
    const { code, lines, summary, dir } = await runWithPr(api);
    expect(code).toBe(0);
    expect(lines.at(-1)).toBe("AI Change Guard created pull request #7: https://github.com/acme/bot/pull/7");
    expect(summary).toContain("[#7](https://github.com/acme/bot/pull/7)");

    expect(calls.find((c) => c.path.endsWith("/git/trees"))!.body).toEqual({
      base_tree: "base-tree",
      tree: [{ path: "src/bot.py", mode: "100644", type: "blob", content: 'from openai import OpenAI\nclient.chat.completions.create(model="gpt-6-luna", messages=m)\n' }],
    });
    expect(calls.find((c) => c.path.endsWith("/git/commits") && c.method === "POST")!.body.parents).toEqual([SHA]);
    expect(calls.find((c) => c.path.endsWith("/git/refs"))!.body).toEqual({ ref: `refs/heads/${BRANCH}`, sha: "new-commit" });

    const pr = calls.find((c) => c.method === "POST" && c.path === "/repos/acme/bot/pulls")!.body;
    expect(pr).toMatchObject({ head: BRANCH, base: "main", title: "Switch gpt-4o to gpt-6-luna (tested on 1 real prompt)" });
    expect(pr.body).toContain("| 1 | 0 | 0 | 0 |");
    expect(pr.body).toContain("`src/bot.py:2`");
    expect(pr.body).toMatch(/<summary>Full replay report<\/summary>[\s\S]*<\/details>$/);
    // The working tree is not touched; the commit is built through the API.
    expect(await readFile(join(dir, "src/bot.py"), "utf8")).toContain('"gpt-4o"');
  });

  it("never commits an untracked or gitignored file, or one an earlier step changed", async () => {
    const files = { ...FILES, ".env": "OPENAI_API_KEY=secret\nMODEL=gpt-4o\n", "src/gen.py": 'import openai\nm = "gpt-4o"\n' };
    const committed = { ...FILES, "src/gen.py": 'import openai\nm = "gpt-4o"  # before codegen\n' };
    const { api, calls } = fakeGitHub({ committed });
    await runWithPr(api, { files });
    expect(calls.find((c) => c.path.endsWith("/git/trees"))!.body.tree.map((e: { path: string }) => e.path)).toEqual(["src/bot.py"]);
    const body = prBody(calls);
    expect(body).toContain("`.env:2`: `gpt-4o`. Not committed in the repository (untracked or gitignored)");
    expect(body).toContain("`src/gen.py:2`: `gpt-4o`. Changed by an earlier step of this job");
    expect(body).not.toContain("secret");
  });

  it("refreshes only the report on an open PR whose branch is current", async () => {
    const { api, calls } = fakeGitHub({ pulls: [{ number: 3, state: "open", html_url: "https://github.com/acme/bot/pull/3" }] });
    const { lines } = await runWithPr(api);
    expect(lines.at(-1)).toBe("AI Change Guard updated pull request #3: https://github.com/acme/bot/pull/3");
    expect(writes(calls)).toEqual(["PATCH /repos/acme/bot/pulls/3"]);
  });

  it("rebuilds its own branch when main moved on, so the PR matches its description", async () => {
    const { api, calls } = fakeGitHub({
      pulls: [{ number: 3, state: "open", html_url: "x" }],
      compare: { ahead_by: 1, behind_by: 4, commits: [OUR_COMMIT] },
    });
    await runWithPr(api);
    expect(writes(calls)).toEqual([
      "POST /repos/acme/bot/git/trees",
      "POST /repos/acme/bot/git/commits",
      `PATCH /repos/acme/bot/git/refs/heads/${BRANCH}`,
      "PATCH /repos/acme/bot/pulls/3",
    ]);
  });

  it("never pushes over commits people added, and says so on the PR", async () => {
    const { api, calls } = fakeGitHub({
      pulls: [{ number: 3, state: "open", html_url: "x" }],
      compare: { ahead_by: 2, behind_by: 4, commits: [OUR_COMMIT, { commit: { message: "Fix prompt for new model" } }] },
    });
    await runWithPr(api);
    expect(writes(calls)).toEqual(["PATCH /repos/acme/bot/pulls/3"]);
    expect(prBody(calls)).toMatch(/^> People have added commits to this branch/);
  });

  it("respects a PR closed without merging, but opens a new one after a merged PR", async () => {
    const closed = fakeGitHub({ pulls: [{ number: 3, state: "closed", merged_at: null, html_url: "x" }] });
    expect((await runWithPr(closed.api)).lines.at(-1)).toMatch(/^::notice::.*#3 for this switch was closed without merging/);
    expect(writes(closed.calls)).toEqual([]);

    const merged = fakeGitHub({ pulls: [{ number: 3, state: "closed", merged_at: "2026-11-01T00:00:00Z", html_url: "x" }], refExists: true });
    expect((await runWithPr(merged.api)).lines.at(-1)).toMatch(/created pull request #7/);
  });

  it("resets a leftover branch of its own, but not one with other commits", async () => {
    const own = fakeGitHub({ refExists: true });
    await runWithPr(own.api);
    expect(own.calls.find((c) => c.method === "PATCH")).toEqual({ method: "PATCH", path: `/repos/acme/bot/git/refs/heads/${BRANCH}`, body: { sha: "new-commit", force: true } });

    const someoneElse = fakeGitHub({ refExists: true, compare: { ahead_by: 3, behind_by: 0, commits: [] } });
    expect((await runWithPr(someoneElse.api)).lines.at(-1)).toMatch(/already exists with other commits/);
    expect(writes(someoneElse.calls).some((w) => w.startsWith("PATCH"))).toBe(false);
  });

  it("treats a PR another run opened a moment ago as an update", async () => {
    const { api, calls } = fakeGitHub({ racePulls: true });
    expect((await runWithPr(api)).lines.at(-1)).toBe("AI Change Guard updated pull request #9: https://github.com/acme/bot/pull/9");
    expect(writes(calls).at(-1)).toBe("PATCH /repos/acme/bot/pulls/9");
  });

  it("opens nothing from a pull request run or when main moved on", async () => {
    const fromPr = fakeGitHub();
    expect((await runWithPr(fromPr.api, { ref: "refs/pull/5/merge" })).lines.at(-1)).toMatch(/runs on main/);
    const moved = fakeGitHub({ headSha: "b".repeat(40) });
    expect((await runWithPr(moved.api)).lines.at(-1)).toMatch(/main moved on/);
    expect(writes([...fromPr.calls, ...moved.calls])).toEqual([]);
  });

  it("opens nothing when the replay finds a broken prompt", async () => {
    const breaking: LlmClient = async (req) => ({ ...(await passing(req)), text: req.model === "openai:gpt-4o" ? '{"ok": true}' : "Sure! ok" });
    const { api, calls } = fakeGitHub();
    const { code, lines } = await runWithPr(api, { client: breaking });
    expect(code).toBe(1);
    expect(lines.at(-1)).toMatch(/^::notice::AI Change Guard: no pull request, because the replay did not pass/);
    expect(calls).toEqual([]);
  });

  it("explains the repository setting when GitHub refuses to open the PR", async () => {
    const { api } = fakeGitHub({ denyPulls: true });
    await expect(runWithPr(api)).rejects.toThrow(/Allow GitHub Actions to create and approve pull requests/);
  });

  it("Money-Finder opens the switch PR to the cheaper model that passed, with the savings card", async () => {
    const { api, calls } = fakeGitHub();
    const { code, lines, summary } = await runWithPr(api, { inputs: { "find-savings": "true", "new-model": "", candidates: "openai:gpt-6-luna", "calls-per-month": "10000" } });
    expect(code).toBe(0);
    expect(summary).toContain("## Money-Finder: `openai:gpt-4o`");
    expect(lines).toContain("AI Change Guard Money-Finder: openai:gpt-6-luna passes and is 95% cheaper per call");
    const body = prBody(calls);
    expect(body).toContain("**Switch to `openai:gpt-6-luna`: 95% cheaper per call");
    expect(body).toContain("a month");
    expect(body).not.toContain("## Money-Finder");
  });

  it("Money-Finder opens nothing when no cheaper model passes", async () => {
    const { api, calls } = fakeGitHub();
    const breaksOnLuna: LlmClient = async (req) => ({ text: req.model.endsWith("gpt-6-luna") ? "no json" : '{"ok": true}', toolCalls: [], inputTokens: 10, outputTokens: 5, latencyMs: 1, refused: false });
    const { lines } = await runWithPr(api, { client: breaksOnLuna, inputs: { "find-savings": "true", "new-model": "", candidates: "openai:gpt-6-luna" } });
    expect(lines).toContain("AI Change Guard Money-Finder: no cheaper model passed");
    expect(writes(calls)).toEqual([]);
  });

  it("Money-Finder refuses another provider's candidate, or a new-model, before any paid call", async () => {
    const { api } = fakeGitHub();
    let calls = 0;
    const counting: LlmClient = async (req) => {
      calls++;
      return passing(req);
    };
    await expect(runWithPr(api, { client: counting, inputs: { "find-savings": "true", "new-model": "", candidates: "anthropic:claude-haiku-5-5" } })).rejects.toThrow(/within one provider/);
    await expect(runWithPr(api, { client: counting, inputs: { "find-savings": "true", candidates: "openai:gpt-6-luna" } })).rejects.toThrow(/remove "new-model"/);
    expect(calls).toBe(0);
  });

  it("checks the inputs before spending any calls", async () => {
    const { api } = fakeGitHub();
    await expect(runWithPr(api, { inputs: { prompts: "" } })).rejects.toThrow(/open-pr needs a replay/);
    let called = false;
    const client: LlmClient = async (req) => ((called = true), passing(req));
    await expect(runWithPr(api, { client, inputs: { "new-model": "anthropic:claude-sonnet-4-5" } })).rejects.toThrow(/within one provider/);
    await expect(runWithPr(api, { client, inputs: { "new-model": "openai:GPT-4o" } })).rejects.toThrow(/same/);
    await expect(runWithPr(api, { client, inputs: { "new-model": 'openai:gpt-5"x' } })).rejects.toThrow(/may only contain/);
    expect(called).toBe(false);
  });
});

describe("switchIds and branchName", () => {
  it("keeps the gateway route the replay tested", () => {
    expect(switchIds("openrouter:openai/gpt-4o", "openrouter:openai/gpt-6-luna")).toEqual({ from: "gpt-4o", to: "gpt-6-luna", prefix: "openai" });
    expect(switchIds("openai:gpt-4o", "openai:gpt-6-luna")).toEqual({ from: "gpt-4o", to: "gpt-6-luna" });
    expect(() => switchIds("openrouter:openai/gpt-4o", "openrouter:anthropic/claude-sonnet-4-5")).toThrow(/within one provider/);
  });

  it("treats Gemini's models/ prefix as the same route", () => {
    expect(switchIds("google:models/gemini-1.5-pro", "google:gemini-2.5-flash")).toEqual({ from: "gemini-1.5-pro", to: "gemini-2.5-flash" });
  });

  it("makes a safe branch name", () => {
    expect(branchName("gemini-2.0-flash", "Gemini 3.1@latest")).toBe("ai-change-guard/gemini-2.0-flash-to-gemini-3.1-latest");
  });
});
