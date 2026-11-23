#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createClient, parseModelRef, withRetry } from "@ai-change-guard/llm";
import {
  applyRepair,
  createBaseline,
  formatWatchMarkdown,
  formatWatchText,
  parseBaseline,
  postSlack,
  runWatch,
  slackMessage,
  formatRepairMarkdown,
  formatRepairText,
  formatReplayMarkdown,
  formatReplayText,
  generateStarterSet,
  goldenLine,
  importPrompts,
  loadGoldenSet,
  plannedCalls,
  runReplayJob,
} from "@ai-change-guard/replay";
import { buildReport, formatText, localToday } from "./report.js";
import { findPrompts } from "./prompts.js";
import { scanDirectory } from "./scan.js";
import { applySwitch, planSwitch } from "./switch.js";

const run = promisify(execFile);
const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const USAGE = `Usage:
  ai-change-guard scan <folder | https://github.com/owner/repo> [options]
  ai-change-guard replay --set prompts.jsonl --old provider:model --new provider:model [options]
  ai-change-guard switch <folder> --from <model-id> --to <model-id> [--write]
  ai-change-guard import <log-file> --out golden.jsonl [--model <model-id>] [--limit N]
  ai-change-guard starter <folder> --model provider:model --out golden.jsonl [--count N]
  ai-change-guard baseline --set golden.jsonl --model provider:model --out golden.baseline.json [--runs N]
  ai-change-guard watch --set golden.jsonl --baseline golden.baseline.json [--runs N] [--slack-webhook-env NAME]

Scan options:
  --json                      Print the report as JSON
  --today YYYY-MM-DD          Count days from this date instead of today
  --fail-on retired|retiring  Exit with code 1 if any model is retired (or retiring)

Replay options:
  --runs N                    Runs per prompt on each model (default 5)
  --concurrency N             Calls in flight at once (default 5)
  --max-calls N               Refuse to start above this many calls (default 500)
  --json | --markdown         Report format (default: text)
  --fail-on broken|changed    Exit with code 1 if any prompt is broken (or changed)
  --repair                    When an answer format breaks, try fixes on the new model and report the one that works
  --repaired-set FILE         With --repair, write a new golden set with the working fixes applied
                              (prompts only: comments and extra fields are not copied)

Import options (turns logged AI calls into a golden set; JSON or JSONL from Langfuse,
Helicone, OpenTelemetry, or raw OpenAI / Anthropic / Gemini request logs):
  --out FILE                  Golden set to write (a new file)
  --model ID                  Keep only calls to this model
  --limit N                   Keep at most N prompts, spread over the log (default 50)

Starter options (no logs yet: finds the system prompts in your code and has a model write
realistic user messages for each; one call per prompt, on your own key):
  --model provider:model      Model that writes the messages
  --out FILE                  Golden set to write (a new file)
  --count N                   Messages per system prompt (default 8)
  --max-prompts N             Use at most N system prompts (default 5)

Baseline and watch (is the model you use still answering the same way?):
  baseline                    Runs each prompt --runs times (default 5) and saves the answers; commit the file
  watch                       Asks the same model again and compares with the baseline: exit code 1 when
                              3 of 5 answers changed or broke, or the provider served another model
  --slack-webhook-env NAME    Post an alert to the Slack incoming webhook in this environment variable
  --max-calls N               Refuse to start above this many calls (default 500)
  --concurrency N             Calls in flight at once (default 2; use 1 on free-tier keys)

Switch options:
  --write                     Change the files (without it, only shows what would change)
  Run a replay first: switch changes model IDs, it does not prove the new model works.

Models look like openai:gpt-4o, anthropic:claude-sonnet-4-5, google:gemini-2.5-flash,
groq:<model>, openrouter:<model>, mistral:<model> or ollama:<model>. API keys are read
from OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY
and MISTRAL_API_KEY. Calls run on your own keys.`;

