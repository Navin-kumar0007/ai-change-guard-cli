// OpenAI Evals export. OpenAI made Evals read-only on 31 Oct 2026 and shuts it down on 30 Nov 2026, with no
// export button; the API still lists evals, runs and each run's output items until then. This saves all of it
// (graders, run settings, every recorded call and the dataset files) so nothing is lost, and the output items
// can then be imported as a golden set to keep testing model switches with replay.
import { copyFile, mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface EvalsExportOptions {
  apiKey: string;
  /** Folder to write into (created; one subfolder per eval). */
  outDir: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Told about each eval and run as it is saved. */
  onProgress?: (message: string) => void;
  /** Per request, body included (default 60 s). */
  timeoutMs?: number;
  /** Waits between retries; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface EvalsExportResult {
  evals: number;
  runs: number;
  items: number;
  datasetFiles: number;
  /** Every <run>.items.jsonl written, with the run it belongs to: the input for a golden set. */
  itemFiles: { file: string; run: Record<string, unknown> }[];
  /** Things that could not be saved, with the reason (the rest is still saved). */
  problems: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A file-name-safe version of an OpenAI ID. */
export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 100) || "unnamed";
}

/** `fatal`: nothing more can be saved (the key is refused), so the export stops. */
export class EvalsExportError extends Error {
  constructor(
    message: string,
    readonly fatal = false,
  ) {
    super(message);
  }
}

/** The dataset files a run read from: data_source.source of type "file_id". */
export function runFileIds(run: Obj): string[] {
  const ds = isObj(run.data_source) ? run.data_source : {};
  const source = isObj(ds.source) ? ds.source : {};
  return source.type === "file_id" && typeof source.id === "string" ? [source.id] : [];
}

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const ATTEMPTS = 6;

