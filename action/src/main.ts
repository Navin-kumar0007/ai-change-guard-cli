import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient, withRetry, type LlmClient } from "@ai-change-guard/llm";
import { buildReplayReport, formatReplayMarkdown, loadGoldenSet, runReplay } from "@ai-change-guard/replay";
import { buildCheck, buildReport, scanDirectory, type Report } from "@ai-change-guard/scanner";

const SOON_DAYS = 90;

export type Env = Record<string, string | undefined>;

export function input(name: string, env: Env): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

function positive(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Input "${name}" must be a whole number of 1 or more.`);
  return n;
}

function oneOf(value: string, name: string, allowed: string[]): string {
  if (!allowed.includes(value)) throw new Error(`Input "${name}" must be one of: ${allowed.join(", ")}.`);
  return value;
}

export function scanFails(report: Report, failOn: string): boolean {
  if (failOn === "none") return false;
  const retired = report.models.some((m) => m.status === "retired" || m.status === "rerouted") || report.apis.some((a) => a.daysLeft <= 0);
  if (failOn === "retired") return retired;
  const soon =
    report.models.some((m) => (m.status === "retiring" || m.status === "rerouting") && (m.daysLeft ?? Infinity) <= SOON_DAYS) ||
    report.apis.some((a) => a.daysLeft > 0 && a.daysLeft <= SOON_DAYS);
  return retired || soon;
}

export interface RunDeps {
  env: Env;
  today: string;
  log: (line: string) => void;
  client?: LlmClient;
}

/** Runs the Action and returns the process exit code. */
export async function run({ env, today, log, client }: RunDeps): Promise<number> {
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const summary = async (markdown: string) => {
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`);
    else log(markdown);
  };

  const failOn = oneOf(input("fail-on", env) || "retired", "fail-on", ["retired", "retiring", "none"]);
  const report = buildReport(await scanDirectory(resolve(workspace, input("path", env) || ".")), env.GITHUB_REPOSITORY ?? workspace, today);
  const check = buildCheck(report, null);
  await summary(`## AI Change Guard: ${check.title}\n\n${check.summary}`);
  let failed = scanFails(report, failOn);
  log(failed ? `::error::AI Change Guard: ${check.title}` : `AI Change Guard: ${check.title}`);

  const prompts = input("prompts", env);
  const oldModel = input("old-model", env);
  const newModel = input("new-model", env);
  if (prompts || oldModel || newModel) {
    if (!prompts || !oldModel || !newModel) throw new Error('A replay needs all three inputs: "prompts", "old-model" and "new-model".');
    const replayFailOn = oneOf(input("replay-fail-on", env) || "broken", "replay-fail-on", ["broken", "changed", "none"]);
    const runs = positive(input("runs", env) || "3", "runs");
    const items = await loadGoldenSet(resolve(workspace, prompts));
    const records = await runReplay({
      items,
      oldModel,
      newModel,
      runs,
      concurrency: positive(input("concurrency", env) || "2", "concurrency"),
      maxCalls: positive(input("max-calls", env) || "300", "max-calls"),
      client: client ?? withRetry(createClient({ env })),
    });
    const replay = buildReplayReport(items, records, { oldModel, newModel, runs });
    await summary(formatReplayMarkdown(replay));
    const { broken, changed } = replay.totals;
    const replayFailed = (replayFailOn === "broken" && broken > 0) || (replayFailOn === "changed" && broken + changed > 0);
    log(`${replayFailed ? "::error::" : ""}AI Change Guard replay: ${replay.totals.same} same, ${changed} changed, ${broken} broken`);
    failed = failed || replayFailed;
  }
  return failed ? 1 : 0;
}

if (process.env.GITHUB_ACTIONS === "true") {
  run({ env: process.env, today: new Date().toISOString().slice(0, 10), log: (line) => console.log(line) }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
