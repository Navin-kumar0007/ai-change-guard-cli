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
  cleanCandidates,
  litellmConfig,
  openrouterConfig,
  plannedFallbackCalls,
  testFallbacks,
  loadGoldenSet,
  plannedCalls,
  runReplayJob,
} from "@ai-change-guard/replay";
import { buildReport, formatText, localToday } from "./report.js";
import { describeCost, formatUsd } from "./costs.js";
import { estimateImpact, usageFromLog, type ImpactSummary, type ModelUsage } from "./impact.js";
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
  ai-change-guard fallback --set golden.jsonl --model provider:model --candidates a,b,c [--format litellm|openrouter] [--out FILE]
  ai-change-guard cost [folder] --log ai-calls.jsonl [--sample 0.2] | --calls N --input-tokens N --output-tokens N [--model ID]

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

Fallback (tested backup models for an outage):
  --candidates LIST           provider:model,... to test against your --model on the golden set
  --format litellm|openrouter Config to write (default litellm); only candidates with nothing broken go in
  --runs N                    Runs per prompt (default 3)

Cost options (what announced price changes do to your monthly bill):
  --log FILE                  The recorder's ai-calls.jsonl: call volume and tokens per model, scaled to 30 days
  --sample SHARE              The recorder's sample setting, if not 1 (e.g. 0.2 when it kept 1 call in 5)
  --calls N                   Or give the volume yourself: calls per month ...
  --input-tokens N            ... average input tokens per call ...
  --output-tokens N           ... and average output tokens per call
  --model ID                  Which model --calls is for (needed when the folder uses more than one)
  --today YYYY-MM-DD          Count days from this date instead of today
  --json                      Print the estimate as JSON

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


type FlagKind = "value" | "int" | "bool";
type Flags = Record<string, string | number | true | undefined>;
/** Flags the baseline, watch and fallback commands share. */
const COMMON_FLAGS: Record<string, FlagKind> = { "--set": "value", "--runs": "int", "--max-calls": "int", "--concurrency": "int" };

function parseFlags(args: string[], extra: Record<string, FlagKind>): Flags {
  const spec = { ...COMMON_FLAGS, ...extra };
  const out: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const kind = spec[arg];
    if (!kind) throw new UsageError(`Unknown option: ${arg}`);
    if (kind === "bool") out[arg] = true;
    else {
      const v = takeValue(args, ++i, arg);
      out[arg] = kind === "int" ? positiveInt(v, arg) : v;
    }
  }
  return out;
}

const str = (flags: Flags, name: string) => flags[name] as string | undefined;
const int = (flags: Flags, name: string, fallback: number) => (flags[name] as number | undefined) ?? fallback;