function positiveInt(value: string | undefined, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a whole number of 1 or more`);
  return n;
}

async function replayCommand(args: string[]): Promise<number> {
  let set: string | undefined;
  let oldModel: string | undefined;
  let newModel: string | undefined;
  let runs = 5;
  let concurrency = 5;
  let maxCalls = 500;
  let format: "text" | "json" | "markdown" = "text";
  let failOn: "broken" | "changed" | undefined;
  let repair = false;
  let repairedSet: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--set") set = args[++i];
    else if (arg === "--old") oldModel = args[++i];
    else if (arg === "--new") newModel = args[++i];
    else if (arg === "--runs") runs = positiveInt(args[++i], "--runs");
    else if (arg === "--concurrency") concurrency = positiveInt(args[++i], "--concurrency");
    else if (arg === "--max-calls") maxCalls = positiveInt(args[++i], "--max-calls");
    else if (arg === "--json") format = "json";
    else if (arg === "--markdown") format = "markdown";
    else if (arg === "--repair") repair = true;
    else if (arg === "--repaired-set") {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new UsageError("--repaired-set needs a file name.");
      repairedSet = value;
    }
    else if (arg === "--fail-on") {
      const value = args[++i];
      if (value !== "broken" && value !== "changed") throw new UsageError("--fail-on must be broken or changed");
      failOn = value;
    } else throw new UsageError(`Unknown option: ${arg}`);
  }
  if (!set || !oldModel || !newModel) throw new UsageError("replay needs --set, --old and --new.");
  if (repairedSet !== undefined && !repair) throw new UsageError("--repaired-set needs --repair.");
  // The rewritten set keeps prompts, not comments or extra fields, so never overwrite the original.
  if (repairedSet !== undefined && resolve(repairedSet) === resolve(set)) throw new UsageError("--repaired-set must be a new file, not the golden set itself.");
  parseModelRef(oldModel);
  parseModelRef(newModel);

  const items = await loadGoldenSet(resolve(set));
  const total = plannedCalls(items.length, runs);
  if (format === "text") {
    console.error(`${items.length} prompt${items.length === 1 ? "" : "s"} × ${runs} run${runs === 1 ? "" : "s"} × 2 models = ${total} calls on your API keys.`);
    if (runs === 1) console.error("With --runs 1 answer drift is not judged; use 2 or more runs to catch reworded answers.");
    if (repair) console.error(`--repair may use the rest of --max-calls (${maxCalls - total} calls) on prompts whose JSON format breaks.`);
    if (items.length < 20) console.error("Tip: 20–50 real prompts give a far more reliable result.");
  }

  const job = await runReplayJob({
    items,
    oldModel,
    newModel,
    runs,
    concurrency,
    maxCalls,
    client: withRetry(createClient()),
    repair,
    ...(format === "text" && process.stderr.isTTY ? { onProgress: (done: number, all: number) => process.stderr.write(`\rRunning ${done}/${all} calls`) } : {}),
  });
  if (format === "text" && process.stderr.isTTY) process.stderr.write("\n");
  const { report } = job;
  const repaired = job.repair;
  if (job.repairSkipped) console.error(job.repairSkipped);
  if (format === "json") console.log(JSON.stringify(repaired ? { ...report, repair: repaired } : report, null, 2));
  else if (format === "markdown") console.log([formatReplayMarkdown(report), repaired ? formatRepairMarkdown(repaired) : ""].filter(Boolean).join("\n\n"));
  else console.log([formatReplayText(report), repaired ? formatRepairText(repaired) : ""].filter(Boolean).join("\n\n"));

  if (repairedSet) {
    const patches = new Map((repaired?.results ?? []).flatMap((r) => (r.patch ? [[r.id, r.patch] as const] : [])));
    await writeFile(resolve(repairedSet), items.map((item) => goldenLine(patches.has(item.id) ? applyRepair(item, patches.get(item.id)!) : item)).join("\n") + "\n");
    if (format === "text") console.error(`Wrote ${items.length} prompts (${patches.size} repaired) to ${repairedSet}.`);
  }

  if (failOn === "broken" && report.totals.broken > 0) return 1;
  if (failOn === "changed" && report.totals.broken + report.totals.changed > 0) return 1;
  return 0;
}

async function switchCommand(args: string[]): Promise<number> {
  let folder: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let write = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--from") from = args[++i];
    else if (arg === "--to") to = args[++i];
    else if (arg === "--write") write = true;
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option: ${arg}`);
    else if (!folder) folder = arg;
    else throw new UsageError(`Unexpected argument: ${arg}`);
  }
  if (!folder || !from || !to) throw new UsageError("switch needs a folder, --from and --to.");

  const root = resolve(folder);
  const plan = await planSwitch(root, (await scanDirectory(root)).findings, from, to);
  if (plan.edits.length === 0 && plan.skipped.length === 0) {
    console.log(`No uses of ${plan.from} found in ${folder}.`);
    return 0;
  }
  for (const e of plan.edits) console.log(`${e.file}:${e.line}\n  - ${e.before}\n  + ${e.after}`);
  for (const s of plan.skipped) console.log(`${s.file}:${s.line}  not changed (${s.raw}): ${s.reason}`);
  const files = plan.files.size === 1 ? "1 file" : `${plan.files.size} files`;
  if (write) {
    await applySwitch(root, plan);
    console.log(`\nChanged ${plan.edits.length} line(s) in ${files}.`);
  } else {
    console.log(`\n${plan.edits.length} line(s) in ${files} would change. Add --write to change them.`);
  }
  return 0;
}

