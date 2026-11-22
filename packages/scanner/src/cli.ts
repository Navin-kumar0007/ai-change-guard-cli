#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createClient, parseModelRef, withRetry } from "@ai-change-guard/llm";
import {
  applyRepair,
  buildReplayReport,
  formatRepairMarkdown,
  formatRepairText,
  formatReplayMarkdown,
  formatReplayText,
  goldenLine,
  loadGoldenSet,
  plannedCalls,
  plannedRepairCalls,
  repairable,
  runRepair,
  runReplay,
  type RepairReport,
} from "@ai-change-guard/replay";
import { buildReport, formatText, localToday } from "./report.js";
import { scanDirectory } from "./scan.js";
import { applySwitch, planSwitch } from "./switch.js";

const run = promisify(execFile);
const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const USAGE = `Usage:
  ai-change-guard scan <folder | https://github.com/owner/repo> [options]
  ai-change-guard replay --set prompts.jsonl --old provider:model --new provider:model [options]
  ai-change-guard switch <folder> --from <model-id> --to <model-id> [--write]

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
    console.error(`${items.length} prompts × ${runs} runs × 2 models = ${total} calls on your API keys.`);
    if (repair) console.error(`--repair may use the rest of --max-calls (${maxCalls - total} calls) on prompts whose JSON format breaks.`);
    if (items.length < 20) console.error("Tip: 20–50 real prompts give a far more reliable result.");
  }

  const client = withRetry(createClient());
  const records = await runReplay({
    items,
    oldModel,
    newModel,
    runs,
    concurrency,
    maxCalls,
    client,
    onProgress: format === "text" && process.stderr.isTTY ? (done, all) => process.stderr.write(`\rRunning ${done}/${all} calls`) : undefined,
  });
  if (format === "text" && process.stderr.isTTY) process.stderr.write("\n");

  const report = buildReplayReport(items, records, { oldModel, newModel, runs });
  let repaired: RepairReport | undefined;
  if (repair && report.items.some(repairable)) {
    const left = maxCalls - records.length;
    const needed = plannedRepairCalls(items, report.items, newModel, runs);
    if (needed > left) {
      console.error(`Prompt Repair skipped: it could need ${needed} calls, and only ${left} are left under --max-calls ${maxCalls}.`);
    } else {
      if (format === "text") console.error("Trying Prompt Repair on the prompts whose answer format broke...");
      repaired = await runRepair({ items, records, results: report.items, newModel, client, runs, concurrency, maxCalls: left });
    }
  }
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
