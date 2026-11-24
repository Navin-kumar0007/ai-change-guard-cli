import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importPrompts, importValues } from "../src/importer.js";
import { EvalsExportError, exportOpenAiEvals, safeId } from "../src/openai-evals.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const outDir = async () => {
  const d = await mkdtemp(join(tmpdir(), "acg-evals-"));
  dirs.push(d);
  return join(d, "export");
};

const SYSTEM = "Classify the ticket. Reply as JSON with keys topic and urgency.";
const item = (n: number, extra: Record<string, unknown> = {}) => ({
  object: "eval.run.output_item",
  id: `outputitem_${n}`,
  datasource_item_id: n,
  datasource_item: { ticket: `ticket ${n}` },
  results: [{ name: "json", passed: true, score: 1 }],
  sample: {
    input: [
      { role: "developer", content: SYSTEM, tool_calls: null },
      { role: "user", content: `ticket ${n}`, tool_calls: null },
    ],
    output: [{ role: "assistant", content: `{"topic": "billing", "urgency": "high"}` }],
    model: "gpt-4o-2024-08-06",
    max_completion_tokens: 200,
    temperature: 0,
    error: null,
  },
  ...extra,
});
const failed = (n: number) => item(n, { sample: { ...item(n).sample, error: { code: "rate_limit", message: "slow down" } } });

type Route = (u: URL) => Response;
const page = (data: unknown[], hasMore = false) => new Response(JSON.stringify({ object: "list", data, has_more: hasMore, last_id: (data.at(-1) as { id?: string })?.id }));

/** A fake OpenAI API: routes by path; anything not routed is a test failure. */
function fakeOpenAi(calls: string[], routes: Record<string, Route>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(`${u.pathname}${u.search}`);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(init?.signal).toBeInstanceOf(AbortSignal); // every request has a timeout
    const route = routes[u.pathname];
    if (!route) throw new Error(`unexpected ${u.pathname}`);
    return route(u);
  }) as typeof fetch;
}

const ONE_EVAL: Record<string, Route> = {
  "/v1/evals": () => page([{ id: "eval_1", name: "Ticket triage" }]),
  "/v1/evals/eval_1/runs": () => page([{ id: "run_a", data_source: { source: { type: "file_id", id: "file-1" } } }, { id: "run_b", data_source: { source: { type: "file_id", id: "file-1" } } }]),
  "/v1/evals/eval_1/runs/run_a/output_items": (u) => (u.searchParams.get("after") ? page([failed(3)]) : page([item(1), item(2)], true)),
  "/v1/evals/eval_1/runs/run_b/output_items": () => new Response("boom", { status: 500 }),
  "/v1/files/file-1/content": () => new Response('{"item": {"ticket": "ticket 1"}}\n'),
};

const run = (routes: Record<string, Route>, calls: string[] = [], waits: number[] = []) =>
  outDir().then((out) =>
    exportOpenAiEvals({ apiKey: "sk-test", outDir: out, fetch: fakeOpenAi(calls, routes), sleep: async (ms) => void waits.push(ms) }).then((r) => ({ r, out })),
  );