function takeValue(args: string[], i: number, flag: string): string {
  const v = args[i];
  if (!v || v.startsWith("-")) throw new UsageError(`${flag} needs a value.`);
  return v;
}

async function importCommand(args: string[]): Promise<number> {
  let file: string | undefined;
  let out: string | undefined;
  let model: string | undefined;
  let limit = 50;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--out") out = args[++i];
    else if (arg === "--model") {
      model = args[++i];
      if (!model || model.startsWith("-")) throw new UsageError("--model needs a model ID.");
    } else if (arg === "--limit") limit = positiveInt(args[++i], "--limit");
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option: ${arg}`);
    else if (!file) file = arg;
    else throw new UsageError(`Unexpected argument: ${arg}`);
  }
  if (!file || !out || out.startsWith("-")) throw new UsageError("import needs a log file and --out.");
  if (await stat(resolve(out)).catch(() => null)) throw new UsageError(`${out} already exists; choose a new file name.`);

  const result = importPrompts(await readFile(resolve(file), "utf8"), { limit, ...(model ? { model } : {}) });
  console.log(`Read ${result.records} records from ${file}; found ${result.found} distinct prompts.`);
  const models = Object.entries(result.models).sort((a, b) => b[1] - a[1]);
  if (models.length) console.log(`Models: ${models.map(([m, n]) => `${m} (${n})`).join(", ")}`);
  for (const [reason, n] of Object.entries(result.skipped).sort((a, b) => b[1] - a[1])) console.log(`  skipped ${n}: ${reason}`);
  if (result.unknownModel > 0) console.log(`  kept ${result.unknownModel} whose log names no model (raw Gemini requests carry it in the URL); check they belong to ${model}.`);
  if (result.items.length === 0) {
    console.log("No prompts to write. The importer reads OpenAI, Anthropic and Gemini request bodies and OpenTelemetry GenAI spans.");
    return 1;
  }
  try {
    // wx: fail instead of overwriting a file that appeared since the check above.
    await writeFile(resolve(out), result.items.map(goldenLine).join("\n") + "\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new UsageError(`${out} already exists; choose a new file name.`);
    throw error;
  }
  const checks = result.items.filter((i) => i.expect).length;
  console.log(`Wrote ${result.items.length} prompts to ${out} (${checks} with checks taken from the logged answers).`);
  console.log("These are real messages from your logs: read the file and remove anything private before you commit it.");
  return 0;
}

async function starterCommand(args: string[]): Promise<number> {
  let folder: string | undefined;
  let out: string | undefined;
  let model: string | undefined;
  let count = 8;
  let maxPrompts = 5;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = () => takeValue(args, ++i, arg);
    if (arg === "--out") out = value();
    else if (arg === "--model") model = value();
    else if (arg === "--count") count = positiveInt(value(), "--count");
    else if (arg === "--max-prompts") maxPrompts = positiveInt(value(), "--max-prompts");
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option: ${arg}`);
    else if (!folder) folder = arg;
    else throw new UsageError(`Unexpected argument: ${arg}`);
  }
  if (!folder || !out || !model) throw new UsageError("starter needs a folder, --model and --out.");
  parseModelRef(model);
  if (await stat(resolve(out)).catch(() => null)) throw new UsageError(`${out} already exists; choose a new file name.`);

  const found = await findPrompts(resolve(folder));
  if (found.length === 0) {
    console.log("No system prompts found in the code. Record real calls instead (packages/recorder) and use `import`, or write prompts by hand.");
    return 1;
  }
  const used = found.slice(0, maxPrompts);
  console.log(`Found ${found.length} system prompt${found.length === 1 ? "" : "s"}${found.length > used.length ? `; using the first ${used.length}` : ""}:`);
  for (const p of used) {
    console.log(`  ${p.file}:${p.line}  ${p.name}: ${p.text.replace(/\s+/g, " ").slice(0, 70)}${p.text.length > 70 ? "…" : ""}`);
    if (p.templated) console.log("    has placeholders such as {name}: fill them with real values in the golden set before a replay");
    if (p.partial) console.log("    is joined with a variable in the code: only its fixed text is used, so check it in the golden set");
  }
  console.error(`${used.length} call${used.length === 1 ? "" : "s"} to ${model} on your API key.`);

  // Ids must be unique: src/bot.py and src-bot.py would otherwise both become src-bot.py-4.
  const ids = new Set<string>();
  const sources = used.map((p) => {
    const base = `${p.file}-${p.line}`.replace(/[^A-Za-z0-9._-]+/g, "-");
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    return { id, system: p.text, json: p.json };
  });
  const result = await generateStarterSet({ sources, model, client: withRetry(createClient()), count });
  for (const f of result.failures) console.error(`  could not generate for ${f.id}: ${f.error}`);
  if (result.items.length === 0) {
    console.error(`Nothing written: every call to ${model} failed (see above).`);
    return 1;
  }
  try {
    await writeFile(resolve(out), result.items.map(goldenLine).join("\n") + "\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new UsageError(`${out} already exists; choose a new file name.`);
    throw error;
  }
  console.log(`Wrote ${result.items.length} generated prompts to ${out}.`);
  console.log("The user messages are made up by a model: read them, keep the realistic ones, and replace the set with real calls (recorder + import) when you can.");
  return 0;
}