export async function exportOpenAiEvals(options: EvalsExportOptions): Promise<EvalsExportResult> {
  const base = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const say = options.onProgress ?? (() => undefined);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? 60_000;
  const headers = { Authorization: `Bearer ${options.apiKey}` };

  /**
   * One request, retried on rate limits, server errors, timeouts and dropped connections (honouring
   * Retry-After), then read by `read` under the same timeout. A refused key is fatal everywhere.
   */
  async function request<T>(path: string, read: (res: Response) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 401) throw new EvalsExportError("OpenAI refused the API key (401). Use a key from the organization and project that owns the evals.", true);
        if (RETRY_STATUS.has(res.status) && attempt < ATTEMPTS) {
          const after = Number(res.headers.get("retry-after"));
          await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** (attempt - 1));
          continue;
        }
        if (!res.ok) throw new EvalsExportError(`OpenAI answered ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
        return await read(res);
      } catch (error) {
        if (error instanceof EvalsExportError) throw error;
        // Network error or timeout: try again, then give up on this request only.
        if (attempt >= ATTEMPTS) throw new EvalsExportError(`No answer from OpenAI on ${path} after ${ATTEMPTS} tries: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }

  /** Every page of a list endpoint, 100 at a time (following last_id), handed over page by page. */
  async function eachPage(path: string, onPage: (data: Obj[]) => Promise<void>): Promise<void> {
    let after: string | undefined;
    for (let page = 0; page < 100_000; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const body = await request(`${path}${sep}limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`, (r) => r.json() as Promise<Obj>);
      const data = Array.isArray(body.data) ? body.data.filter(isObj) : [];
      await onPage(data);
      const last = typeof body.last_id === "string" ? body.last_id : (data.at(-1)?.id as string | undefined);
      if (body.has_more !== true || !last || last === after) return;
      after = last;
    }
  }
  const listAll = async (path: string) => {
    const all: Obj[] = [];
    await eachPage(path, async (data) => void all.push(...data));
    return all;
  };
  const why = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const fatal = (error: unknown) => error instanceof EvalsExportError && error.fatal;

  const result: EvalsExportResult = { evals: 0, runs: 0, items: 0, datasetFiles: 0, itemFiles: [], problems: [] };
  await mkdir(options.outDir, { recursive: true });
  let evals: Obj[];
  try {
    evals = await listAll("/evals");
  } catch (error) {
    // Without the list there is nothing to save: say why plainly.
    if (error instanceof EvalsExportError && /answered 403/.test(error.message)) {
      throw new EvalsExportError("This API key may not read evals (403). Give it read access to Evals, or use an owner's key.", true);
    }
    throw error;
  }
  await writeFile(join(options.outDir, "evals.json"), `${JSON.stringify(evals, null, 2)}\n`);
  /** Where each dataset file was first saved, so another eval's folder gets a copy without downloading it again. */
  const savedFiles = new Map<string, string>();

  for (const ev of evals) {
    const evalId = String(ev.id ?? "");
    if (!evalId) continue;
    const dir = join(options.outDir, safeId(evalId));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "eval.json"), `${JSON.stringify(ev, null, 2)}\n`);
    result.evals++;
    say(`${evalId}${typeof ev.name === "string" ? ` (${ev.name})` : ""}`);

    let runs: Obj[];
    try {
      runs = await listAll(`/evals/${encodeURIComponent(evalId)}/runs`);
    } catch (error) {
      if (fatal(error)) throw error;
      // runs.json is left as it was, so a retry never replaces a good earlier copy with nothing.
      result.problems.push(`${evalId}: runs not listed (${why(error)})`);
      continue;
    }
    await writeFile(join(dir, "runs.json"), `${JSON.stringify(runs, null, 2)}\n`);

    for (const run of runs) {
      const runId = String(run.id ?? "");
      if (!runId) continue;
      result.runs++;
      // Pages go to disk as they arrive: a later failure keeps what was already saved.
      const file = join(dir, `${safeId(runId)}.items.jsonl`);
      const handle = await open(file, "w");
      let count = 0;
      try {
        await eachPage(`/evals/${encodeURIComponent(evalId)}/runs/${encodeURIComponent(runId)}/output_items`, async (data) => {
          if (data.length) await handle.write(data.map((i) => `${JSON.stringify(i)}\n`).join(""));
          count += data.length;
        });
        say(`  ${runId}: ${count} output item${count === 1 ? "" : "s"}`);
      } catch (error) {
        if (fatal(error)) throw error;
        result.problems.push(`${evalId}/${runId}: output items ${count ? `partly saved (${count}; the rest failed: ${why(error)})` : `not saved (${why(error)})`}`);
      } finally {
        await handle.close();
      }
      result.items += count;
      if (count > 0) result.itemFiles.push({ file, run });

      // The dataset the run read, when it came from an uploaded file: the original rows and expected answers.
      for (const fileId of runFileIds(run)) {
        const target = join(dir, "files", `${safeId(fileId)}.jsonl`);
        const saved = savedFiles.get(fileId);
        if (saved === target) continue;
        try {
          await mkdir(join(dir, "files"), { recursive: true });
          if (saved) await copyFile(saved, target);
          else {
            const bytes = await request(`/files/${encodeURIComponent(fileId)}/content`, async (r) => Buffer.from(await r.arrayBuffer()));
            await writeFile(target, bytes);
            savedFiles.set(fileId, target);
            result.datasetFiles++;
          }
        } catch (error) {
          if (fatal(error)) throw error;
          result.problems.push(`${evalId}: dataset file ${fileId} not saved (${why(error)})`);
        }
      }
    }
  }
  return result;
}

/** The settings a run sent with every call (response format, tools, limits), for the golden set. */
export function runSamplingParams(run: Record<string, unknown>): Record<string, unknown> | undefined {
  const ds = isObj(run.data_source) ? run.data_source : {};
  return isObj(ds.sampling_params) ? ds.sampling_params : undefined;
}