describe("OpenAI Evals export", () => {
  it("saves every eval, run, output item and dataset file, following pages, and keeps going past a failed run", async () => {
    const calls: string[] = [];
    const { r, out } = await run(ONE_EVAL, calls);
    expect(r).toMatchObject({ evals: 1, runs: 2, items: 3, datasetFiles: 1 });
    expect(r.problems).toEqual([expect.stringMatching(/^eval_1\/run_b: output items not saved \(OpenAI answered 500/)]);
    expect(calls).toContain("/v1/evals/eval_1/runs/run_a/output_items?limit=100&after=outputitem_2");
    expect(calls.filter((c) => c.startsWith("/v1/evals/eval_1/runs/run_b/"))).toHaveLength(6); // retried, then given up
    expect(calls.filter((c) => c.startsWith("/v1/files/"))).toHaveLength(1);
    expect((await readdir(join(out, "eval_1"))).sort()).toEqual(["eval.json", "files", "run_a.items.jsonl", "run_b.items.jsonl", "runs.json"]);
    expect((await readFile(join(out, "eval_1", "run_a.items.jsonl"), "utf8")).trim().split("\n")).toHaveLength(3);
    expect(r.itemFiles.map((f) => f.run.id)).toEqual(["run_a"]);
  });

  it("waits as OpenAI asks on a rate limit, and keeps the pages saved before a later failure", async () => {
    let tries = 0;
    const waits: number[] = [];
    const { r, out } = await run(
      {
        ...ONE_EVAL,
        "/v1/evals/eval_1/runs": () => page([{ id: "run_a" }]),
        "/v1/evals/eval_1/runs/run_a/output_items": (u) => {
          if (!u.searchParams.get("after")) return tries++ === 0 ? new Response("slow", { status: 429, headers: { "retry-after": "7" } }) : page([item(1), item(2)], true);
          return new Response("gone", { status: 404 });
        },
      },
      [],
      waits,
    );
    expect(waits[0]).toBe(7000);
    expect(r.items).toBe(2);
    expect(r.problems).toEqual([expect.stringMatching(/run_a: output items partly saved \(2; the rest failed: OpenAI answered 404/)]);
    expect((await readFile(join(out, "eval_1", "run_a.items.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("stops only when the key is refused; a dataset file it may not read is noted and skipped", async () => {
    await expect(run({ "/v1/evals": () => new Response("no", { status: 401 }) })).rejects.toThrow(EvalsExportError);
    await expect(run({ "/v1/evals": () => new Response("no", { status: 403 }) })).rejects.toThrow(/may not read evals \(403\)/);
    const { r } = await run({ ...ONE_EVAL, "/v1/files/file-1/content": () => new Response("upstream (403) says no", { status: 403 }) });
    expect(r.problems).toContainEqual(expect.stringMatching(/dataset file file-1 not saved \(OpenAI answered 403/));
    expect(r.items).toBe(3);
  });

  it("copies a dataset shared by two evals into both folders, and never replaces a good runs.json with nothing", async () => {
    const calls: string[] = [];
    const { out } = await run(
      {
        "/v1/evals": () => page([{ id: "eval_1" }, { id: "eval_2" }]),
        "/v1/evals/eval_1/runs": () => page([{ id: "run_a", data_source: { source: { type: "file_id", id: "file-1" } } }]),
        "/v1/evals/eval_2/runs": () => page([{ id: "run_c", data_source: { source: { type: "file_id", id: "file-1" } } }]),
        "/v1/evals/eval_1/runs/run_a/output_items": () => page([item(1)]),
        "/v1/evals/eval_2/runs/run_c/output_items": () => page([item(2)]),
        "/v1/files/file-1/content": () => new Response("rows\n"),
      },
      calls,
    );
    expect(await readFile(join(out, "eval_2", "files", "file-1.jsonl"), "utf8")).toBe("rows\n");
    expect(calls.filter((c) => c.startsWith("/v1/files/"))).toHaveLength(1);

    // A second export into the same folder, where listing eval_1's runs now fails.
    await mkdir(join(out, "eval_1"), { recursive: true });
    await writeFile(join(out, "eval_1", "runs.json"), '[{"id": "run_a"}]\n');
    const again = await exportOpenAiEvals({
      apiKey: "sk-test",
      outDir: out,
      sleep: async () => undefined,
      fetch: fakeOpenAi([], { "/v1/evals": () => page([{ id: "eval_1" }]), "/v1/evals/eval_1/runs": () => new Response("down", { status: 500 }) }),
    });
    expect(again.problems).toEqual([expect.stringMatching(/^eval_1: runs not listed/)]);
    expect(await readFile(join(out, "eval_1", "runs.json"), "utf8")).toBe('[{"id": "run_a"}]\n');
  });

  it("makes safe folder names", () => {
    expect(safeId("eval_68a/../x")).toBe("eval_68a_x");
    expect(safeId("")).toBe("unnamed");
  });
});

describe("importing recorded eval calls", () => {
  it("makes a golden set: system prompt, model settings, a JSON check; failed calls left out", () => {
    const r = importPrompts([item(1), item(2), failed(3)].map((i) => JSON.stringify(i)).join("\n"));
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toEqual({ id: "outputitem_1", system: SYSTEM, messages: [{ role: "user", content: "ticket 1" }], maxTokens: 200, temperature: 0, expect: { json: true } });
    expect(r.models).toEqual({ "gpt-4o-2024-08-06": 2 });
    expect(r.skipped).toEqual({ "the eval's call failed": 1 });
  });

  it("keeps the run's response format, so JSON mode and the schema are replayed too", () => {
    const schema = { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] };
    const sampling_params = { response_format: { type: "json_schema", json_schema: { name: "t", schema } } };
    const r = importValues([{ ...item(1), sampling_params }]);
    expect(r.items[0]).toMatchObject({ jsonMode: true, expect: { schema: { required: ["topic"] } } });
  });

  it("reads a trimmed item that has only sample.input as one call", () => {
    const { sample, id } = item(1);
    const r = importValues([{ id, sample, results: [{ name: "g", passed: true }] }]);
    expect(r.items).toHaveLength(1);
  });
});