async function baselineCommand(args: string[]): Promise<number> {
  let set: string | undefined;
  let model: string | undefined;
  let out: string | undefined;
  let runs = 5;
  let maxCalls = 500;
  let concurrency = 2;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--set") set = takeValue(args, ++i, arg);
    else if (arg === "--model") model = takeValue(args, ++i, arg);
    else if (arg === "--out") out = takeValue(args, ++i, arg);
    else if (arg === "--runs") runs = positiveInt(takeValue(args, ++i, arg), arg);
    else if (arg === "--max-calls") maxCalls = positiveInt(takeValue(args, ++i, arg), arg);
    else if (arg === "--concurrency") concurrency = positiveInt(takeValue(args, ++i, arg), arg);
    else throw new UsageError(`Unknown option: ${arg}`);
  }
  if (!set || !model || !out) throw new UsageError("baseline needs --set, --model and --out.");
  parseModelRef(model);
  const items = await loadGoldenSet(resolve(set));
  console.error(`${items.length} prompts × ${runs} runs on ${model} = ${plannedCalls(items.length, runs, 1)} calls on your API key.`);
  const baseline = await createBaseline({ items, model, runs, maxCalls, concurrency, client: withRetry(createClient()) });
  await writeFile(resolve(out), JSON.stringify(baseline, null, 2) + "\n");
  const failed = baseline.records.filter((r) => !r.response).length;
  console.log(`Saved ${baseline.records.length - failed} answers for ${items.length} prompts to ${out}${failed ? ` (${failed} calls failed)` : ""}. Commit it next to the golden set.`);
  return 0;
}