function modelRefOrUsage(ref: string, flag: string): void {
  try {
    parseModelRef(ref);
  } catch (error) {
    throw new UsageError(`${flag}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function baselineCommand(args: string[]): Promise<number> {
  const f = parseFlags(args, { "--model": "value", "--out": "value" });
  const set = str(f, "--set");
  const model = str(f, "--model");
  const out = str(f, "--out");
  if (!set || !model || !out) throw new UsageError("baseline needs --set, --model and --out.");
  modelRefOrUsage(model, "--model");
  const runs = int(f, "--runs", 5);
  const items = await loadGoldenSet(resolve(set));
  console.error(`${items.length} prompts × ${runs} runs on ${model} = ${plannedCalls(items.length, runs, 1)} calls on your API key.`);
  const baseline = await createBaseline({ items, model, runs, maxCalls: int(f, "--max-calls", 500), concurrency: int(f, "--concurrency", 2), client: withRetry(createClient()) });
  await writeFile(resolve(out), JSON.stringify(baseline, null, 2) + "\n");
  const failed = baseline.records.filter((r) => !r.response).length;
  console.log(`Saved ${baseline.records.length - failed} answers for ${items.length} prompts to ${out}${failed ? ` (${failed} calls failed)` : ""}. Commit it next to the golden set.`);
  return 0;
}

async function watchCommand(args: string[]): Promise<number> {
  const f = parseFlags(args, { "--baseline": "value", "--slack-webhook-env": "value", "--json": "bool", "--markdown": "bool" });
  const set = str(f, "--set");
  const baselinePath = str(f, "--baseline");
  if (!set || !baselinePath) throw new UsageError("watch needs --set and --baseline.");
  const slackEnv = str(f, "--slack-webhook-env");
  const webhook = slackEnv ? process.env[slackEnv] : undefined;
  if (slackEnv && !webhook) throw new UsageError(`${slackEnv} is not set; put the Slack webhook URL in that environment variable.`);
  const baseline = parseBaseline(await readFile(resolve(baselinePath), "utf8"));
  const items = await loadGoldenSet(resolve(set));
  const runs = f["--runs"] as number | undefined;
  const watch = await runWatch({ items, baseline, maxCalls: int(f, "--max-calls", 500), concurrency: int(f, "--concurrency", 2), client: withRetry(createClient()), ...(runs ? { runs } : {}) });
  if (f["--json"]) console.log(JSON.stringify(watch, null, 2));
  else if (f["--markdown"]) console.log(formatWatchMarkdown(watch));
  else console.log(formatWatchText(watch));
  if (watch.alert && webhook) {
    await postSlack(webhook, slackMessage(watch)).then(
      () => console.error("Alert posted to Slack."),
      (error: unknown) => console.error(`Could not post to Slack: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
  return watch.alert ? 1 : 0;
}

async function fallbackCommand(args: string[]): Promise<number> {
  const f = parseFlags(args, { "--model": "value", "--candidates": "value", "--format": "value", "--out": "value" });
  const set = str(f, "--set");
  const model = str(f, "--model");
  if (!set || !model || !str(f, "--candidates")) throw new UsageError("fallback needs --set, --model and --candidates.");
  modelRefOrUsage(model, "--model");
  const candidates = cleanCandidates(model, str(f, "--candidates")!.split(","));
  if (candidates.length === 0) throw new UsageError("--candidates needs at least one model other than --model.");
  for (const c of candidates) modelRefOrUsage(c, "--candidates");
  const format = str(f, "--format") ?? "litellm";
  if (format !== "litellm" && format !== "openrouter") throw new UsageError("--format must be litellm or openrouter");
  const out = str(f, "--out");
  if (out && (await stat(resolve(out)).catch(() => null))) throw new UsageError(`${out} already exists; choose a new file name.`);
  const runs = int(f, "--runs", 3);
  if (runs === 1) console.error("With --runs 1 answer drift is not judged, so backups are ranked only by broken prompts and speed.");
  const items = await loadGoldenSet(resolve(set));
  console.error(`${plannedFallbackCalls(items.length, runs, candidates.length)} calls on your API keys (${model} once, then each of ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}).`);
  const result = await testFallbacks({ items, primary: model, candidates, client: withRetry(createClient()), runs, maxCalls: int(f, "--max-calls", 500), concurrency: int(f, "--concurrency", 2) });

  if (result.skippedPrompts.length) console.error(`${model} did not answer ${result.skippedPrompts.join(", ")}, so those prompts were not used to judge the backups.`);
  for (const c of result.candidates) {
    const t = c.report.totals;
    const latency = c.report.avgLatencyMs.new ? ` · ${(c.report.avgLatencyMs.new / 1000).toFixed(1)} s per call` : "";
    console.log(`${c.qualifies ? "PASSES   " : "LEFT OUT "} ${c.model}  ${t.same} same · ${t.changed} changed · ${t.broken} broken${latency}${c.reason ? `  (${c.reason})` : ""}`);
  }
  if (result.fallbacks.length === 0) {
    console.log("\nNo candidate passed without breaking a prompt, so no fallback config was written.");
    return 1;
  }
  let config: string;
  if (format === "litellm") {
    config = litellmConfig(model, result.fallbacks, `${items.length} prompts × ${runs} runs`);
  } else {
    let or: ReturnType<typeof openrouterConfig>;
    try {
      or = openrouterConfig(model, result.fallbacks);
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    config = JSON.stringify(or.body, null, 2) + "\n";
    if (or.unchecked.length) console.error(`Check these ids on openrouter.ai/models (OpenRouter sometimes names models differently): ${or.unchecked.join(", ")}`);
    if (or.skipped.length) console.error(`Left out (not on OpenRouter): ${or.skipped.join(", ")}`);
  }
  if (out) {
    await writeFile(resolve(out), config, { flag: "wx" });
    console.log(`\nWrote ${format} config with ${result.fallbacks.length} tested fallback${result.fallbacks.length === 1 ? "" : "s"} to ${out}.`);
  } else {
    console.log(`\n${config}`);
  }
  return 0;
}

function money(amount: number): string {
  return amount >= 100 ? `$${Math.round(amount).toLocaleString("en-US")}` : formatUsd(amount);
}

export function formatImpact(summary: ImpactSummary): string {
  const out: string[] = [];
  if (summary.days !== undefined) {
    const days = summary.days < 10 ? summary.days.toFixed(1) : String(Math.round(summary.days));
    out.push(`Monthly cost estimate from the log (${days} days scaled to 30${summary.sample !== 1 ? `, sample ${summary.sample}` : ""}), at list prices:`);
    if (summary.days < 7) out.push("A log of less than a week gives a rough estimate; record for longer for a better one.");
  } else {
    out.push("Monthly cost estimate from the volume you gave, at list prices:");
  }
  out.push("");
  for (const r of summary.rows) {
    const calls = Math.round(r.callsPerMonth).toLocaleString("en-US");
    const tokens = `${Math.round(r.avgInputTokens).toLocaleString("en-US")} input / ${Math.round(r.avgOutputTokens).toLocaleString("en-US")} output tokens per call`;
    out.push(`  ${r.model} (${r.platform}): about ${calls} calls a month · ${tokens}${r.monthlyNow !== undefined ? ` · about ${money(r.monthlyNow)} a month now` : ""}`);
    if (r.changes.length === 0) out.push("    No announced price change.");
    for (const c of r.changes) {
      out.push(`    ${describeCost(c.row)}`);
      if (c.delta !== undefined && c.monthlyAfter !== undefined) {
        const sign = c.delta >= 0 ? "+" : "-";
        const delta = `${sign}${money(Math.abs(c.delta))} a month`;
        out.push(c.inEffect ? `    => already applies: the "now" figure includes it (${delta} compared with before)` : `    => about ${money(c.monthlyAfter)} a month (${delta})`);
      } else if (!c.row.after) {
        out.push("    => impact unknown until the provider publishes the new price");
      }
    }
  }
  if (summary.rows.length === 0) out.push("  No calls to a model with a known list price.");
  if (summary.unpriced.length) out.push("", `No list price in the catalog for: ${summary.unpriced.join(", ")}.`);
  out.push("", "Estimates use list prices (no batch, cache or volume discounts) and today's tokens per call.");
  return out.join("\n");
}

async function costCommand(args: string[]): Promise<number> {
  // The folder, when given, comes first: cost ./my-app --log ai-calls.jsonl
  const folder = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
  const f = parseFlags(folder ? args.slice(1) : args, {
    "--log": "value",
    "--sample": "value",
    "--calls": "int",
    "--input-tokens": "value",
    "--output-tokens": "value",
    "--model": "value",
    "--today": "value",
    "--json": "bool",
  });
  const today = str(f, "--today") ?? localToday();
  if (!DATE_RE.test(today)) throw new UsageError("--today must look like 2026-11-17");
  const log = str(f, "--log");
  const calls = f["--calls"] as number | undefined;
  if (!log && calls === undefined) throw new UsageError("cost needs --log ai-calls.jsonl, or --calls with --input-tokens and --output-tokens.");
  if (log && calls !== undefined) throw new UsageError("Use either --log or --calls, not both.");
  const sampleText = str(f, "--sample");
  const sample = sampleText === undefined ? 1 : Number(sampleText);
  if (!(sample > 0 && sample <= 1)) throw new UsageError("--sample must be a number above 0 and at most 1, e.g. 0.2");

  const report = folder ? buildReport(await scanDirectory(resolve(folder)), folder, today) : undefined;
  const platformFor = (model: string) => report?.models.find((m) => m.id === model)?.platform;

  let usage: ModelUsage[];
  let summary: ImpactSummary;
  if (log) {
    usage = usageFromLog(await readFile(resolve(log), "utf8"));
    if (usage.length === 0) throw new UsageError(`${log} has no recorded AI calls (expected the recorder's ai-calls.jsonl).`);
    summary = estimateImpact(usage, { today, sample, platformFor });
  } else {
    const input = Number(str(f, "--input-tokens"));
    const output = Number(str(f, "--output-tokens"));
    if (!(input >= 0) || !(output >= 0) || str(f, "--input-tokens") === undefined || str(f, "--output-tokens") === undefined) {
      throw new UsageError("--calls needs --input-tokens and --output-tokens (average per call).");
    }
    let model = str(f, "--model");
    if (!model) {
      const ids = [...new Set(report?.models.map((m) => m.id) ?? [])];
      if (ids.length !== 1) throw new UsageError(report ? `The folder uses ${ids.length} models; say which with --model.` : "Give --model, or a folder that uses one model.");
      model = ids[0]!;
    }
    const platforms = report?.models.filter((m) => m.id === model).map((m) => m.platform) ?? [];
    const one: ModelUsage = { model, calls: calls!, callsWithTokens: 1, inputTokens: input, outputTokens: output };
    if (platforms[0]) one.platform = platforms[0];
    usage = [one];
    summary = estimateImpact(usage, { today, perMonth: true, platformFor });
  }
  console.log(f["--json"] ? JSON.stringify(summary, null, 2) : formatImpact(summary));
  return 0;
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
  if (command === "fallback") return fallbackCommand(rest);
  if (command === "cost") return costCommand(rest);
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