async function watchCommand(args: string[]): Promise<number> {
  let set: string | undefined;
  let baselinePath: string | undefined;
  let runs: number | undefined;
  let maxCalls = 500;
  let slackEnv: string | undefined;
  let concurrency = 2;
  let format: "text" | "markdown" | "json" = "text";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--set") set = takeValue(args, ++i, arg);
    else if (arg === "--baseline") baselinePath = takeValue(args, ++i, arg);
    else if (arg === "--runs") runs = positiveInt(takeValue(args, ++i, arg), arg);
    else if (arg === "--max-calls") maxCalls = positiveInt(takeValue(args, ++i, arg), arg);
    else if (arg === "--concurrency") concurrency = positiveInt(takeValue(args, ++i, arg), arg);
    else if (arg === "--slack-webhook-env") slackEnv = takeValue(args, ++i, arg);
    else if (arg === "--json") format = "json";
    else if (arg === "--markdown") format = "markdown";
    else throw new UsageError(`Unknown option: ${arg}`);
  }
  if (!set || !baselinePath) throw new UsageError("watch needs --set and --baseline.");
  const webhook = slackEnv ? process.env[slackEnv] : undefined;
  if (slackEnv && !webhook) throw new UsageError(`${slackEnv} is not set; put the Slack webhook URL in that environment variable.`);
  const baseline = parseBaseline(await readFile(resolve(baselinePath), "utf8"));
  const items = await loadGoldenSet(resolve(set));
  const watch = await runWatch({ items, baseline, maxCalls, concurrency, client: withRetry(createClient()), ...(runs ? { runs } : {}) });
  if (format === "json") console.log(JSON.stringify(watch, null, 2));
  else if (format === "markdown") console.log(formatWatchMarkdown(watch));
  else console.log(formatWatchText(watch));
  if (watch.alert && webhook) {
    await postSlack(webhook, slackMessage(watch)).then(
      () => console.error("Alert posted to Slack."),
      (error: unknown) => console.error(`Could not post to Slack: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
  return watch.alert ? 1 : 0;
}

class UsageError extends Error {}

interface Options {
  target: string;
  json: boolean;
  today: string;
  failOn?: "retired" | "retiring";
}

function parseArgs(args: string[]): Options {
  let target: string | undefined;
  let json = false;
  let today = localToday();
  let failOn: Options["failOn"];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--today") today = args[++i] ?? "";
    else if (arg === "--fail-on") {
      const value = args[++i];
      if (value !== "retired" && value !== "retiring") throw new UsageError("--fail-on must be retired or retiring");
      failOn = value;
    } else if (arg.startsWith("-")) throw new UsageError(`Unknown option: ${arg}`);
    else if (!target) target = arg;
    else throw new UsageError(`Unexpected argument: ${arg}`);
  }

  if (!target) throw new UsageError("Give a folder or a GitHub link to scan.");
  if (!DATE_RE.test(today)) throw new UsageError("--today must look like 2026-11-17");
  const options: Options = { target, json, today };
  if (failOn) options.failOn = failOn;
  return options;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (command === "replay") return replayCommand(rest);
  if (command === "switch") return switchCommand(rest);
  if (command === "import") return importCommand(rest);
  if (command === "starter") return starterCommand(rest);
  if (command === "baseline") return baselineCommand(rest);
  if (command === "watch") return watchCommand(rest);
  if (command !== "scan") throw new UsageError(command ? `Unknown command: ${command}` : "Missing command.");

  const options = parseArgs(rest);
  let folder: string;
  let tempDir: string | undefined;

  if (GITHUB_URL_RE.test(options.target)) {
    tempDir = await mkdtemp(join(tmpdir(), "ai-change-guard-"));
    folder = join(tempDir, "repo");
    if (!options.json) console.error(`Downloading ${options.target} ...`);
    await run("git", ["clone", "--depth", "1", "--quiet", options.target, folder], { timeout: 120_000 });
  } else if (/^[a-z]+:\/\//i.test(options.target)) {
    throw new UsageError("Only https://github.com/owner/repo links are supported.");
  } else {
    folder = resolve(options.target);
  }

  try {
    const result = await scanDirectory(folder);
    const report = buildReport(result, options.target, options.today);
    console.log(options.json ? JSON.stringify(report, null, 2) : formatText(report));

    const retired = report.models.some((m) => m.status === "retired" || m.status === "rerouted");
    const changing = report.models.some((m) => m.status !== "no-known-retirement") || report.apis.length > 0;
    if (options.failOn === "retired" && retired) return 1;
    if (options.failOn === "retiring" && changing) return 1;
    return 0;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError) console.error(`${error.message}\n\n${USAGE}`);
    else console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);
